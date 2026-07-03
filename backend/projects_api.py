"""Projects CRUD + control endpoints."""
from fastapi import APIRouter, Depends, HTTPException, Request
from typing import List
from datetime import datetime, timezone

from auth import get_current_user
from models import Project, ProjectCreate, ProjectUpdate
import process_manager as pm


router = APIRouter(prefix="/api/projects", tags=["projects"])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _fetch_project(db, project_id: str) -> dict:
    doc = await db.projects.find_one({"id": project_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Project not found")
    return doc


@router.get("", response_model=List[Project])
async def list_projects(request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    docs = await db.projects.find({}, {"_id": 0}).to_list(500)
    for d in docs:
        running = pm.is_running(d["id"], d.get("pid"))
        if running and d.get("status") != "running":
            d["status"] = "running"
        elif not running and d.get("status") == "running":
            d["status"] = "stopped"
            d["pid"] = None
            await db.projects.update_one({"id": d["id"]}, {"$set": {"status": "stopped", "pid": None}})
    return docs


@router.post("", response_model=Project)
async def create_project(body: ProjectCreate, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    project = Project(
        name=body.name,
        root_dir=body.root_dir,
        start_script=body.start_script,
        args=body.args,
        env_vars=body.env_vars,
        auto_restart_daily=body.auto_restart_daily,
        daily_restart_hour=body.daily_restart_hour,
        auto_pip_update_daily=body.auto_pip_update_daily,
        schedule_type=body.schedule_type,
        cron_expression=body.cron_expression,
        auto_restart_on_crash=body.auto_restart_on_crash,
        max_restarts=body.max_restarts,
        restart_backoff_seconds=body.restart_backoff_seconds,
    )
    doc = project.model_dump()
    await db.projects.insert_one(doc)
    from scheduler import register_project_schedule
    register_project_schedule(doc)
    return doc


@router.get("/{project_id}", response_model=Project)
async def get_project(project_id: str, request: Request, user=Depends(get_current_user)):
    return await _fetch_project(request.app.state.db, project_id)


@router.put("/{project_id}", response_model=Project)
async def update_project(project_id: str, body: ProjectUpdate, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    doc = await _fetch_project(db, project_id)
    updates = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if "env_vars" in updates:
        updates["env_vars"] = [ev if isinstance(ev, dict) else ev.model_dump() for ev in updates["env_vars"]]
    updates["updated_at"] = _now()
    await db.projects.update_one({"id": project_id}, {"$set": updates})
    doc.update(updates)
    from scheduler import register_project_schedule
    register_project_schedule(doc)
    return doc


@router.delete("/{project_id}")
async def delete_project(project_id: str, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    doc = await _fetch_project(db, project_id)
    if pm.is_running(project_id, doc.get("pid")):
        pm.stop_project(project_id, doc.get("pid"))
    await db.projects.delete_one({"id": project_id})
    from scheduler import unregister_project_schedule
    unregister_project_schedule(project_id)
    return {"ok": True}


@router.post("/{project_id}/start")
async def start_project_endpoint(project_id: str, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    doc = await _fetch_project(db, project_id)
    try:
        pid = pm.start_project(doc)
    except Exception as e:
        await db.projects.update_one({"id": project_id}, {"$set": {"status": "errored", "last_error": str(e)}})
        raise HTTPException(status_code=400, detail=str(e))
    await db.projects.update_one(
        {"id": project_id},
        {"$set": {"pid": pid, "status": "running", "last_started_at": _now(), "last_error": None, "restart_count": 0}},
    )
    return {"ok": True, "pid": pid}


@router.post("/{project_id}/stop")
async def stop_project_endpoint(project_id: str, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    doc = await _fetch_project(db, project_id)
    stopped = pm.stop_project(project_id, doc.get("pid"))
    await db.projects.update_one(
        {"id": project_id},
        {"$set": {"pid": None, "status": "stopped", "last_stopped_at": _now()}},
    )
    return {"ok": True, "was_running": stopped}


@router.post("/{project_id}/restart")
async def restart_project_endpoint(project_id: str, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    doc = await _fetch_project(db, project_id)
    if pm.is_running(project_id, doc.get("pid")):
        pm.stop_project(project_id, doc.get("pid"))
    try:
        pid = pm.start_project(doc)
    except Exception as e:
        await db.projects.update_one({"id": project_id}, {"$set": {"status": "errored", "last_error": str(e), "pid": None}})
        raise HTTPException(status_code=400, detail=str(e))
    await db.projects.update_one(
        {"id": project_id},
        {"$set": {"pid": pid, "status": "running", "last_started_at": _now(), "last_error": None, "restart_count": 0}},
    )
    return {"ok": True, "pid": pid}


@router.post("/{project_id}/install")
async def install_project(project_id: str, request: Request, upgrade: bool = False, user=Depends(get_current_user)):
    db = request.app.state.db
    doc = await _fetch_project(db, project_id)
    try:
        result = pm.pip_install(doc["root_dir"], project_id, upgrade=upgrade)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    await db.projects.update_one({"id": project_id}, {"$set": {"venv_created": True}})
    return result


@router.post("/{project_id}/venv")
async def create_venv_endpoint(project_id: str, request: Request, user=Depends(get_current_user)):
    db = request.app.state.db
    doc = await _fetch_project(db, project_id)
    try:
        vdir = pm.create_venv(doc["root_dir"], project_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    await db.projects.update_one({"id": project_id}, {"$set": {"venv_created": True}})
    return {"ok": True, "venv_dir": str(vdir)}


@router.get("/{project_id}/logs")
async def get_logs(project_id: str, request: Request, lines: int = 500, user=Depends(get_current_user)):
    await _fetch_project(request.app.state.db, project_id)
    return {"content": pm.read_log_tail(project_id, lines=lines)}


@router.post("/{project_id}/logs/clear")
async def clear_logs(project_id: str, request: Request, user=Depends(get_current_user)):
    await _fetch_project(request.app.state.db, project_id)
    pm.clear_log(project_id)
    return {"ok": True}


@router.get("/{project_id}/stats")
async def get_stats(project_id: str, request: Request, user=Depends(get_current_user)):
    doc = await _fetch_project(request.app.state.db, project_id)
    return pm.project_stats(project_id, doc.get("pid"))
