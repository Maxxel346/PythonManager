"""APScheduler wrapper. Registers a daily cron per project that has
`auto_restart_daily` enabled, optionally running `pip install --upgrade` first."""
import asyncio
import logging
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

import process_manager as pm

log = logging.getLogger("scheduler")

_scheduler: AsyncIOScheduler | None = None
_db = None


def init_scheduler(db) -> AsyncIOScheduler:
    global _scheduler, _db
    _db = db
    _scheduler = AsyncIOScheduler(timezone="UTC")
    _scheduler.start()
    return _scheduler


def _job_id(project_id: str) -> str:
    return f"daily-restart-{project_id}"


async def _daily_restart_job(project_id: str) -> None:
    if _db is None:
        return
    doc = await _db.projects.find_one({"id": project_id}, {"_id": 0})
    if not doc:
        return
    log.info(f"[scheduler] daily restart for {doc.get('name')} ({project_id})")
    try:
        if pm.is_running(project_id, doc.get("pid")):
            pm.stop_project(project_id, doc.get("pid"))
        if doc.get("auto_pip_update_daily"):
            pm.pip_install(doc["root_dir"], project_id, upgrade=True)
        pid = pm.start_project(doc)
        await _db.projects.update_one(
            {"id": project_id},
            {"$set": {"pid": pid, "status": "running", "last_error": None}},
        )
    except Exception as e:
        log.exception("scheduled restart failed")
        await _db.projects.update_one(
            {"id": project_id},
            {"$set": {"status": "errored", "last_error": f"scheduled restart: {e}"}},
        )


def register_project_schedule(project: dict) -> None:
    if _scheduler is None:
        return
    jid = _job_id(project["id"])
    existing = _scheduler.get_job(jid)
    if existing:
        _scheduler.remove_job(jid)
    if project.get("auto_restart_daily"):
        hour = int(project.get("daily_restart_hour") or 3)
        _scheduler.add_job(
            _daily_restart_job,
            trigger=CronTrigger(hour=hour, minute=0),
            args=[project["id"]],
            id=jid,
            replace_existing=True,
        )


def unregister_project_schedule(project_id: str) -> None:
    if _scheduler is None:
        return
    jid = _job_id(project_id)
    if _scheduler.get_job(jid):
        _scheduler.remove_job(jid)


async def load_all_schedules() -> None:
    if _db is None:
        return
    async for doc in _db.projects.find({}, {"_id": 0}):
        register_project_schedule(doc)
