# PyScript Manager

A small web app for supervising a bunch of independent Python scripts on one
box: a Drive-style file browser to move code in and out, one venv per
project, start/stop/restart with one click, live logs, and optional daily
restart / `pip install --upgrade` schedules per project.

## Run it

```bash
docker compose up -d --build
```

Then open **http://localhost:8000**.

All state lives in `./data` on the host (mounted into the container at
`/app/data`):
- `data/workspace/` — everything you see in the **Files** tab, including each
  project's own `.venv`
- `data/logs/<project_id>.log` — stdout+stderr for each project
- `data/projects.json` — the project registry
- `data/state.json` — which PIDs are currently running (so status survives a
  container restart)

Back up `./data` and you have everything.

## Using it

1. **Files tab** — upload a folder (drag a folder in, or use "Upload folder"),
   or upload a `.zip` and it'll be extracted for you.
2. **Projects tab → New project** — a 3-step wizard:
   1. Browse to and pick the project's root folder.
   2. Pick the `.py` file that should run as the entry point.
   3. Name it, optionally set a requirements file, CLI args, environment
      variables, and whether it should restart itself and/or
      `pip install --upgrade` its requirements every day at a set time.
3. Each project card has **Start / Stop / Restart / Setup (install deps) /
   Logs / Edit**. "Setup" (re)creates the venv and installs
   `requirements.txt` — it also happens automatically the first time you hit
   Start.
4. **Logs** opens a live-tailing panel (auto-refreshes every 2s) with a
   clear-log button.

## How processes are run

Each project gets its own virtualenv at `<project_root>/.venv`, created with
`python -m venv` the first time it's started (or via "Setup"). The start
script runs as `.venv/bin/python <start_script> <args...>` with `cwd` set to
the project root, in its own process group, so Stop cleanly kills the whole
tree instead of just the top process.

## Notes / limits

- This is a single-user tool with no authentication — put it behind your own
  reverse proxy / VPN / basic-auth if it's reachable from anywhere but
  localhost.
- The scheduler (daily restart / pip update) runs in-process via
  APScheduler, so the container needs to stay running for schedules to fire.
- Deleting a project from the UI removes it from the registry and its logs;
  it does **not** delete the project's files from the workspace unless you
  tick "also delete files."
