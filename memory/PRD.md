# Python Script Manager — PRD

## Original problem statement
Build a self-hosted "manager" for Python scripts running on a Debian 12 container. Requirements:

1. GDrive-like UI to upload/download files and folders
2. Base runtime Python 3.12
3. Manage a bunch of scripts, each with its own `.venv`
4. Some scripts need to be restarted + `pip install --upgrade` daily; some don't
5. One-click log viewer per project
6. Upload a folder that contains many project folders; pick each project's root dir and its start script
7. Interaction is click/select-driven, not command-line
8. Runs on Debian 12 container

User choices:
- Deployment: user self-hosts on their own Debian 12 container
- Auth: simple username/password (admin seeded from `backend/.env`)
- Execution: both background processes AND daily-cron schedule per script
- Storage: local disk
- Extras: env-var editor, in-browser code editor, resource stats (CPU/mem), auto pip install

## Architecture
- Backend: FastAPI + Motor (MongoDB), APScheduler, psutil, subprocess.Popen
- Frontend: React + shadcn/ui + Tailwind (dark "terminal brutalist" theme, amber accent)
- Auth: JWT bearer token (localStorage), bcrypt password hash, admin seeded from `.env`
- Workspace: `WORKSPACE_DIR` (default `/app/workspace`) holds all files; logs in `WORKSPACE_DIR/.logs/{project_id}.log`; each project's venv at `<project_root>/.venv`

## Implemented (2026-02-03)
- Login (username/password), JWT auth, protected routes, logout
- File manager: list, upload (files or whole folder via `webkitdirectory`), drag-drop upload, download (file or folder-as-zip), mkdir, rename, delete, breadcrumb navigation
- Register-as-project flow from a folder in the file manager (pick .py start script, toggle daily restart + pip upgrade)
- Project list with status pills (running / stopped / errored), live CPU/mem, uptime hints
- Project detail: Start / Stop / Restart / pip install buttons, live tail log viewer with auto-scroll + clear, env-var table editor, settings tab (name / start_script / args / daily restart hour / auto pip upgrade), delete
- APScheduler daily cron per project (UTC hour), does pip upgrade first if configured
- In-browser code editor (textarea-based, Cmd/Ctrl+S save) for .py/.txt/.json/.yaml/.md/etc
- Global status bar: CPU/MEM/DISK + python version

## Iteration 2 (2026-02-03)
- Auto-restart-on-crash policy (max_restarts + backoff, resets after 60s stable uptime), restart counter surfaced in UI
- WebSocket-based live log streaming (`/api/ws/logs/{id}`) replacing polling; ws-status LIVE indicator
- Arbitrary cron expression support (`schedule_type=cron`, `cron_expression="*/30 * * * *"`) alongside the simpler daily-hour mode
- `deploy/` folder: `docker-compose.yml`, backend + frontend Dockerfiles, nginx config with WS-upgrade headers, `.env.example`, README — single-command deploy on Debian 12: `docker compose -f deploy/docker-compose.yml --env-file .env up -d --build`

## Deployment (self-hosting on Debian 12)
1. Install Python 3.12, MongoDB, Node 20
2. Set env vars in `backend/.env`:
   - `MONGO_URL`, `DB_NAME`
   - `JWT_SECRET` (64-char hex)
   - `ADMIN_USERNAME`, `ADMIN_PASSWORD`
   - `WORKSPACE_DIR` (absolute path where all managed scripts live)
   - `PYTHON_BIN=/usr/bin/python3.12` (used as the base interpreter for created venvs)
3. Set `REACT_APP_BACKEND_URL` in `frontend/.env`
4. `pip install -r backend/requirements.txt`, `yarn --cwd frontend install`, `yarn --cwd frontend build`, run backend with `uvicorn server:app --host 0.0.0.0 --port 8001`, serve `frontend/build` behind any static host

## Known limitations (not blocking)
- No brute-force lockout on login (advisory)
- CORS wide-open by default (`CORS_ORIGINS=*`) — tighten in prod
- `pip install` and venv creation are synchronous FastAPI handlers (blocks worker for a few seconds)
- `Project.python_version` field is currently unused (venv uses `PYTHON_BIN`)
- Deleting a project keeps its `.venv` and files on disk (intentional — recover-friendly)

## Backlog / Next actions
- P1: multi-user support with roles
- P1: WebSocket log streaming (currently polling every 2.5s)
- P2: Requirements.txt diff viewer + editable in browser
- P2: Monaco editor upgrade with syntax highlighting
- P2: One-shot cron / arbitrary cron expression per project (not just daily)
- P2: Restart policy on crash (auto-restart N times)
- P3: Import/export of project definitions

## Credentials
`admin` / `admin123` (see `/app/memory/test_credentials.md`)
