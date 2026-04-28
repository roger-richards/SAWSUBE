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
    app_name: Mapped[str] = mapped_column(String(256))
    category: Mapped[str | None] = mapped_column(String(128), nullable=True)
    removed_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    success: Mapped[bool] = mapped_column(Boolean, default=False)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    sdb_output: Mapped[str | None] = mapped_column(Text, nullable=True)
    restored_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
