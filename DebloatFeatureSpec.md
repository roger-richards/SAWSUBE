---

# Developer Specification: Samsung Tizen TV Debloat Utility for SAWSUBE

**Target Model:** Claude Opus 4.5 (claude-opus-4-5)
**Codebase:** [WB2024/SAWSUBE](https://github.com/WB2024/SAWSUBE)
**Date:** April 2026

---

## 1. Overview & Objectives

Integrate a fully guided, point-and-click **TV Debloat Utility** into SAWSUBE. The user should be able to:

1. Connect to their Samsung TV via the already-established sdb infrastructure
2. Scan the TV and receive a categorised, human-readable list of all installed apps
3. Select apps to remove — with safety guardrails preventing removal of critical apps (Art Mode, system shell, etc.)
4. Remove selected apps with a single click, with real-time progress streamed to the UI
5. View a full audit log of every removal — what was removed, when, and the result
6. Optionally restore any removed app from the log (reinstall via `sdb shell` if a recovery path exists)

**No terminal required. No guesswork. All point-and-click.**

---

## 2. Existing Codebase Context Claude Must Read First

### 2.1 What Already Exists (Do Not Re-implement)

The TizenBrew feature (already merged) provides **all the plumbing** this feature needs. Claude must reuse it directly:

| Existing asset | Where to reuse it |
|---|---|
| `tizenbrew_service.run_command()` | All sdb shell commands go through this |
| `tizenbrew_service.find_tizen_tools()` | sdb binary detection — call this, don't duplicate |
| `tizenbrew_service.sdb_connect()` | Connect to TV before shell commands |
| `ws_manager.broadcast()` | Real-time progress to frontend |
| `SessionLocal` + SQLAlchemy async pattern | DB writes in debloat service |
| `get_session` dependency | Router session injection |
| `APIRouter(prefix=..., tags=[...])` | Router pattern |
| `asyncio.create_task(...)` | Fire-and-forget long operations |
| `JobStarted` schema | Return immediately for long ops |

**Do not copy these.** Import and call them.

### 2.2 Backend Patterns (Follow Exactly)

```python
# Service: always async, singleton instance at bottom of file
class DebloatService:
    ...
debloat_service = DebloatService()

# Router: APIRouter with prefix, use Depends(get_session)
router = APIRouter(prefix="/api/debloat", tags=["debloat"])

# Long-running ops: return HTTP 202 immediately, run in background task
asyncio.create_task(debloat_service.some_long_operation(tv_id))
return JobStarted(started=True, job_id=uuid.uuid4().hex)

# DB writes: always use async with SessionLocal() as s:
async with SessionLocal() as s:
    s.add(row)
    await s.commit()
```

### 2.3 Frontend Patterns (Follow Exactly)

```tsx
// State: useState + useEffect only — no Redux, no Zustand
const [apps, setApps] = useState<ScannedApp[]>([])
useEffect(() => { api.get<ScannedApp[]>(`/api/debloat/${tvId}/scan`) ... }, [tvId])

// API calls: always use the api client from ../lib/api
import { api } from '../lib/api'
const result = await api.post<JobStarted>(`/api/debloat/${tvId}/remove`, { package_ids: [...] })

// Real-time updates: useWS from ../lib/hooks
import { useWS } from '../lib/hooks'
useWS((msg) => { if (msg.type === 'debloat_progress') { ... } })

// Toasts: useToast from ../components/Toast
import { useToast } from '../components/Toast'
const { addToast } = useToast()
addToast('Removed successfully', 'success')

// Colours: SAWSUBE palette inline style={} — never new CSS files
// Background:  #0F1923
// Accent:      #C8612A
// Text:        #F4F1ED
// Borders:     #1E2A35
// Green:       #4A7C5F
// Red/danger:  #A33228
// Gold/warn:   #C49A3C
// Muted:       #A09890
```

---

## 3. New Files to Create

```
backend/data/tizen_apps.json              # Bundled app knowledge database
backend/models/debloat.py                 # RemovalLog DB model
backend/schemas_debloat.py               # All Pydantic schemas
backend/services/debloat_service.py       # All business logic
backend/routers/debloat.py               # All API endpoints
frontend/src/pages/Debloat.tsx           # Full debloat page
```

---

## 4. The App Knowledge Database

### `backend/data/tizen_apps.json`

This is the **heart of the feature**. It's a static JSON file bundled with SAWSUBE that maps known Samsung Tizen package IDs to human-readable names, descriptions, safety ratings, and categories. Claude must create this file with at minimum the entries listed below.

**Schema for each entry:**

```json
{
  "package_id": "com.samsung.tv.adplayer",
  "app_name": "Ad Player",
  "description": "Plays advertisement overlays on the home screen and in apps.",
  "category": "Advertising",
  "safety": "safe",
  "safe_to_remove": true,
  "never_remove": false,
  "frame_tv_warning": false,
  "notes": null
}
```

**`safety` field values:**
- `"safe"` — Remove freely. No functional impact.
- `"optional"` — Useful to some users. Remove if unused.
- `"caution"` — Removes a notable feature. Show warning before removal.
- `"system"` — Core system component. Never allow removal.

**`never_remove`** — If `true`, the entry is **hardcoded as unselectable** in the UI. This cannot be overridden by the user.

**`frame_tv_warning`** — If `true`, show an additional amber warning banner on Frame TV models specifically (e.g. Art Mode related apps).

---

**Minimum required entries (Claude must include ALL of these):**

```json
[
  {
    "package_id": "org.tizen.art-app",
    "app_name": "Art Mode (Art App)",
    "description": "The core Art Mode application for the Samsung Frame TV. Removing this WILL break Art Mode permanently.",
    "category": "Core — Frame TV",
    "safety": "system",
    "safe_to_remove": false,
    "never_remove": true,
    "frame_tv_warning": true,
    "notes": "NEVER remove on Frame TVs. This is the reason you bought the TV."
  },
  {
    "package_id": "com.samsung.tv.coba.art",
    "app_name": "Art Mode Ambient Component",
    "description": "Handles the ambient display and slideshow UI within Art Mode.",
    "category": "Core — Frame TV",
    "safety": "system",
    "safe_to_remove": false,
    "never_remove": true,
    "frame_tv_warning": true,
    "notes": "Required for Art Mode to function."
  },
  {
    "package_id": "com.samsung.tv.ambient-support",
    "app_name": "Ambient Mode Support",
    "description": "Background service supporting ambient display features.",
    "category": "Core — Frame TV",
    "safety": "system",
    "safe_to_remove": false,
    "never_remove": true,
    "frame_tv_warning": true,
    "notes": "Required for Art Mode ambient display."
  },
  {
    "package_id": "org.tizen.sso",
    "app_name": "Samsung Single Sign-On",
    "description": "Handles Samsung account login across all apps. Removing breaks app authentication.",
    "category": "Core System",
    "safety": "system",
    "safe_to_remove": false,
    "never_remove": true,
    "frame_tv_warning": false,
    "notes": "Required for Samsung account and any app that uses login."
  },
  {
    "package_id": "com.samsung.tv.adplayer",
    "app_name": "Ad Player",
    "description": "Plays advertisement videos and overlays on the home screen.",
    "category": "Advertising",
    "safety": "safe",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": null
  },
  {
    "package_id": "com.samsung.tv.acr-service-app",
    "app_name": "ACR (Automatic Content Recognition)",
    "description": "Identifies what you're watching and sends data to Samsung for ad targeting.",
    "category": "Tracking & Analytics",
    "safety": "safe",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": null
  },
  {
    "package_id": "com.samsung.tv.targeted-ad-service",
    "app_name": "Targeted Ad Service",
    "description": "Delivers personalised advertisements based on viewing data.",
    "category": "Advertising",
    "safety": "safe",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": null
  },
  {
    "package_id": "com.samsung.tv.pisa-service",
    "app_name": "AdAgent Service (PISA)",
    "description": "Another ad delivery service running in the background.",
    "category": "Advertising",
    "safety": "safe",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": null
  },
  {
    "package_id": "com.samsung.tizen.samsung-analytics",
    "app_name": "Samsung Analytics",
    "description": "Sends TV usage data and telemetry to Samsung servers.",
    "category": "Tracking & Analytics",
    "safety": "safe",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": null
  },
  {
    "package_id": "com.samsung.tv.tvplus",
    "app_name": "Samsung TV Plus",
    "description": "Free ad-supported streaming channel service from Samsung.",
    "category": "Streaming Apps",
    "safety": "optional",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": "Safe to remove if unused."
  },
  {
    "package_id": "com.samsung.tv.bixby-promotion",
    "app_name": "Bixby Promotion",
    "description": "Displays Bixby promotional popups and onboarding flows.",
    "category": "Bixby",
    "safety": "safe",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": null
  },
  {
    "package_id": "com.samsung.tv.AccountNudgeService",
    "app_name": "Account Nudge Service",
    "description": "Periodically prompts you to log into or verify your Samsung account.",
    "category": "Advertising",
    "safety": "safe",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": null
  },
  {
    "package_id": "com.samsung.tv.samsung-health",
    "app_name": "Samsung Health",
    "description": "Samsung Health app integration on TV.",
    "category": "Optional Apps",
    "safety": "optional",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": null
  },
  {
    "package_id": "com.samsung.tv.gaminghub",
    "app_name": "Gaming Hub",
    "description": "Samsung's cloud gaming aggregation platform.",
    "category": "Optional Apps",
    "safety": "optional",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": "Safe to remove if not using cloud gaming."
  },
  {
    "package_id": "org.tizen.remote-management",
    "app_name": "Remote Management",
    "description": "Allows Samsung (and potentially third parties) to remotely manage your TV.",
    "category": "Tracking & Analytics",
    "safety": "safe",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": "Privacy concern — safe to remove."
  },
  {
    "package_id": "com.samsung.tv.smartthingsfind-daemon",
    "app_name": "SmartThings Find",
    "description": "Background daemon enabling the SmartThings Find lost-device network.",
    "category": "Tracking & Analytics",
    "safety": "optional",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": null
  },
  {
    "package_id": "org.tizen.content-tiles-provider",
    "app_name": "Content Tiles Provider",
    "description": "Powers the content recommendation tiles on the Samsung home screen.",
    "category": "Advertising",
    "safety": "safe",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": "Removes the ad/recommendation tiles from the home bar."
  },
  {
    "package_id": "com.samsung.tv.preview-downloader",
    "app_name": "Preview Downloader",
    "description": "Pre-downloads video previews for content tiles on the home screen.",
    "category": "Advertising",
    "safety": "safe",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": "Safe to remove — pairs with Content Tiles Provider."
  },
  {
    "package_id": "com.samsung.tv.digitalbutler-app",
    "app_name": "Digital Butler",
    "description": "Concierge-style content recommendation service.",
    "category": "Advertising",
    "safety": "safe",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": null
  },
  {
    "package_id": "com.samsung.tv.context-aware-service",
    "app_name": "Context-Aware Service",
    "description": "Tracks your viewing context and behaviour to personalise content suggestions.",
    "category": "Tracking & Analytics",
    "safety": "safe",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": null
  },
  {
    "package_id": "com.samsung.tizen.samsung-cloud",
    "app_name": "Samsung Cloud",
    "description": "Samsung's cloud sync service for settings and data.",
    "category": "Optional Apps",
    "safety": "optional",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": null
  },
  {
    "package_id": "org.tizen.remote-shop-care-hub",
    "app_name": "Remote Shop Care Hub (RSCM)",
    "description": "Retail demo mode and remote shop management service. Not needed in home.",
    "category": "Retail/Demo",
    "safety": "safe",
    "safe_to_remove": true,
    "never_remove": false,
    "frame_tv_warning": false,
    "notes": null
  }
]
```

Claude must include additional entries for common pre-installed streaming apps (Netflix, Prime Video, Disney+, Apple TV, Hulu, Peacock, Tubi, Pluto TV, Paramount+, ESPN) — these should have `safety: "optional"` and `safe_to_remove: true`.

---

## 5. Database Model

### `backend/models/debloat.py`

```python
from __future__ import annotations
from datetime import datetime
from sqlalchemy import String, Integer, DateTime, Boolean, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column
from ..database import Base


class RemovalLog(Base):
    __tablename__ = "debloat_removal_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tv_id: Mapped[int] = mapped_column(Integer, ForeignKey("tvs.id", ondelete="CASCADE"))
    package_id: Mapped[str] = mapped_column(String(512))
    app_name: Mapped[str] = mapped_column(String(256))           # human name at time of removal
    category: Mapped[str | None] = mapped_column(String(128), nullable=True)
    removed_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    success: Mapped[bool] = mapped_column(Boolean, default=False)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    sdb_output: Mapped[str | None] = mapped_column(Text, nullable=True)  # raw sdb output
    restored_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
```

**Register in `backend/database.py`:** Add `debloat` to the import in `init_db()`:
```python
from .models import tv, image, schedule, history, folder, tizenbrew, debloat  # noqa: F401
```

**Register in `backend/main.py`:** Add alongside the tizenbrew model import:
```python
from .models import debloat as _debloat_models  # noqa: F401
```

---

## 6. Pydantic Schemas

### `backend/schemas_debloat.py`

```python
from __future__ import annotations
from datetime import datetime
from pydantic import BaseModel


class ScannedApp(BaseModel):
    """Represents one app discovered on the TV during a scan."""
    package_id: str
    app_name: str                   # From DB if known, else raw package_id
    description: str | None
    category: str                   # "Unknown" if not in DB
    safety: str                     # "safe" | "optional" | "caution" | "system" | "unknown"
    safe_to_remove: bool
    never_remove: bool              # Hard block — cannot be selected in UI
    frame_tv_warning: bool
    notes: str | None
    known: bool                     # True if package_id found in tizen_apps.json


class ScanResult(BaseModel):
    tv_id: int
    total_apps: int
    known_apps: int
    safe_count: int
    optional_count: int
    caution_count: int
    system_count: int
    unknown_count: int
    apps: list[ScannedApp]


class RemoveRequest(BaseModel):
    package_ids: list[str]          # Package IDs to remove


class RemovalResult(BaseModel):
    package_id: str
    app_name: str
    success: bool
    error: str | None


class BulkRemoveResponse(BaseModel):
    started: bool
    job_id: str
    count: int                      # Number of packages queued


class RemovalLogEntry(BaseModel):
    id: int
    tv_id: int
    package_id: str
    app_name: str
    category: str | None
    removed_at: datetime
    success: bool
    error_message: str | None
    restored_at: datetime | None

    class Config:
        from_attributes = True


class DebloatProgressEvent(BaseModel):
    """WebSocket event pushed during removal."""
    type: str                       # "debloat_progress"
    tv_id: int
    step: str                       # "connecting" | "removing" | "done" | "error"
    package_id: str | None
    app_name: str | None
    message: str
    current: int                    # n-th package being processed
    total: int                      # total packages in this job
    progress: int                   # 0–100
```

---

## 7. Backend Service

### `backend/services/debloat_service.py`

This is the core logic layer. All methods must be `async`. Singleton pattern at the bottom.

```python
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
from .tizenbrew_service import tizenbrew_service   # ← IMPORT, DO NOT COPY

log = logging.getLogger(__name__)

# Path to bundled app database
APP_DB_PATH = Path(__file__).parent.parent / "data" / "tizen_apps.json"

# Hard-coded set of package IDs that can NEVER be removed
# regardless of database contents or user selection
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
```

#### 7.1 App Database Loading

```python
def load_app_db(self) -> dict[str, dict]:
    """
    Load tizen_apps.json and return a dict keyed by package_id.
    Called once at service init and cached in self._app_db.
    If file not found, log warning and return empty dict.
    """
```

#### 7.2 TV App Scanning

```python
async def scan_tv_apps(self, tv_ip: str, sdb_path: str) -> list[dict[str, Any]]:
    """
    Discover all installed apps on the TV using two complementary commands.
    
    PRIMARY command (Tizen 6+):
        sdb -s <ip_or_serial> shell 0 vd_appmanage list
    
    FALLBACK command (older Tizen / backup):
        sdb -s <ip_or_serial> shell app_launcher --list
    
    Run primary first. If it returns 0 results or fails, run fallback.
    Run both and merge/deduplicate by package_id.
    
    sdb serial resolution:
        - Connect via sdb_connect() first if not already connected
        - sdb_devices() to get exact serial (may be "<ip>:26101" or just "<ip>")
        - Pass serial via -s flag to sdb
    
    Parsing vd_appmanage output:
        Lines look like:
            AppID:com.samsung.tv.adplayer PackageID:com.samsung.tv.adplayer Name:Ad Player
        OR (on some firmware versions):
            com.samsung.tv.adplayer | com.samsung.tv.adplayer | Ad Player
        OR:
            com.samsung.tv.adplayer\t\tAd Player
        
        Be tolerant. Parse all three formats. Extract at minimum:
        - package_id (the installable package identifier)
        - raw_name (the name the TV reports, may be empty/different from our DB)
    
    Parsing app_launcher --list output:
        Lines look like:
            [Running apps]
            com.samsung.tv.adplayer    (1)
        OR:
            appID: com.samsung.tv.adplayer, name: Ad Player
        
        Extract package_id from each line. Be tolerant of format variation.
    
    Returns: list of { "package_id": str, "tv_name": str|None }
    Deduplicated by package_id. Never include empty or whitespace-only IDs.
    """
```

#### 7.3 Scan Enrichment

```python
def enrich_scan_results(self, raw_apps: list[dict]) -> list[ScannedApp]:
    """
    Takes raw scan results (package_id + tv_name) and enriches with DB knowledge.
    
    For each raw app:
    1. Look up package_id in self._app_db
    2. If found: use all DB fields
    3. If not found: create ScannedApp with:
        - app_name = tv_name or package_id
        - category = "Unknown"
        - safety = "unknown"
        - safe_to_remove = True  (unknown apps are assumed removable)
        - never_remove = package_id in ABSOLUTE_NEVER_REMOVE
        - known = False
    4. Enforce: if package_id in ABSOLUTE_NEVER_REMOVE → never_remove = True regardless of DB
    
    Sort output:
        1. never_remove=True apps first (so they're visible but blocked)
        2. Then by category alphabetically
        3. Then by app_name alphabetically
    
    Returns list[ScannedApp]
    """
```

#### 7.4 App Removal

```python
async def remove_app(
    self,
    tv_ip: str,
    sdb_path: str,
    sdb_serial: str,
    package_id: str,
    app_name: str,
    tv_id: int,
    current: int,
    total: int,
) -> dict[str, Any]:
    """
    Remove a single app from the TV.
    
    Command (Tizen 6+ primary):
        sdb -s <sdb_serial> shell 0 vd_appuninstall <package_id>
    
    Fallback command (if primary returns non-zero or output contains "fail"):
        sdb -s <sdb_serial> shell app_launcher --uninstall <package_id>
    
    Always use run_command() from tizenbrew_service (do NOT call subprocess directly).
    Timeout: 30 seconds per app.
    
    Broadcast before attempting:
        ws_manager.broadcast({
            "type": "debloat_progress",
            "tv_id": tv_id,
            "step": "removing",
            "package_id": package_id,
            "app_name": app_name,
            "message": f"Removing {app_name}...",
            "current": current,
            "total": total,
            "progress": int(current / total * 100)
        })
    
    Determine success:
        - returncode == 0 AND output does not contain "fail" or "error" (case-insensitive)
        - Some firmware returns 0 even on failure — check output text
    
    Write to RemovalLog DB:
        success, error_message, sdb_output — always write regardless of outcome
    
    Returns: { "success": bool, "error": str|None, "output": str }
    """

async def remove_apps_pipeline(
    self,
    tv_id: int,
    package_ids: list[str],
) -> None:
    """
    Background pipeline for removing multiple apps.
    
    Steps:
    1. Validate: filter out any package_id in ABSOLUTE_NEVER_REMOVE (double safety check)
    2. find_tizen_tools() to get sdb_path
    3. Get TV IP from DB (TV model)
    4. sdb_connect(tv_ip, sdb_path)
    5. sdb_devices() to resolve exact serial
    6. Broadcast "connecting" step
    7. Loop through package_ids — call remove_app() for each
       - Track current/total counter for progress
       - Continue on individual failure (do not abort entire job)
    8. After all done, broadcast final summary:
        {
          "type": "debloat_progress",
          "step": "done",
          "tv_id": tv_id,
          "message": f"Complete: {successes} removed, {failures} failed",
          "current": total,
          "total": total,
          "progress": 100,
          "package_id": None,
          "app_name": None
        }
    
    Critical: wrap entire function in try/except. On exception, broadcast
    step="error" event before raising.
    """
```

#### 7.5 Audit Log

```python
async def get_removal_log(self, tv_id: int) -> list[RemovalLog]:
    """
    Return all RemovalLog entries for a TV, ordered by removed_at DESC.
    """

async def mark_restored(self, log_id: int) -> bool:
    """
    Set restored_at = datetime.utcnow() on the given log entry.
    Returns True if found and updated, False if not found.
    This is for the user's record-keeping — it doesn't actually reinstall the app.
    """
```

#### 7.6 Service Init

```python
class DebloatService:
    def __init__(self) -> None:
        self._app_db: dict[str, dict] = self.load_app_db()

debloat_service = DebloatService()
```

---

## 8. Backend Router

### `backend/routers/debloat.py`

`APIRouter(prefix="/api/debloat", tags=["debloat"])`

#### Full Endpoint Table

| Method | Path | Response | Description |
|--------|------|----------|-------------|
| `GET` | `/{tv_id}/scan` | `ScanResult` | Run sdb scan on TV, return enriched app list. This IS synchronous (scan takes ~5s — acceptable). |
| `POST` | `/{tv_id}/remove` | `BulkRemoveResponse` (HTTP 202) | Start removal pipeline. Body: `RemoveRequest`. Returns immediately. |
| `GET` | `/{tv_id}/log` | `list[RemovalLogEntry]` | Fetch removal audit log for this TV |
| `POST` | `/log/{log_id}/restore` | `{ "ok": bool }` | Mark a log entry as restored (record-keeping only) |
| `GET` | `/apps/database` | Full app DB | Returns the entire `tizen_apps.json` content for frontend reference |

#### Implementation Notes

**`GET /{tv_id}/scan`:**
```python
@router.get("/{tv_id}/scan", response_model=ScanResult)
async def scan_tv(tv_id: int, s: AsyncSession = Depends(get_session)):
    tv = await s.get(TV, tv_id)
    if not tv:
        raise HTTPException(404, "TV not found")
    tools = await tizenbrew_service.find_tizen_tools()
    if not tools["sdb_path"]:
        raise HTTPException(400, detail=(
            "sdb binary not found. Tizen Studio must be installed to scan the TV. "
            "Visit the TizenBrew setup page to configure Tizen Studio."
        ))
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
```

**`POST /{tv_id}/remove`:**
```python
@router.post("/{tv_id}/remove", response_model=BulkRemoveResponse, status_code=202)
async def remove_apps(tv_id: int, payload: RemoveRequest, s: AsyncSession = Depends(get_session)):
    tv = await s.get(TV, tv_id)
    if not tv:
        raise HTTPException(404, "TV not found")
    if not payload.package_ids:
        raise HTTPException(400, "No package IDs provided")
    
    # Server-side safety: strip any ABSOLUTE_NEVER_REMOVE packages silently
    safe_ids = [p for p in payload.package_ids 
                if p not in debloat_service.ABSOLUTE_NEVER_REMOVE]   # wait — import this
    if not safe_ids:
        raise HTTPException(400, "All selected packages are protected and cannot be removed")
    
    job_id = uuid.uuid4().hex
    asyncio.create_task(debloat_service.remove_apps_pipeline(tv_id, safe_ids))
    return BulkRemoveResponse(started=True, job_id=job_id, count=len(safe_ids))
```

**Import in `backend/main.py`:**
```python
from .routers import debloat as debloat_router
# ...
app.include_router(debloat_router.router)
```

---

## 9. WebSocket Event Type

New WS event type pushed backend → frontend:

```json
{
  "type": "debloat_progress",
  "tv_id": 1,
  "step": "connecting | removing | done | error",
  "package_id": "com.samsung.tv.adplayer",
  "app_name": "Ad Player",
  "message": "Removing Ad Player (3/12)...",
  "current": 3,
  "total": 12,
  "progress": 25
}
```

---

## 10. Frontend Page

### `frontend/src/pages/Debloat.tsx`

A single page with **three sections** (not tabs — all visible vertically with smooth scroll, or tabs if content is too long — Claude's judgement based on how it renders).

#### 10.1 Page Header

```tsx
// Page heading
<h1>TV Debloat Utility</h1>
<p>Remove bloatware, tracking services, and unused apps from your Samsung TV. 
   All changes are logged and reversible in spirit — though some apps may 
   be reinstalled by Samsung firmware updates.</p>

// TV selector (if multiple TVs) — same pattern as TizenBrew.tsx TV dropdown
// Auto-select if only one TV exists
```

#### 10.2 Section 1 — Scan

**Top of page. Always visible.**

```
┌────────────────────────────────────────────────────────┐
│  📡 TV Scan                                            │
│                                                        │
│  TV: [Frame TV (192.168.1.100)    ▼]  [Scan TV 🔍]   │
│                                                        │
│  ⚠️ Tizen Studio (sdb) is required to scan your TV.   │
│     Set it up in the TizenBrew page first.             │
│     (only shown if sdb not found)                      │
│                                                        │
│  Last scan: 2 minutes ago  •  47 apps found            │
│  ✅ 18 safe to remove  •  🟡 8 optional  •  🔴 3 system │
└────────────────────────────────────────────────────────┘
```

- **Scan TV** button → calls `GET /api/debloat/{tv_id}/scan`
- Show a spinner during scan (it takes ~5s)
- Show a `ScanSummary` bar after scan completes showing category counts
- On error: show a clear error card with the error message and a tip about TizenBrew setup

#### 10.3 Section 2 — App List

**Main content area. Visible after scan.**

**Filter Bar** (above the list):
```
[All ▼]  [🔍 Search...]  [☐ Show protected apps]  [Select All Safe]  [Clear Selection]
```

- Category filter dropdown: All / Advertising / Tracking & Analytics / Bixby / Streaming Apps / Optional Apps / Retail/Demo / Unknown
- Text search filters on app_name and package_id (case-insensitive)
- "Show protected apps" checkbox — when unchecked (default), hides apps with `never_remove=true` or `safety="system"`
- **Select All Safe** — checks all apps where `safety === "safe"` and `never_remove === false`

**App List Items:**

Each app is a row (not a grid card — list is cleaner for 40+ items):

```
┌─────────────────────────────────────────────────────────────────────┐
│ ☑  Ad Player                          [Advertising]   ✅ Safe       │
│    Plays advertisement videos and overlays on the home screen.      │
│    com.samsung.tv.adplayer                                          │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ 🔒  Art Mode (Art App)               [Core — Frame]   🚫 Protected  │
│    Removing this WILL break Art Mode permanently.                   │
│    org.tizen.art-app                                                │
└─────────────────────────────────────────────────────────────────────┘
```

- Checkbox: checked = selected for removal. **Disabled and shows 🔒 if `never_remove=true`**
- App name (bold)
- Category pill (coloured by safety):
  - `safe` → green (`#4A7C5F`)
  - `optional` → gold (`#C49A3C`)
  - `caution` → orange (`#C8612A`)
  - `system` → red (`#A33228`)
  - `unknown` → muted (`#A09890`)
- Safety label text
- Description (muted, smaller font)
- Package ID (monospace, very muted)
- If `frame_tv_warning=true` AND the TV is detected as a Frame TV (check `tv.model` for "LS" prefix): show an amber ⚠️ badge

**Unknown apps** (not in DB):
- Show an ℹ️ info icon + tooltip: "This app wasn't found in our database. It may be safe to remove, but proceed with caution."
- Checkbox enabled but defaults to unchecked

#### 10.4 Removal Action Bar

**Sticky at the bottom of the page. Only visible when ≥1 app is selected.**

```
┌────────────────────────────────────────────────────────────────────┐
│  12 apps selected  ──  ⚠️ This cannot be undone easily.           │
│                                                                    │
│  [Cancel]                          [🗑️ Remove Selected Apps]       │
└────────────────────────────────────────────────────────────────────┘
```

On **Remove Selected Apps** click:
1. Show a **confirmation modal** (not browser confirm()) with:
   - Title: "Remove {n} apps from {TV Name}?"
   - Bullet list of selected app names (max 10 shown, then "...and X more")
   - Bold warning: "Firmware updates from Samsung may reinstall some of these apps."
   - Frame TV check: if any selected app has `frame_tv_warning=true`, show a prominent red banner: "⛔ Warning: One or more selected apps are flagged for Frame TV safety. Please double-check your selection."
   - Buttons: **Cancel** / **I understand, remove them**
2. On confirm: call `POST /api/debloat/{tv_id}/remove` with `{ package_ids: [...] }`
3. Show **live progress panel** (replaces the app list while running):
   - Progress bar 0–100%
   - Current app name being removed
   - Running log of results (✅ Removed: Ad Player / ❌ Failed: Samsung Analytics - error text)
   - Fed by `useWS` listening for `debloat_progress` events
4. On `step="done"`: show summary card + **"View Log"** button + **"Scan Again"** button

#### 10.5 Section 3 — Removal Log

**Below the app list. Collapsible panel.**

```
▼ Removal History (23 entries)
```

Table with columns: App Name | Package ID | Category | Removed | Result | Restored

- Result: ✅ Removed / ❌ Failed (with error tooltip)
- Restored: timestamp if `restored_at` set, otherwise **[Mark as Restored]** button
  - "Mark as Restored" → calls `POST /api/debloat/log/{log_id}/restore`
  - This is record-keeping only. Does not reinstall. Show a small info tooltip: "This marks the app as restored in your records. To actually reinstall, you'll need to perform a factory reset or wait for a firmware update."
- Pagination: show 20 per page

---

## 11. Sidebar & Route Registration

**`frontend/src/components/Sidebar.tsx`** — add to `links` array (after TizenBrew):
```tsx
['/debloat', 'Debloat'],
```

**`frontend/src/App.tsx`** — add route:
```tsx
import Debloat from './pages/Debloat'
// ...
<Route path="/debloat" element={<Debloat />} />
```

---

## 12. File Change Summary

| File | Action |
|------|--------|
| `backend/data/tizen_apps.json` | **CREATE** — App knowledge DB |
| `backend/models/debloat.py` | **CREATE** — RemovalLog model |
| `backend/schemas_debloat.py` | **CREATE** — All Pydantic schemas |
| `backend/services/debloat_service.py` | **CREATE** — Business logic |
| `backend/routers/debloat.py` | **CREATE** — API endpoints |
| `backend/database.py` | **MODIFY** — Add debloat to init_db import |
| `backend/main.py` | **MODIFY** — Register debloat router + model import |
| `frontend/src/pages/Debloat.tsx` | **CREATE** — Full page |
| `frontend/src/App.tsx` | **MODIFY** — Add route |
| `frontend/src/components/Sidebar.tsx` | **MODIFY** — Add nav link |

**No new Python packages required. No new frontend npm packages required.**

---

## 13. Key Technical Constraints & Notes for Claude Opus

1. **Import, don't copy.** `tizenbrew_service.run_command()`, `tizenbrew_service.find_tizen_tools()`, `tizenbrew_service.sdb_connect()`, and `tizenbrew_service.sdb_devices()` already exist and are fully tested. Import `tizenbrew_service` from `..services.tizenbrew_service` and call its methods. Do not rewrite subprocess handling.

2. **`vd_appmanage list` output is firmware-dependent.** The parser must handle at minimum these three formats:
   - `AppID:com.foo.bar PackageID:com.foo.bar Name:Foo Bar`
   - `com.foo.bar | com.foo.bar | Foo Bar`
   - `com.foo.bar\tFoo Bar`
   Use regex with named groups, not fixed split(). Log unrecognised lines at DEBUG level rather than crashing.

3. **sdb -s serial flag is essential.** When a user has multiple TVs connected, running `sdb shell` without `-s` hits the wrong TV. Always resolve the sdb serial (via `sdb_devices()`) and pass it with `-s`. If serial resolution fails, use `{tv_ip}:26101` as the fallback.

4. **No blocking subprocess calls.** All subprocess execution must go through `tizenbrew_service.run_command()` which uses `asyncio.create_subprocess_exec`. Never call `subprocess.run()` or `subprocess.Popen()` directly.

5. **The `ABSOLUTE_NEVER_REMOVE` frozenset is a double safety net.** It must be checked server-side in the router before the pipeline starts, AND in `remove_apps_pipeline` before each individual removal. The frontend enforces it too but the backend is the authority.

6. **Frame TV detection.** The Samsung Frame TV model numbers contain "LS" in the model name (e.g. `QN65LS03D`). Check `tv.model` for the "LS" substring. This is used to show/hide the `frame_tv_warning` UI elements. If `tv.model` is None (not yet populated), show the frame_tv_warning conservatively (i.e., always show it).

7. **Scan is synchronous (not fire-and-forget).** The scan endpoint waits for `sdb shell` to complete before returning. Typical scan time is 3–8 seconds — this is acceptable for an HTTP response. Do NOT make it async/background-task. The frontend should show a spinner during the request.

8. **Removal IS fire-and-forget.** Removing 20 apps could take 60+ seconds. The remove endpoint returns HTTP 202 immediately and streams progress via WebSocket. The `DebloatProgressEvent` WS events drive all frontend UI updates during removal.

9. **Always write to RemovalLog, even on failure.** Every attempted removal (success or failure) gets a log entry. The user must always be able to see what was attempted. The `success=False` + `error_message` fields tell the story.

10. **The "Mark as Restored" feature is record-keeping only.** It does not reinstall apps. There is no reliable way to reinstall removed system apps via sdb without a factory reset or firmware update. Be clear about this in the UI tooltip. Do not implement any reinstall attempt logic.

11. **SAWSUBE colour palette only.** Do not add new Tailwind classes not already present in the codebase. Use `style={{}}` objects with the defined palette. Match the exact visual style of `TizenBrew.tsx` — same card borders (`#1E2A35`), same background (`#0F1923`), same accent (`#C8612A`).

12. **Do not modify any existing files other than `database.py`, `main.py`, `App.tsx`, and `Sidebar.tsx`.** Everything else is additive.

---

## 14. Kick-Off Prompt for Claude Opus

Use the following prompt verbatim to begin the session in VS Code:

---

> I have a self-hosted web app called SAWSUBE (repo: WB2024/SAWSUBE) for managing art on a Samsung Frame TV. It uses a FastAPI Python backend and a React/TypeScript/Tailwind frontend. I have already implemented a TizenBrew integration feature that handles sdb connections, Tizen tool detection, WebSocket progress streaming, and async subprocess execution.
>
> I now need you to implement a **Samsung TV Debloat Utility** — a new feature that lets users scan their Samsung TV for installed bloatware and remove it safely, all from within the SAWSUBE web UI. No terminal required.
>
> Here is the full developer specification:
>
> [PASTE THE ENTIRE SPEC ABOVE HERE]
>
> Before writing any code, please:
> 1. Read and summarise your understanding of the **existing** SAWSUBE codebase — specifically: how `tizenbrew_service.py` works, what `run_command()` does, how the WebSocket broadcasting works (`ws_manager`), how the DB models and sessions work, and how the `JobStarted` pattern is used for long-running operations.
> 2. Confirm that you understand the **import relationship**: `debloat_service.py` must import and reuse `tizenbrew_service` rather than reimplementing subprocess handling.
> 3. List every file you will create or modify, in the exact order you will tackle them.
> 4. Ask any clarifying questions BEFORE writing code.
>
> Once I confirm your plan, implement everything file-by-file in this order:
> 1. `backend/data/tizen_apps.json`
> 2. `backend/models/debloat.py`
> 3. `backend/schemas_debloat.py`
> 4. `backend/services/debloat_service.py`
> 5. `backend/routers/debloat.py`
> 6. `backend/database.py` (modify)
> 7. `backend/main.py` (modify)
> 8. `frontend/src/pages/Debloat.tsx`
> 9. `frontend/src/App.tsx` (modify)
> 10. `frontend/src/components/Sidebar.tsx` (modify)
>
> For every file: write it completely — no placeholders, no `# TODO`, no truncated sections. Every function must be fully implemented.
>
> Strictly follow the existing code style:
> - Backend: `async def`, `asyncio.create_subprocess_exec` via `run_command()`, `Depends(get_session)`, `HTTPException` with descriptive `detail`, `asyncio.create_task()` for long ops
> - Frontend: `useState`/`useEffect` only, `api.get<Type>()` / `api.post<Type>()`, `useToast()`, `useWS()`, inline `style={{}}` with palette `#0F1923 / #C8612A / #F4F1ED / #1E2A35 / #4A7C5F / #A33228 / #C49A3C`
>
> Do not install any new backend Python packages. Do not install any new frontend npm packages.

---

That's the complete spec. A few things worth noting before you hand this to Claude:

- **The scan step is the most variable** — Samsung firmware versions differ quite a bit in how `vd_appmanage list` formats its output. The spec tells Claude to write a tolerant parser, but your Frame TV's actual output may require a tweak. If the scan returns 0 apps, check the raw sdb output in the SAWSUBE backend logs first.
- **The `tizen_apps.json` database will grow over time** — it's designed to be a plain JSON file you can easily edit or extend without touching any code. Once the feature is live, you can add entries as you discover new package IDs.
- **Firmware updates can reinstall removed apps** — this is an inherent Samsung limitation and there's nothing SAWSUBE can do about it. The removal log means you'll always know what to remove again if that happens.
