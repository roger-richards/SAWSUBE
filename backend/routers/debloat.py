from __future__ import annotations
import asyncio
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_session
from ..models.tv import TV
from ..schemas_debloat import (
    BulkRemoveResponse,
    RemovalLogEntry,
    RemoveRequest,
    ScanResult,
)
from ..services.debloat_service import debloat_service, ABSOLUTE_NEVER_REMOVE
from ..services.tizenbrew_service import tizenbrew_service

router = APIRouter(prefix="/api/debloat", tags=["debloat"])


@router.get("/{tv_id}/scan", response_model=ScanResult)
async def scan_tv(tv_id: int, s: AsyncSession = Depends(get_session)) -> ScanResult:
    tv = await s.get(TV, tv_id)
    if not tv:
        raise HTTPException(404, "TV not found")
    tools = await tizenbrew_service.find_tizen_tools()
    if not tools.get("sdb_path"):
        raise HTTPException(
            400,
            detail=(
                "sdb binary not found. Tizen Studio must be installed to scan the TV. "
                "Visit the TizenBrew setup page to configure Tizen Studio."
            ),
        )
    raw = await debloat_service.scan_tv_apps(tv.ip, tools["sdb_path"])
    apps = debloat_service.enrich_scan_results(raw)
    return ScanResult(
        tv_id=tv_id,
        total_apps=len(apps),
        known_apps=sum(1 for a in apps if a.known),
        safe_count=sum(1 for a in apps if a.safety == "safe"),
        optional_count=sum(1 for a in apps if a.safety == "optional"),
        caution_count=sum(1 for a in apps if a.safety == "caution"),
        system_count=sum(1 for a in apps if a.safety == "system"),
        unknown_count=sum(1 for a in apps if a.safety == "unknown"),
        apps=apps,
    )


@router.post("/{tv_id}/remove", response_model=BulkRemoveResponse, status_code=202)
async def remove_apps(
    tv_id: int,
    payload: RemoveRequest,
    s: AsyncSession = Depends(get_session),
) -> BulkRemoveResponse:
    tv = await s.get(TV, tv_id)
    if not tv:
        raise HTTPException(404, "TV not found")
    if not payload.package_ids:
        raise HTTPException(400, "No package IDs provided")
    safe_ids = [p for p in payload.package_ids if p not in ABSOLUTE_NEVER_REMOVE]
    if not safe_ids:
        raise HTTPException(400, "All selected packages are protected and cannot be removed")
    job_id = uuid.uuid4().hex
    asyncio.create_task(debloat_service.remove_apps_pipeline(tv_id, safe_ids))
    return BulkRemoveResponse(started=True, job_id=job_id, count=len(safe_ids))


@router.get("/{tv_id}/log", response_model=list[RemovalLogEntry])
async def get_log(tv_id: int) -> list[RemovalLogEntry]:
    rows = await debloat_service.get_removal_log(tv_id)
    return [RemovalLogEntry.model_validate(r) for r in rows]


@router.post("/log/{log_id}/restore")
async def restore_log_entry(log_id: int) -> dict:
    ok = await debloat_service.mark_restored(log_id)
    if not ok:
        raise HTTPException(404, "Log entry not found")
    return {"ok": True}


@router.get("/apps/database")
async def get_app_database() -> list[dict]:
    return debloat_service.get_app_db_list()
