"""
PyScript Manager
A lightweight web app to manage many independent Python scripts/projects:
- Google-Drive-like file browser (upload/download files & folders)
- Per-project virtualenv, start/stop/restart, live logs
- Daily scheduled restarts and/or pip upgrades per project
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

try:
    import psutil
except ImportError:  # pragma: no cover
    psutil = None

# --------------------------------------------------------------------------
# Paths / storage
# --------------------------------------------------------------------------
DATA_DIR = Path(os.environ.get("PSM_DATA_DIR", "/app/data")).resolve()
WORKSPACE_ROOT = DATA_DIR / "workspace"
LOGS_DIR = DATA_DIR / "logs"
PROJECTS_FILE = DATA_DIR / "projects.json"
STATE_FILE = DATA_DIR / "state.json"

for d in (DATA_DIR, WORKSPACE_ROOT, LOGS_DIR):
    d.mkdir(parents=True, exist_ok=True)

_lock = Lock()


def _load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        with open(path, "r") as f:
            return json.load(f)
    except Exception:
        return default


def _save_json(path: Path, data):
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    tmp.replace(path)


def load_projects() -> dict:
    return _load_json(PROJECTS_FILE, {})


def save_projects(projects: dict):
    _save_json(PROJECTS_FILE, projects)


def load_state() -> dict:
    return _load_json(STATE_FILE, {})


def save_state(state: dict):
    _save_json(STATE_FILE, state)


# --------------------------------------------------------------------------
# File manager helpers (all paths are relative to WORKSPACE_ROOT)
# --------------------------------------------------------------------------
def safe_path(rel: str) -> Path:
    rel = (rel or "").strip().lstrip("/")
    p = (WORKSPACE_ROOT / rel).resolve()
    if p != WORKSPACE_ROOT and WORKSPACE_ROOT not in p.parents:
        raise HTTPException(400, "Invalid path")
    return p


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}PB"


# --------------------------------------------------------------------------
# Process manager
# --------------------------------------------------------------------------
class ProcessManager:
    def __init__(self):
        self._procs: dict[str, subprocess.Popen] = {}
        self._lock = Lock()

    # -- venv -------------------------------------------------------
    @staticmethod
    def venv_dir(root_dir: Path) -> Path:
        return root_dir / ".venv"

    @staticmethod
    def venv_python(root_dir: Path) -> Path:
        return ProcessManager.venv_dir(root_dir) / "bin" / "python"

    @staticmethod
    def venv_pip(root_dir: Path) -> Path:
        return ProcessManager.venv_dir(root_dir) / "bin" / "pip"

    def ensure_venv(self, project: dict, log_path: Path) -> tuple[bool, str]:
        root_dir = Path(project["root_dir"])
        vpy = self.venv_python(root_dir)
        out = []
        if not vpy.exists():
            out.append(f"Creating venv at {self.venv_dir(root_dir)} ...")
            r = subprocess.run(
                [sys.executable, "-m", "venv", str(self.venv_dir(root_dir))],
                capture_output=True, text=True,
            )
            out.append(r.stdout + r.stderr)
            if r.returncode != 0:
                return False, "\n".join(out)
        req = root_dir / project.get("requirements_file", "requirements.txt")
        if req.exists():
            out.append(f"Installing requirements from {req.name} ...")
            r = subprocess.run(
                [str(self.venv_pip(root_dir)), "install", "-r", str(req)],
                capture_output=True, text=True,
            )
            out.append(r.stdout + r.stderr)
            if r.returncode != 0:
                return False, "\n".join(out)
        with open(log_path, "a") as f:
            f.write(f"\n----- [setup {datetime.now().isoformat(timespec='seconds')}] -----\n")
            f.write("\n".join(out) + "\n")
        return True, "\n".join(out)

    def pip_update(self, project: dict, log_path: Path) -> tuple[bool, str]:
        root_dir = Path(project["root_dir"])
        vpip = self.venv_pip(root_dir)
        if not vpip.exists():
            return self.ensure_venv(project, log_path)
        req = root_dir / project.get("requirements_file", "requirements.txt")
        cmd = [str(vpip), "install", "--upgrade"]
        cmd += ["-r", str(req)] if req.exists() else ["pip"]
        r = subprocess.run(cmd, capture_output=True, text=True)
        with open(log_path, "a") as f:
            f.write(f"\n----- [pip-update {datetime.now().isoformat(timespec='seconds')}] -----\n")
            f.write(r.stdout + r.stderr + "\n")
        return r.returncode == 0, r.stdout + r.stderr

    # -- lifecycle ----------------------------------------------------
    def is_running(self, project_id: str) -> Optional[int]:
        """Return pid if running, else None. Works even across app restarts."""
        with self._lock:
            proc = self._procs.get(project_id)
        if proc is not None:
            if proc.poll() is None:
                return proc.pid
            return None
        # fall back to persisted state (app restarted)
        state = load_state().get(project_id)
        if not state:
            return None
        pid = state.get("pid")
        if not pid:
            return None
        if psutil and psutil.pid_exists(pid):
            try:
                p = psutil.Process(pid)
                if state.get("marker", "") in " ".join(p.cmdline()):
                    return pid
            except Exception:
                return None
        elif not psutil:
            try:
                os.kill(pid, 0)
                return pid
            except OSError:
                return None
        return None

    def start(self, project: dict) -> tuple[bool, str]:
        pid_running = self.is_running(project["id"])
        if pid_running:
            return False, f"Already running (pid {pid_running})"
        root_dir = Path(project["root_dir"])
        script = root_dir / project["start_script"]
        if not script.exists():
            return False, f"Start script not found: {script}"
        log_path = LOGS_DIR / f"{project['id']}.log"

        ok, msg = self.ensure_venv(project, log_path)
        if not ok:
            return False, f"Setup failed:\n{msg}"

        vpy = self.venv_python(root_dir)
        cmd = [str(vpy), str(script)] + project.get("args", [])
        env = os.environ.copy()
        env.update(project.get("env_vars", {}))
        marker = f"psm-project:{project['id']}"
        env["PSM_PROJECT_MARKER"] = marker

        with open(log_path, "a") as logf:
            logf.write(f"\n===== [start {datetime.now().isoformat(timespec='seconds')}] {' '.join(cmd)} =====\n")
            logf.flush()
            try:
                proc = subprocess.Popen(
                    cmd, cwd=str(root_dir), env=env,
                    stdout=logf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                    start_new_session=True,
                )
            except Exception as e:
                return False, f"Failed to launch: {e}"

        with self._lock:
            self._procs[project["id"]] = proc
        state = load_state()
        state[project["id"]] = {
            "pid": proc.pid, "started_at": datetime.now().isoformat(),
            "marker": marker,
        }
        save_state(state)
        return True, f"Started (pid {proc.pid})"

    def stop(self, project_id: str, timeout: float = 8.0) -> tuple[bool, str]:
        with self._lock:
            proc = self._procs.get(project_id)
        pid = proc.pid if proc else None
        if pid is None:
            state = load_state().get(project_id)
            pid = state.get("pid") if state else None
        if not pid:
            return False, "Not running"
        try:
            pgid = os.getpgid(pid)
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except PermissionError:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not self._pid_alive(pid):
                break
            time.sleep(0.3)
        if self._pid_alive(pid):
            try:
                pgid = os.getpgid(pid)
                os.killpg(pgid, signal.SIGKILL)
            except Exception:
                try:
                    os.kill(pid, signal.SIGKILL)
                except Exception:
                    pass
        with self._lock:
            self._procs.pop(project_id, None)
        state = load_state()
        state.pop(project_id, None)
        save_state(state)
        return True, "Stopped"

    @staticmethod
    def _pid_alive(pid: int) -> bool:
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def restart(self, project: dict) -> tuple[bool, str]:
        if self.is_running(project["id"]):
            self.stop(project["id"])
        return self.start(project)


PM = ProcessManager()

# --------------------------------------------------------------------------
# Scheduler
# --------------------------------------------------------------------------
scheduler = BackgroundScheduler()


def _job_restart(project_id: str):
    projects = load_projects()
    project = projects.get(project_id)
    if project:
        PM.restart(project)


def _job_pip_update(project_id: str):
    projects = load_projects()
    project = projects.get(project_id)
    if not project:
        return
    was_running = bool(PM.is_running(project_id))
    if was_running:
        PM.stop(project_id)
    log_path = LOGS_DIR / f"{project_id}.log"
    PM.pip_update(project, log_path)
    if was_running or project.get("auto_restart"):
        PM.start(project)


def reschedule_all():
    for job in list(scheduler.get_jobs()):
        job.remove()
    projects = load_projects()
    for pid, project in projects.items():
        if project.get("auto_restart"):
            hh, mm = (project.get("restart_time") or "03:00").split(":")
            scheduler.add_job(
                _job_restart, CronTrigger(hour=int(hh), minute=int(mm)),
                args=[pid], id=f"restart-{pid}", replace_existing=True,
            )
        if project.get("pip_update"):
            hh, mm = (project.get("pip_update_time") or "03:30").split(":")
            scheduler.add_job(
                _job_pip_update, CronTrigger(hour=int(hh), minute=int(mm)),
                args=[pid], id=f"pipupdate-{pid}", replace_existing=True,
            )


# --------------------------------------------------------------------------
# FastAPI app
# --------------------------------------------------------------------------
app = FastAPI(title="PyScript Manager")


@app.on_event("startup")
def _startup():
    scheduler.start()
    reschedule_all()


@app.on_event("shutdown")
def _shutdown():
    scheduler.shutdown(wait=False)


# ---------------------------- Files API -----------------------------------
@app.get("/api/files")
def list_files(path: str = ""):
    base = safe_path(path)
    if not base.exists():
        raise HTTPException(404, "Path not found")
    if base.is_file():
        raise HTTPException(400, "Not a directory")
    items = []
    for entry in sorted(base.iterdir(), key=lambda e: (e.is_file(), e.name.lower())):
        st = entry.stat()
        items.append({
            "name": entry.name,
            "path": str(entry.relative_to(WORKSPACE_ROOT)),
            "is_dir": entry.is_dir(),
            "size": st.st_size if entry.is_file() else None,
            "size_human": human_size(st.st_size) if entry.is_file() else None,
            "modified": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
        })
    return {"path": path, "items": items}


@app.post("/api/files/mkdir")
def mkdir(path: str = Form(""), name: str = Form(...)):
    base = safe_path(path)
    target = base / name
    if WORKSPACE_ROOT not in target.resolve().parents and target.resolve() != WORKSPACE_ROOT:
        raise HTTPException(400, "Invalid path")
    target.mkdir(parents=True, exist_ok=True)
    return {"ok": True}


@app.post("/api/files/upload-files")
async def upload_files(
    path: str = Form(""),
    files: list[UploadFile] = File(...),
    relpaths: list[str] = Form(default=None),
):
    base = safe_path(path)
    base.mkdir(parents=True, exist_ok=True)
    saved = []
    rels = relpaths or [f.filename for f in files]
    for f, rel in zip(files, rels):
        rel = rel.lstrip("/")
        dest = (base / rel).resolve()
        if WORKSPACE_ROOT not in dest.parents:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(dest, "wb") as out:
            shutil.copyfileobj(f.file, out)
        saved.append(str(dest.relative_to(WORKSPACE_ROOT)))
    return {"ok": True, "saved": saved}


@app.post("/api/files/upload-zip")
async def upload_zip(path: str = Form(""), file: UploadFile = File(...), extract: bool = Form(True)):
    base = safe_path(path)
    base.mkdir(parents=True, exist_ok=True)
    tmp_zip = base / f"__upload_{uuid.uuid4().hex}.zip"
    with open(tmp_zip, "wb") as out:
        shutil.copyfileobj(file.file, out)
    try:
        if extract:
            with zipfile.ZipFile(tmp_zip) as zf:
                for member in zf.namelist():
                    dest = (base / member).resolve()
                    if WORKSPACE_ROOT not in dest.parents and dest != WORKSPACE_ROOT:
                        continue
                zf.extractall(base)
            tmp_zip.unlink()
        else:
            tmp_zip.rename(base / file.filename)
    except zipfile.BadZipFile:
        tmp_zip.unlink(missing_ok=True)
        raise HTTPException(400, "Invalid zip file")
    return {"ok": True}


@app.get("/api/files/download")
def download(path: str = Query(...)):
    target = safe_path(path)
    if not target.exists():
        raise HTTPException(404, "Not found")
    if target.is_file():
        return FileResponse(target, filename=target.name)
    # zip a directory on the fly into a temp file
    SKIP_DIRS = {".venv", "__pycache__", ".git"}
    tmp_dir = Path(tempfile.mkdtemp())
    zip_path = tmp_dir / f"{target.name}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(target):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for fn in files:
                fp = Path(root) / fn
                zf.write(fp, fp.relative_to(target.parent))

    def cleanup_iter():
        with open(zip_path, "rb") as f:
            yield from f
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return StreamingResponse(
        cleanup_iter(), media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{target.name}.zip"'},
    )


@app.post("/api/files/delete")
def delete_path(path: str = Form(...)):
    target = safe_path(path)
    if target == WORKSPACE_ROOT:
        raise HTTPException(400, "Cannot delete workspace root")
    if target.is_dir():
        shutil.rmtree(target)
    elif target.exists():
        target.unlink()
    return {"ok": True}


@app.post("/api/files/rename")
def rename_path(path: str = Form(...), new_name: str = Form(...)):
    target = safe_path(path)
    dest = target.parent / new_name
    if WORKSPACE_ROOT not in dest.resolve().parents:
        raise HTTPException(400, "Invalid name")
    target.rename(dest)
    return {"ok": True, "path": str(dest.relative_to(WORKSPACE_ROOT))}


# ---------------------------- Projects API ---------------------------------
@app.get("/api/projects")
def list_projects():
    projects = load_projects()
    out = []
    for pid, p in projects.items():
        running_pid = PM.is_running(pid)
        out.append({**p, "running": bool(running_pid), "pid": running_pid})
    out.sort(key=lambda p: p["name"].lower())
    return out


@app.post("/api/projects")
def create_project(payload: dict):
    name = payload.get("name", "").strip()
    root_dir = payload.get("root_dir", "").strip()
    start_script = payload.get("start_script", "").strip()
    if not name or not root_dir or not start_script:
        raise HTTPException(400, "name, root_dir and start_script are required")
    abs_root = safe_path(root_dir)
    if not abs_root.exists() or not abs_root.is_dir():
        raise HTTPException(400, "root_dir does not exist")
    if not (abs_root / start_script).exists():
        raise HTTPException(400, "start_script not found inside root_dir")

    pid = uuid.uuid4().hex[:10]
    project = {
        "id": pid,
        "name": name,
        "root_dir": str(abs_root),
        "root_dir_rel": root_dir,
        "start_script": start_script,
        "requirements_file": payload.get("requirements_file") or "requirements.txt",
        "args": payload.get("args") or [],
        "env_vars": payload.get("env_vars") or {},
        "auto_restart": bool(payload.get("auto_restart", False)),
        "restart_time": payload.get("restart_time") or "03:00",
        "pip_update": bool(payload.get("pip_update", False)),
        "pip_update_time": payload.get("pip_update_time") or "03:30",
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    projects = load_projects()
    projects[pid] = project
    save_projects(projects)
    reschedule_all()
    return project


@app.put("/api/projects/{project_id}")
def update_project(project_id: str, payload: dict):
    projects = load_projects()
    project = projects.get(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    for key in (
        "name", "start_script", "requirements_file", "args", "env_vars",
        "auto_restart", "restart_time", "pip_update", "pip_update_time",
    ):
        if key in payload:
            project[key] = payload[key]
    projects[project_id] = project
    save_projects(projects)
    reschedule_all()
    return project


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str, delete_files: bool = False):
    projects = load_projects()
    project = projects.pop(project_id, None)
    if not project:
        raise HTTPException(404, "Project not found")
    if PM.is_running(project_id):
        PM.stop(project_id)
    save_projects(projects)
    reschedule_all()
    if delete_files:
        shutil.rmtree(project["root_dir"], ignore_errors=True)
    log_path = LOGS_DIR / f"{project_id}.log"
    log_path.unlink(missing_ok=True)
    return {"ok": True}


@app.post("/api/projects/{project_id}/start")
def start_project(project_id: str):
    project = load_projects().get(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    ok, msg = PM.start(project)
    return {"ok": ok, "message": msg}


@app.post("/api/projects/{project_id}/stop")
def stop_project(project_id: str):
    ok, msg = PM.stop(project_id)
    return {"ok": ok, "message": msg}


@app.post("/api/projects/{project_id}/restart")
def restart_project(project_id: str):
    project = load_projects().get(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    ok, msg = PM.restart(project)
    return {"ok": ok, "message": msg}


@app.post("/api/projects/{project_id}/setup")
def setup_project(project_id: str):
    project = load_projects().get(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    log_path = LOGS_DIR / f"{project_id}.log"
    ok, msg = PM.ensure_venv(project, log_path)
    return {"ok": ok, "message": msg}


@app.post("/api/projects/{project_id}/pip-update")
def pip_update_project(project_id: str):
    project = load_projects().get(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    log_path = LOGS_DIR / f"{project_id}.log"
    ok, msg = PM.pip_update(project, log_path)
    return {"ok": ok, "message": msg}


@app.get("/api/projects/{project_id}/status")
def project_status(project_id: str):
    project = load_projects().get(project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    pid = PM.is_running(project_id)
    state = load_state().get(project_id, {})
    return {"running": bool(pid), "pid": pid, "started_at": state.get("started_at")}


@app.get("/api/projects/{project_id}/logs")
def project_logs(project_id: str, tail: int = 300):
    log_path = LOGS_DIR / f"{project_id}.log"
    if not log_path.exists():
        return {"text": ""}
    with open(log_path, "r", errors="replace") as f:
        lines = f.readlines()
    return {"text": "".join(lines[-tail:]), "total_lines": len(lines)}


@app.post("/api/projects/{project_id}/logs/clear")
def clear_logs(project_id: str):
    log_path = LOGS_DIR / f"{project_id}.log"
    log_path.write_text("")
    return {"ok": True}


# ---------------------------- Static frontend -------------------------------
STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")
