"""Manages subprocesses for user scripts. In-memory PID registry, log files on disk."""
import os
import signal
import subprocess
import sys
import venv
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional, Dict
import psutil


def workspace_root() -> Path:
    return Path(os.environ["WORKSPACE_DIR"]).resolve()


def logs_dir() -> Path:
    d = workspace_root() / ".logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def venv_dir_for(project_id: str, project_root: Path) -> Path:
    return project_root / ".venv"


def venv_python(venv_dir: Path) -> Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def venv_pip(venv_dir: Path) -> Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / "pip.exe"
    return venv_dir / "bin" / "pip"


def project_log_path(project_id: str) -> Path:
    return logs_dir() / f"{project_id}.log"


# In-memory { project_id -> subprocess.Popen }
_processes: Dict[str, subprocess.Popen] = {}
# In-memory { project_id -> start_time_epoch }
_start_times: Dict[str, float] = {}


def is_running(project_id: str, pid: Optional[int]) -> bool:
    proc = _processes.get(project_id)
    if proc and proc.poll() is None:
        return True
    if pid and psutil.pid_exists(pid):
        try:
            p = psutil.Process(pid)
            if p.status() != psutil.STATUS_ZOMBIE:
                return True
        except psutil.Error:
            return False
    return False


def _resolve_root(root_dir: str) -> Path:
    p = (workspace_root() / root_dir.lstrip("/")).resolve()
    if workspace_root() not in p.parents and p != workspace_root():
        raise ValueError("root_dir escapes workspace")
    if not p.exists() or not p.is_dir():
        raise ValueError(f"root_dir does not exist: {root_dir}")
    return p


def create_venv(root_dir: str, project_id: str) -> Path:
    proot = _resolve_root(root_dir)
    vdir = venv_dir_for(project_id, proot)
    if not vdir.exists():
        # Prefer system python 3.12 if available for compatibility
        python_bin = os.environ.get("PYTHON_BIN", sys.executable)
        try:
            subprocess.run(
                [python_bin, "-m", "venv", str(vdir)],
                check=True, capture_output=True, text=True,
            )
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"venv creation failed: {e.stderr or e.stdout}")
    return vdir


def pip_install(root_dir: str, project_id: str, upgrade: bool = False) -> dict:
    proot = _resolve_root(root_dir)
    vdir = venv_dir_for(project_id, proot)
    if not vdir.exists():
        create_venv(root_dir, project_id)
    pip = venv_pip(vdir)
    req = proot / "requirements.txt"
    log = project_log_path(project_id)
    with log.open("a", encoding="utf-8") as lf:
        lf.write(f"\n[{datetime.now(timezone.utc).isoformat()}] === pip install (upgrade={upgrade}) ===\n")
    # Always upgrade pip itself first
    subprocess.run([str(pip), "install", "--upgrade", "pip"], capture_output=True, text=True)
    if req.exists():
        args = [str(pip), "install", "-r", str(req)]
        if upgrade:
            args.append("--upgrade")
        result = subprocess.run(args, capture_output=True, text=True, cwd=str(proot))
    else:
        result = subprocess.run([str(pip), "list"], capture_output=True, text=True, cwd=str(proot))
    with log.open("a", encoding="utf-8") as lf:
        lf.write(result.stdout or "")
        if result.stderr:
            lf.write("\n[stderr]\n" + result.stderr)
    return {"returncode": result.returncode, "stdout_tail": (result.stdout or "")[-1000:], "stderr_tail": (result.stderr or "")[-1000:]}


def start_project(project: dict) -> int:
    project_id = project["id"]
    if is_running(project_id, project.get("pid")):
        raise RuntimeError("Project already running")
    proot = _resolve_root(project["root_dir"])
    vdir = venv_dir_for(project_id, proot)
    if not vdir.exists():
        create_venv(project["root_dir"], project_id)
    python_exe = venv_python(vdir)
    start_script = proot / project["start_script"].lstrip("/")
    if not start_script.exists():
        raise RuntimeError(f"Start script not found: {project['start_script']}")

    env = os.environ.copy()
    for ev in project.get("env_vars", []) or []:
        env[ev["key"]] = ev["value"]
    env["PYTHONUNBUFFERED"] = "1"

    args_str = (project.get("args") or "").strip()
    extra_args = args_str.split() if args_str else []

    log = project_log_path(project_id)
    with log.open("a", encoding="utf-8") as lf:
        lf.write(f"\n[{datetime.now(timezone.utc).isoformat()}] === start {project['name']} ===\n")
    log_fh = log.open("ab")
    proc = subprocess.Popen(
        [str(python_exe), "-u", str(start_script), *extra_args],
        cwd=str(proot),
        env=env,
        stdout=log_fh,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    _processes[project_id] = proc
    return proc.pid


def stop_project(project_id: str, pid: Optional[int]) -> bool:
    proc = _processes.get(project_id)
    target_pid = None
    if proc and proc.poll() is None:
        target_pid = proc.pid
    elif pid and psutil.pid_exists(pid):
        target_pid = pid
    if not target_pid:
        _processes.pop(project_id, None)
        return False
    try:
        try:
            os.killpg(os.getpgid(target_pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            os.kill(target_pid, signal.SIGTERM)
        try:
            psutil.Process(target_pid).wait(timeout=8)
        except (psutil.TimeoutExpired, psutil.NoSuchProcess):
            try:
                os.killpg(os.getpgid(target_pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                try:
                    os.kill(target_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
    finally:
        _processes.pop(project_id, None)
        _start_times.pop(project_id, None)
        log = project_log_path(project_id)
        with log.open("a", encoding="utf-8") as lf:
            lf.write(f"\n[{datetime.now(timezone.utc).isoformat()}] === stopped ===\n")
    return True


def uptime_seconds(project_id: str) -> float:
    import time as _time
    ts = _start_times.get(project_id)
    if not ts:
        return 0.0
    return _time.time() - ts


def append_log(project_id: str, message: str) -> None:
    log = project_log_path(project_id)
    with log.open("a", encoding="utf-8") as lf:
        lf.write(message if message.endswith("\n") else message + "\n")


def read_log_tail(project_id: str, lines: int = 500) -> str:
    log = project_log_path(project_id)
    if not log.exists():
        return ""
    try:
        with log.open("rb") as f:
            f.seek(0, 2)
            size = f.tell()
            block = 8192
            data = b""
            while size > 0 and data.count(b"\n") <= lines:
                read_size = min(block, size)
                size -= read_size
                f.seek(size)
                data = f.read(read_size) + data
                if size == 0:
                    break
        text = data.decode("utf-8", errors="replace")
        tail = "\n".join(text.splitlines()[-lines:])
        return tail
    except OSError:
        return ""


def clear_log(project_id: str) -> None:
    log = project_log_path(project_id)
    log.write_text("", encoding="utf-8")


def project_stats(project_id: str, pid: Optional[int]) -> dict:
    proc = _processes.get(project_id)
    target_pid = None
    if proc and proc.poll() is None:
        target_pid = proc.pid
    elif pid and psutil.pid_exists(pid):
        target_pid = pid
    if not target_pid:
        return {"running": False, "cpu_percent": 0.0, "memory_mb": 0.0, "pid": None}
    try:
        p = psutil.Process(target_pid)
        with p.oneshot():
            cpu = p.cpu_percent(interval=0.1)
            mem = p.memory_info().rss / (1024 * 1024)
        return {"running": True, "cpu_percent": round(cpu, 1), "memory_mb": round(mem, 1), "pid": target_pid}
    except psutil.Error:
        return {"running": False, "cpu_percent": 0.0, "memory_mb": 0.0, "pid": None}


def system_stats() -> dict:
    return {
        "cpu_percent": psutil.cpu_percent(interval=0.1),
        "memory_percent": psutil.virtual_memory().percent,
        "disk_percent": psutil.disk_usage(str(workspace_root())).percent,
    }
