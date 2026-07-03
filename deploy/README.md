# Deploying Python Script Manager on Debian 12

Everything you need is in this `deploy/` folder.

## Requirements
- Docker 20+ and Docker Compose plugin (`apt install docker.io docker-compose-plugin` on Debian 12)

## One-time setup
```bash
# 1. Clone/copy the project onto your Debian box
git clone <this repo> pymanager && cd pymanager

# 2. Copy the sample env and edit the two required secrets
cp deploy/.env.example .env
$EDITOR .env       # set JWT_SECRET (64-char hex) and ADMIN_PASSWORD

# 3. Build & start
docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
```

Now open `http://<your-host>:8080` and log in with the credentials you set in `.env`.

## What runs

| Service    | Image / Build                    | Purpose                                          |
| ---------- | -------------------------------- | ------------------------------------------------ |
| `mongo`    | `mongo:7`                        | Stores users, projects, schedule state           |
| `backend`  | `deploy/backend.Dockerfile`      | FastAPI (Python 3.12) — API + WebSocket + cron   |
| `frontend` | `deploy/frontend.Dockerfile`     | Nginx serving built React + proxy `/api` to API  |

Your projects live in `${HOST_WORKSPACE}` (default `./workspace`) on the host so they survive rebuilds. Each project's `.venv` and its logs live inside its own folder.

## Common ops

```bash
# tail service logs
docker compose -f deploy/docker-compose.yml logs -f backend

# rebuild after code changes
docker compose -f deploy/docker-compose.yml up -d --build

# stop everything
docker compose -f deploy/docker-compose.yml down

# reset (also wipes Mongo data — you lose project registrations, files on disk stay)
docker compose -f deploy/docker-compose.yml down -v
```

## Notes
- The backend container ships with `python3.12` + `python3.12-venv`, so per-project venvs work out of the box.
- Uploads up to 512 MB are allowed (see `deploy/nginx.conf`, `client_max_body_size`).
- WebSocket-based log streaming works through nginx because the config sets `Upgrade`/`Connection` headers on `/api/`.
- To use HTTPS, put a reverse proxy (Caddy/Traefik) in front of the `frontend` service and terminate TLS there.
