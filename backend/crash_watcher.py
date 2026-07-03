"""Background asyncio task that watches all projects and auto-restarts
those that crashed if they have `auto_restart_on_crash` enabled."""
import asyncio
import logging
from datetime import datetime, timezone

import process_manager as pm

log = logging.getLogger("crash_watcher")

CHECK_INTERVAL_SECONDS = 5
# Uptime threshold after which we reset the restart counter (process has been
# alive long enough that we don't consider it "flapping" anymore).
UPTIME_STABILITY_SECONDS = 60


class CrashWatcher:
    def __init__(self, db):
        self.db = db
        self._task: asyncio.Task | None = None
        self._stop = False
        # in-memory { project_id -> pending_backoff_deadline_epoch }
        self._backoff_until: dict[str, float] = {}

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._loop(), name="crash-watcher")

    def stop(self) -> None:
        self._stop = True
        if self._task:
            self._task.cancel()

    async def _loop(self) -> None:
        log.info("crash watcher started")
        while not self._stop:
            try:
                await self._tick()
            except asyncio.CancelledError:
                break
            except Exception:
                log.exception("crash watcher tick failed")
            await asyncio.sleep(CHECK_INTERVAL_SECONDS)

    async def _tick(self) -> None:
        import time as _time
        now = _time.time()
        # only look at projects marked status=running (i.e., user started them)
        async for doc in self.db.projects.find({"status": "running"}, {"_id": 0}):
            pid = doc.get("pid")
            running = pm.is_running(doc["id"], pid)
            uptime = pm.uptime_seconds(doc["id"])
            if running:
                # reset restart_count once the process has been up long enough
                if doc.get("restart_count", 0) > 0 and uptime > UPTIME_STABILITY_SECONDS:
                    await self.db.projects.update_one(
                        {"id": doc["id"]}, {"$set": {"restart_count": 0}}
                    )
                continue
            # crashed
            if not doc.get("auto_restart_on_crash"):
                # mark as errored / stopped
                await self.db.projects.update_one(
                    {"id": doc["id"]},
                    {"$set": {"status": "stopped", "pid": None,
                              "last_stopped_at": datetime.now(timezone.utc).isoformat()}},
                )
                continue
            # backoff gate
            deadline = self._backoff_until.get(doc["id"], 0)
            if deadline and now < deadline:
                continue
            max_r = int(doc.get("max_restarts") or 0)
            count = int(doc.get("restart_count") or 0)
            if max_r > 0 and count >= max_r:
                pm.append_log(doc["id"], f"[{datetime.now(timezone.utc).isoformat()}] === crash-restart limit reached ({count}/{max_r}) — giving up ===")
                await self.db.projects.update_one(
                    {"id": doc["id"]},
                    {"$set": {"status": "errored", "pid": None,
                              "last_error": f"exceeded max_restarts={max_r}",
                              "last_stopped_at": datetime.now(timezone.utc).isoformat()}},
                )
                continue
            # attempt restart
            backoff = int(doc.get("restart_backoff_seconds") or 5)
            pm.append_log(doc["id"], f"[{datetime.now(timezone.utc).isoformat()}] === crashed. auto-restart attempt {count+1}"
                                     f"{('/' + str(max_r)) if max_r else ''} after {backoff}s backoff ===")
            self._backoff_until[doc["id"]] = now + backoff
            await asyncio.sleep(backoff)
            try:
                new_pid = pm.start_project(doc)
                await self.db.projects.update_one(
                    {"id": doc["id"]},
                    {"$set": {"pid": new_pid, "status": "running",
                              "last_started_at": datetime.now(timezone.utc).isoformat(),
                              "last_error": None},
                     "$inc": {"restart_count": 1}},
                )
                self._backoff_until.pop(doc["id"], None)
            except Exception as e:
                log.exception("crash-restart failed")
                await self.db.projects.update_one(
                    {"id": doc["id"]},
                    {"$set": {"status": "errored", "last_error": f"crash-restart: {e}"}},
                )


_watcher: CrashWatcher | None = None


def init_crash_watcher(db) -> CrashWatcher:
    global _watcher
    _watcher = CrashWatcher(db)
    _watcher.start()
    return _watcher


def get_crash_watcher() -> CrashWatcher | None:
    return _watcher
