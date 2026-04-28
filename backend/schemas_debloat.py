from __future__ import annotations
from datetime import datetime
from pydantic import BaseModel


class ScannedApp(BaseModel):
    package_id: str
    app_name: str
    description: str | None = None
    category: str = "Unknown"
    safety: str = "unknown"
    safe_to_remove: bool = True
    never_remove: bool = False
    frame_tv_warning: bool = False
    notes: str | None = None
    known: bool = False


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
    package_ids: list[str]


class RemovalResult(BaseModel):
    package_id: str
    app_name: str
    success: bool
    error: str | None = None


class BulkRemoveResponse(BaseModel):
    started: bool
    job_id: str
    count: int


class RemovalLogEntry(BaseModel):
    id: int
    tv_id: int
    package_id: str
    app_name: str
    category: str | None = None
    removed_at: datetime
    success: bool
    error_message: str | None = None
    restored_at: datetime | None = None

    class Config:
        from_attributes = True


class DebloatProgressEvent(BaseModel):
    type: str
    tv_id: int
    step: str
    package_id: str | None = None
    app_name: str | None = None
    message: str
    current: int = 0
    total: int = 0
    progress: int = 0
