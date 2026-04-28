from __future__ import annotations
import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select

from ..database import SessionLocal
from ..models.tv import TV
from ..models.debloat import RemovalLog
from ..schemas_debloat import ScannedApp
from .ws_manager import ws_manager
from .tizenbrew_service import tizenbrew_service

log = logging.getLogger(__name__)

APP_DB_PATH = Path(__file__).parent.parent / "data" / "tizen_apps.json"

ABSOLUTE_NEVER_REMOVE: frozenset[str] = frozenset({
    "org.tizen.art-app",
    "com.samsung.tv.coba.art",
    "com.samsung.tv.ambient-support",
    "org.tizen.sso",
    "org.tizen.homescreen",
    "org.tizen.launcher",
    "org.tizen.lockscreen",
    "com.samsung.tv.tv-ambient-mode-controller",
})

# Matches "AppID:foo PackageID:bar Name:Baz"
_RE_KV = re.compile(
    r"(?:AppID|appid)\s*[:=]\s*(?P<appid>\S+)\s+(?:PackageID|pkgid)\s*[:=]\s*(?P<pkgid>\S+)"
    r"(?:\s+(?:Name|name)\s*[:=]\s*(?P<name>.+?))?\s*$",
    re.IGNORECASE,
)
# Matches "appID: foo, name: Bar"
_RE_LAUNCHER = re.compile(
    r"app[Ii]d\s*[:=]\s*(?P<pkgid>[A-Za-z0-9._\-]+)\s*(?:,\s*name\s*[:=]\s*(?P<name>.+))?",
)
# Matches pipe-separated "foo | bar | Baz"
_RE_PIPE = re.compile(r"^\s*([A-Za-z0-9._\-]+)\s*\|\s*([A-Za-z0-9._\-]+)\s*\|\s*(.+?)\s*$")
# Matches a bare package id (with optional trailing tab + name)
_RE_BARE = re.compile(r"^\s*([A-Za-z0-9._\-]{4,})(?:\s+\(\d+\))?(?:[\t ]+(.+?))?\s*$")
# pkgcmd line: pkg_type [tpk] pkgid [com.samsung.foo] ...
_RE_PKGCMD = re.compile(r"pkgid\s*\[(?P<pkgid>[^\]]+)\]", re.IGNORECASE)


class DebloatService:
    def __init__(self) -> None:
        self._app_db: dict[str, dict] = self.load_app_db()
        self.ABSOLUTE_NEVER_REMOVE = ABSOLUTE_NEVER_REMOVE

    # ── App DB ────────────────────────────────────────────────────────────
    def load_app_db(self) -> dict[str, dict]:
        if not APP_DB_PATH.exists():
            log.warning("debloat: app database not found at %s", APP_DB_PATH)
            return {}
        try:
            with APP_DB_PATH.open("r", encoding="utf-8") as f:
                entries = json.load(f)
            return {e["package_id"]: e for e in entries if isinstance(e, dict) and e.get("package_id")}
        except Exception as e:
            log.error("debloat: failed to load app database: %s", e)
            return {}

    def get_app_db_list(self) -> list[dict]:
        return list(self._app_db.values())

    # ── Scan ──────────────────────────────────────────────────────────────
    # NOTE: Samsung consumer Tizen TVs report `intershell_support:disabled`
    # under `sdb capability`, which blocks ALL `sdb shell` invocations
    # (including `vd_appmanage list`, `pkgcmd -l`, `app_launcher --list`).
    # We therefore cannot enumerate the actually-installed app set on the TV.
    #
    # Strategy: present the bundled curated app database as the scan result.
    # During removal, `tizen uninstall -p <pkgid>` is attempted for each
    # selected package and the outcome is logged honestly:
    #   "uninstall completed" → success=True
    #   "package is not exist" → success=False, error="Not installed on this TV"
    #   "Package ID is not valid" → success=False, error="Invalid package id"
    async def _resolve_serial(self, tv_ip: str, sdb_path: str) -> str:
        """Resolve sdb device serial — prefer one matching tv_ip, fall back to ip:26101."""
        try:
            await tizenbrew_service.sdb_connect(tv_ip, sdb_path)
            devices = await tizenbrew_service.sdb_devices(sdb_path)
            for d in devices:
                if tv_ip in d:
                    return d
            if devices:
                return devices[0]
        except Exception as e:
            log.warning("debloat: serial resolve failed: %s", e)
        return f"{tv_ip}:26101"

    async def scan_tv_apps(self, tv_ip: str, sdb_path: str) -> list[dict[str, Any]]:
        """
        Return the bundled app DB as the scan list. We can't enumerate the TV's
        actual installed apps (intershell disabled on consumer Samsung TVs).
        Verifying connectivity is still useful — ensure sdb can reach the TV.
        """
        try:
            await tizenbrew_service.sdb_connect(tv_ip, sdb_path)
        except Exception as e:
            log.warning("debloat: sdb_connect failed (continuing with DB scan): %s", e)
        return [{"package_id": pid, "tv_name": entry.get("app_name")}
                for pid, entry in self._app_db.items()]

    # ── Enrich ────────────────────────────────────────────────────────────
    def enrich_scan_results(self, raw_apps: list[dict]) -> list[ScannedApp]:
        enriched: list[ScannedApp] = []
        for raw in raw_apps:
            pid = raw["package_id"]
            tv_name = raw.get("tv_name")
            entry = self._app_db.get(pid)
            if entry:
                a = ScannedApp(
                    package_id=pid,
                    app_name=entry.get("app_name") or pid,
                    description=entry.get("description"),
                    category=entry.get("category") or "Unknown",
                    safety=entry.get("safety") or "unknown",
                    safe_to_remove=bool(entry.get("safe_to_remove", True)),
                    never_remove=bool(entry.get("never_remove", False)) or pid in ABSOLUTE_NEVER_REMOVE,
                    frame_tv_warning=bool(entry.get("frame_tv_warning", False)),
                    notes=entry.get("notes"),
                    known=True,
                )
            else:
                a = ScannedApp(
                    package_id=pid,
                    app_name=tv_name or pid,
                    description=None,
                    category="Unknown",
                    safety="unknown",
                    safe_to_remove=True,
                    never_remove=pid in ABSOLUTE_NEVER_REMOVE,
                    frame_tv_warning=False,
                    notes=None,
                    known=False,
                )
            enriched.append(a)

        enriched.sort(key=lambda x: (
            0 if x.never_remove else 1,
            (x.category or "").lower(),
            (x.app_name or "").lower(),
        ))
        return enriched

    # ── Remove ────────────────────────────────────────────────────────────
    async def remove_app(
        self,
        sdb_path: str,
        sdb_serial: str,
        tizen_path: str,
        package_id: str,
        app_name: str,
        category: str | None,
        tv_id: int,
        current: int,
        total: int,
    ) -> dict[str, Any]:
        progress = int(current / max(total, 1) * 100)
        await ws_manager.broadcast({
            "type": "debloat_progress",
            "tv_id": tv_id,
            "step": "removing",
            "package_id": package_id,
            "app_name": app_name,
            "message": f"Removing {app_name} ({current}/{total})…",
            "current": current,
            "total": total,
            "progress": progress,
        })

        # Use `tizen uninstall` CLI — the only reliable removal path on
        # consumer Samsung TVs (intershell is disabled so sdb shell can't run
        # vd_appuninstall / pkgcmd -u directly).
        res = await tizenbrew_service.run_command(
            [tizen_path, "uninstall", "-p", package_id, "-s", sdb_serial],
            timeout=60.0,
        )
        out = ((res.get("stdout") or "") + "\n" + (res.get("stderr") or "")).strip()
        rc = res.get("returncode", 0)
        low = out.lower()

        if "uninstall completed" in low or "successfully uninstalled" in low:
            ok, err = True, None
        elif "package is not exist" in low or "is not exist" in low:
            ok, err = False, "Not installed on this TV"
        elif "package id is not valid" in low or "not valid" in low:
            ok, err = False, "Invalid package ID format"
        elif rc == 0 and "fail" not in low and "error" not in low:
            ok, err = True, None
        else:
            ok, err = False, (out[:500] or f"Removal failed (rc={rc})")

        try:
            async with SessionLocal() as s:
                row = RemovalLog(
                    tv_id=tv_id,
                    package_id=package_id,
                    app_name=app_name,
                    category=category,
                    removed_at=datetime.utcnow(),
                    success=ok,
                    error_message=err,
                    sdb_output=out[:4000] if out else None,
                )
                s.add(row)
                await s.commit()
        except Exception as e:
            log.error("debloat: failed to write removal log: %s", e)

        return {"success": ok, "error": err, "output": out}

    async def remove_apps_pipeline(self, tv_id: int, package_ids: list[str]) -> None:
        # Server-side double safety filter
        safe_ids = [p for p in package_ids if p not in ABSOLUTE_NEVER_REMOVE]
        total = len(safe_ids)
        if total == 0:
            await ws_manager.broadcast({
                "type": "debloat_progress", "tv_id": tv_id, "step": "error",
                "package_id": None, "app_name": None,
                "message": "All packages were protected — nothing to do",
                "current": 0, "total": 0, "progress": 0,
            })
            return

        try:
            await ws_manager.broadcast({
                "type": "debloat_progress", "tv_id": tv_id, "step": "connecting",
                "package_id": None, "app_name": None,
                "message": "Locating Tizen Studio tools…",
                "current": 0, "total": total, "progress": 0,
            })

            tools = await tizenbrew_service.find_tizen_tools()
            sdb_path = tools.get("sdb_path")
            tizen_path = tools.get("tizen_path")
            if not sdb_path or not tizen_path:
                raise RuntimeError("sdb / tizen CLI not found — install Tizen Studio first")

            async with SessionLocal() as s:
                tv = await s.get(TV, tv_id)
            if not tv:
                raise RuntimeError(f"TV {tv_id} not found")

            await ws_manager.broadcast({
                "type": "debloat_progress", "tv_id": tv_id, "step": "connecting",
                "package_id": None, "app_name": None,
                "message": f"Connecting to {tv.ip}…",
                "current": 0, "total": total, "progress": 0,
            })
            serial = await self._resolve_serial(tv.ip, sdb_path)

            successes = 0
            failures = 0
            for i, pid in enumerate(safe_ids, start=1):
                entry = self._app_db.get(pid) or {}
                app_name = entry.get("app_name") or pid
                category = entry.get("category")
                try:
                    res = await self.remove_app(
                        sdb_path, serial, tizen_path, pid, app_name, category,
                        tv_id, i, total,
                    )
                    if res["success"]:
                        successes += 1
                    else:
                        failures += 1
                except Exception as e:
                    log.exception("debloat: error removing %s", pid)
                    failures += 1
                    try:
                        async with SessionLocal() as s:
                            s.add(RemovalLog(
                                tv_id=tv_id, package_id=pid, app_name=app_name,
                                category=category, removed_at=datetime.utcnow(),
                                success=False, error_message=str(e)[:2000],
                            ))
                            await s.commit()
                    except Exception:
                        pass

            await ws_manager.broadcast({
                "type": "debloat_progress", "tv_id": tv_id, "step": "done",
                "package_id": None, "app_name": None,
                "message": f"Complete: {successes} removed, {failures} not present/failed",
                "current": total, "total": total, "progress": 100,
            })
        except Exception as e:
            log.exception("debloat: pipeline error")
            await ws_manager.broadcast({
                "type": "debloat_progress", "tv_id": tv_id, "step": "error",
                "package_id": None, "app_name": None,
                "message": f"Removal pipeline failed: {e}",
                "current": 0, "total": total, "progress": 0,
            })

    # ── Audit log ─────────────────────────────────────────────────────────
    async def get_removal_log(self, tv_id: int) -> list[RemovalLog]:
        async with SessionLocal() as s:
            res = await s.execute(
                select(RemovalLog)
                .where(RemovalLog.tv_id == tv_id)
                .order_by(RemovalLog.removed_at.desc())
            )
            return list(res.scalars().all())

    async def mark_restored(self, log_id: int) -> bool:
        async with SessionLocal() as s:
            row = await s.get(RemovalLog, log_id)
            if not row:
                return False
            row.restored_at = datetime.utcnow()
            await s.commit()
            return True


debloat_service = DebloatService()
