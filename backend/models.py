"""Pydantic models for Python Script Manager."""
from pydantic import BaseModel, Field
from typing import Optional, List, Dict
from datetime import datetime, timezone
import uuid


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class EnvVar(BaseModel):
    key: str
    value: str


class Project(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    root_dir: str  # relative path inside WORKSPACE_DIR
    start_script: str  # relative path inside root_dir (e.g., "main.py")
    python_version: str = "3.12"
    args: str = ""  # additional CLI args
    env_vars: List[EnvVar] = Field(default_factory=list)
    auto_restart_daily: bool = False
    daily_restart_hour: int = 3  # 0-23
    auto_pip_update_daily: bool = False
    venv_created: bool = False
    pid: Optional[int] = None
    status: str = "stopped"  # stopped | running | errored
    last_started_at: Optional[str] = None
    last_stopped_at: Optional[str] = None
    last_error: Optional[str] = None
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)


class ProjectCreate(BaseModel):
    name: str
    root_dir: str
    start_script: str
    args: str = ""
    env_vars: List[EnvVar] = Field(default_factory=list)
    auto_restart_daily: bool = False
    daily_restart_hour: int = 3
    auto_pip_update_daily: bool = False


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    root_dir: Optional[str] = None
    start_script: Optional[str] = None
    args: Optional[str] = None
    env_vars: Optional[List[EnvVar]] = None
    auto_restart_daily: Optional[bool] = None
    daily_restart_hour: Optional[int] = None
    auto_pip_update_daily: Optional[bool] = None


class FileNode(BaseModel):
    name: str
    path: str  # relative to WORKSPACE_DIR
    is_dir: bool
    size: int = 0
    modified: str = ""


class FileWriteRequest(BaseModel):
    path: str
    content: str


class MkdirRequest(BaseModel):
    path: str


class RenameRequest(BaseModel):
    from_path: str
    to_path: str


class DeleteRequest(BaseModel):
    path: str
