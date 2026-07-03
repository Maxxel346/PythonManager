"""WebSocket handler for live log streaming."""
import asyncio
import os
from pathlib import Path
from fastapi import WebSocket, WebSocketDisconnect, status

from auth import decode_token
import process_manager as pm


async def ws_logs(websocket: WebSocket, project_id: str) -> None:
    # Auth via query param since browsers can't set Authorization on ws
    # Auth via query param since browsers can't set Authorization on ws
    token = websocket.query_params.get("token", "")
    if not token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    try:
        decode_token(token)
    except Exception:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    db = websocket.app.state.db
    doc = await db.projects.find_one({"id": project_id}, {"_id": 0, "id": 1})
    if not doc:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()

    log_path = pm.project_log_path(project_id)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.touch(exist_ok=True)

    # Send initial tail (last ~500 lines)
    try:
        initial = pm.read_log_tail(project_id, lines=500)
        if initial:
            await websocket.send_text(initial + ("\n" if not initial.endswith("\n") else ""))
    except Exception:
        pass

    # Then tail -f
    offset = log_path.stat().st_size
    try:
        while True:
            try:
                size = log_path.stat().st_size
            except FileNotFoundError:
                size = 0
                log_path.touch()
            if size < offset:
                # File was truncated (log cleared) — reset
                offset = 0
                try:
                    await websocket.send_text("\n[log cleared]\n")
                except Exception:
                    break
            if size > offset:
                try:
                    with log_path.open("rb") as f:
                        f.seek(offset)
                        chunk = f.read(size - offset)
                    offset = size
                    text = chunk.decode("utf-8", errors="replace")
                    if text:
                        await websocket.send_text(text)
                except Exception:
                    pass
            # Client alive check via a lightweight sleep + poll
            try:
                await asyncio.wait_for(_ping_check(websocket), timeout=1.0)
            except asyncio.TimeoutError:
                pass
            except WebSocketDisconnect:
                break
    except WebSocketDisconnect:
        return
    except Exception:
        try:
            await websocket.close()
        except Exception:
            pass


async def _ping_check(ws: WebSocket) -> None:
    # allow client-initiated messages to be received; ignore content
    try:
        await ws.receive_text()
        return
    except WebSocketDisconnect:
        raise
