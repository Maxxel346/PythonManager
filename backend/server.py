"""Python Script Manager — main FastAPI app."""
from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

import os
import logging
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, WebSocket
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient

from auth import (
    LoginRequest, LoginResponse, get_current_user,
    verify_password, create_access_token, seed_admin,
)
from files_api import router as files_router
from projects_api import router as projects_router
import scheduler
import process_manager as pm
import crash_watcher
from ws_logs import ws_logs

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("pymanager")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

app = FastAPI(title="Python Script Manager")
app.state.db = db

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

api = APIRouter(prefix="/api")


@api.get("/")
async def root():
    return {"service": "python-script-manager", "status": "ok"}


@api.post("/auth/login", response_model=LoginResponse)
async def login(body: LoginRequest):
    user = await db.users.find_one({"username": body.username})
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    token = create_access_token(user["username"])
    return LoginResponse(access_token=token, username=user["username"])


@api.get("/auth/me")
async def me(user=Depends(get_current_user)):
    return user


@api.get("/system/stats")
async def system_stats(user=Depends(get_current_user)):
    return pm.system_stats()


@api.get("/system/info")
async def system_info(user=Depends(get_current_user)):
    import sys
    import platform
    return {
        "python_version": sys.version.split()[0],
        "platform": platform.platform(),
        "workspace_dir": os.environ.get("WORKSPACE_DIR"),
    }


app.include_router(api)
app.include_router(files_router)
app.include_router(projects_router)


@app.websocket("/api/ws/logs/{project_id}")
async def logs_ws(websocket: WebSocket, project_id: str):
    await ws_logs(websocket, project_id)


@app.on_event("startup")
async def on_startup():
    Path(os.environ["WORKSPACE_DIR"]).mkdir(parents=True, exist_ok=True)
    (Path(os.environ["WORKSPACE_DIR"]) / ".logs").mkdir(parents=True, exist_ok=True)
    await db.users.create_index("username", unique=True)
    await db.projects.create_index("id", unique=True)
    await seed_admin(db)
    scheduler.init_scheduler(db)
    await scheduler.load_all_schedules()
    crash_watcher.init_crash_watcher(db)
    logger.info("Python Script Manager started")


@app.on_event("shutdown")
async def on_shutdown():
    client.close()
