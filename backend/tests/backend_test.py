"""Backend tests for Python Script Manager.

Covers: auth, files, projects CRUD/control, crash-restart, cron scheduling, WS log streaming.
"""
import os
import time
import uuid
import json
import asyncio
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://pymanager-hub.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"
# derive ws url from http url
WS_BASE = ("wss://" if BASE_URL.startswith("https://") else "ws://") + BASE_URL.split("://", 1)[1]


@pytest.fixture(scope="session")
def token():
    r = requests.post(f"{API}/auth/login", json={"username": "admin", "password": "admin123"}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def auth_headers(token):
    return {"Authorization": f"Bearer {token}"}


# --- Auth ---
class TestAuth:
    def test_login_wrong_password(self):
        r = requests.post(f"{API}/auth/login", json={"username": "admin", "password": "WRONG"}, timeout=30)
        assert r.status_code == 401

    def test_me_without_token(self):
        r = requests.get(f"{API}/auth/me", timeout=30)
        assert r.status_code == 401

    def test_me_with_token(self, auth_headers):
        r = requests.get(f"{API}/auth/me", headers=auth_headers, timeout=30)
        assert r.status_code == 200
        assert r.json()["username"] == "admin"


# --- System stats ---
class TestSystem:
    def test_system_stats(self, auth_headers):
        r = requests.get(f"{API}/system/stats", headers=auth_headers, timeout=30)
        assert r.status_code == 200
        data = r.json()
        for k in ("cpu_percent", "memory_percent", "disk_percent"):
            assert k in data


# --- Files (regression, brief) ---
class TestFiles:
    @pytest.fixture(scope="class")
    def test_dir(self, auth_headers):
        name = f"TEST_dir_{uuid.uuid4().hex[:8]}"
        r = requests.post(f"{API}/files/mkdir", headers=auth_headers, json={"path": name}, timeout=30)
        assert r.status_code == 200
        yield name
        requests.post(f"{API}/files/delete", headers=auth_headers, json={"path": name}, timeout=30)

    def test_list_workspace_root(self, auth_headers):
        r = requests.get(f"{API}/files/list", headers=auth_headers, timeout=30)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_mkdir_upload_read(self, auth_headers, test_dir):
        content = "print('hi')\n"
        files = {"file": ("main.py", content, "text/x-python")}
        r = requests.post(f"{API}/files/upload", headers=auth_headers, data={"dest": test_dir}, files=files, timeout=60)
        assert r.status_code == 200
        r2 = requests.get(f"{API}/files/read", headers=auth_headers, params={"path": f"{test_dir}/main.py"}, timeout=30)
        assert r2.status_code == 200
        assert r2.json()["content"] == content

    def test_path_traversal_rejected(self, auth_headers):
        r = requests.get(f"{API}/files/list", headers=auth_headers, params={"path": "../../"}, timeout=30)
        assert r.status_code == 400


def _create_project_with_script(auth_headers, script_content: str, **project_kwargs) -> dict:
    """Helper: create dir + upload main.py + create project."""
    name = f"TEST_proj_{uuid.uuid4().hex[:8]}"
    r = requests.post(f"{API}/files/mkdir", headers=auth_headers, json={"path": name}, timeout=30)
    assert r.status_code == 200, r.text
    files = {"file": ("main.py", script_content, "text/x-python")}
    r = requests.post(f"{API}/files/upload", headers=auth_headers, data={"dest": name}, files=files, timeout=60)
    assert r.status_code == 200, r.text
    payload = {"name": name, "root_dir": name, "start_script": "main.py"}
    payload.update(project_kwargs)
    r = requests.post(f"{API}/projects", headers=auth_headers, json=payload, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


def _cleanup_project(auth_headers, proj):
    try:
        requests.post(f"{API}/projects/{proj['id']}/stop", headers=auth_headers, timeout=30)
    except Exception:
        pass
    requests.delete(f"{API}/projects/{proj['id']}", headers=auth_headers, timeout=30)
    requests.post(f"{API}/files/delete", headers=auth_headers, json={"path": proj["root_dir"]}, timeout=60)


# --- Projects: basic control (regression) ---
class TestProjectsBasic:
    @pytest.fixture(scope="class")
    def project(self, auth_headers):
        script = "import time\nprint('=== hello ===', flush=True)\ntime.sleep(300)\n"
        proj = _create_project_with_script(auth_headers, script)
        yield proj
        _cleanup_project(auth_headers, proj)

    def test_list_projects(self, auth_headers, project):
        r = requests.get(f"{API}/projects", headers=auth_headers, timeout=30)
        assert r.status_code == 200
        assert project["id"] in [p["id"] for p in r.json()]

    def test_start_then_stop(self, auth_headers, project):
        r = requests.post(f"{API}/projects/{project['id']}/start", headers=auth_headers, timeout=180)
        assert r.status_code == 200, r.text
        assert r.json().get("pid")
        time.sleep(3)
        r2 = requests.get(f"{API}/projects/{project['id']}/logs", headers=auth_headers, timeout=30)
        logs = r2.json()["content"]
        assert "hello" in logs or "=== start" in logs, f"missing marker: {logs[-500:]}"
        r3 = requests.get(f"{API}/projects/{project['id']}", headers=auth_headers, timeout=30)
        assert r3.json()["status"] == "running"
        r4 = requests.post(f"{API}/projects/{project['id']}/stop", headers=auth_headers, timeout=30)
        assert r4.status_code == 200
        time.sleep(1)
        r5 = requests.get(f"{API}/projects/{project['id']}", headers=auth_headers, timeout=30)
        assert r5.json()["status"] == "stopped"


# --- NEW: auto-restart-on-crash exceeds max_restarts ---
class TestCrashRestartMaxExceeded:
    @pytest.fixture(scope="class")
    def project(self, auth_headers):
        # boot, then sys.exit(1) after 2s
        script = "import time, sys\nprint('boot', flush=True)\ntime.sleep(2)\nsys.exit(1)\n"
        proj = _create_project_with_script(
            auth_headers, script,
            auto_restart_on_crash=True,
            max_restarts=2,
            restart_backoff_seconds=2,
        )
        yield proj
        _cleanup_project(auth_headers, proj)

    def test_crash_restart_hits_limit_and_errors(self, auth_headers, project):
        r = requests.post(f"{API}/projects/{project['id']}/start", headers=auth_headers, timeout=180)
        assert r.status_code == 200, r.text
        # Timeline per script: proc lives ~2s, crash-watch tick ~5s, backoff 2s per attempt.
        # allow ~40s total for 2 restarts + final errored state
        deadline = time.time() + 60
        final = None
        while time.time() < deadline:
            time.sleep(3)
            g = requests.get(f"{API}/projects/{project['id']}", headers=auth_headers, timeout=30)
            d = g.json()
            if d.get("status") == "errored" and (d.get("restart_count") or 0) >= 2:
                final = d
                break
            final = d
        assert final is not None
        assert final.get("restart_count") == 2, f"restart_count={final.get('restart_count')} full={final}"
        assert final.get("status") == "errored", f"status={final.get('status')}"
        assert "exceeded max_restarts" in (final.get("last_error") or ""), f"last_error={final.get('last_error')}"


# --- NEW: restart_count resets after uptime stability ---
class TestCrashRestartResetOnStable:
    @pytest.fixture(scope="class")
    def project(self, auth_headers):
        script = "import time\nprint('ok', flush=True)\ntime.sleep(300)\n"
        proj = _create_project_with_script(
            auth_headers, script,
            auto_restart_on_crash=True,
            max_restarts=3,
        )
        yield proj
        _cleanup_project(auth_headers, proj)

    def test_restart_count_stays_zero(self, auth_headers, project):
        r = requests.post(f"{API}/projects/{project['id']}/start", headers=auth_headers, timeout=180)
        assert r.status_code == 200, r.text
        # Wait more than UPTIME_STABILITY_SECONDS (60s) + one crash-watcher tick (5s).
        time.sleep(70)
        g = requests.get(f"{API}/projects/{project['id']}", headers=auth_headers, timeout=30)
        d = g.json()
        assert d["status"] == "running", d
        assert (d.get("restart_count") or 0) == 0, f"restart_count should stay 0, got {d.get('restart_count')}"


# --- NEW: cron scheduling ---
class TestCronScheduling:
    def test_valid_cron_saved(self, auth_headers):
        script = "import time\ntime.sleep(300)\n"
        proj = _create_project_with_script(
            auth_headers, script,
            schedule_type="cron",
            cron_expression="*/1 * * * *",
            auto_restart_daily=True,
        )
        try:
            r = requests.get(f"{API}/projects/{proj['id']}", headers=auth_headers, timeout=30)
            assert r.status_code == 200
            d = r.json()
            assert d["schedule_type"] == "cron"
            assert d["cron_expression"] == "*/1 * * * *"
            assert d["auto_restart_daily"] is True
        finally:
            _cleanup_project(auth_headers, proj)

    def test_invalid_cron_gracefully_handled(self, auth_headers):
        script = "import time\ntime.sleep(300)\n"
        # server should NOT crash and should still save the project
        proj = _create_project_with_script(
            auth_headers, script,
            schedule_type="cron",
            cron_expression="xyz",
            auto_restart_daily=True,
        )
        try:
            r = requests.get(f"{API}/projects/{proj['id']}", headers=auth_headers, timeout=30)
            assert r.status_code == 200
            assert r.json()["cron_expression"] == "xyz"
            # server still up
            r2 = requests.get(f"{API}/", timeout=15)
            assert r2.status_code == 200
        finally:
            _cleanup_project(auth_headers, proj)


# --- NEW: WebSocket log streaming ---
class TestWebSocketLogs:
    def test_ws_without_token_closes_1008(self, auth_headers):
        # need a real project id (server checks existence too, but token check is first)
        script = "import time\ntime.sleep(300)\n"
        proj = _create_project_with_script(auth_headers, script)
        try:
            try:
                from websockets.sync.client import connect as ws_connect
                from websockets.exceptions import ConnectionClosed
            except Exception:
                pytest.skip("websockets lib not available")
            url = f"{WS_BASE}/api/ws/logs/{proj['id']}"  # no token
            with pytest.raises(Exception) as excinfo:
                with ws_connect(url, open_timeout=10) as ws:
                    ws.recv(timeout=5)
            # Either ConnectionClosed with 1008 or an invalid-handshake error;
            # we just require the connect+read did not succeed with content.
            msg = str(excinfo.value)
            assert "1008" in msg or "closed" in msg.lower() or "handshake" in msg.lower() or "rejected" in msg.lower(), msg
        finally:
            _cleanup_project(auth_headers, proj)

    def test_ws_with_token_receives_logs(self, auth_headers, token):
        script = "import time\nprint('BOOT_MARKER_XYZ', flush=True)\ntime.sleep(60)\n"
        proj = _create_project_with_script(auth_headers, script)
        try:
            # start it so log file exists and contains BOOT_MARKER
            r = requests.post(f"{API}/projects/{proj['id']}/start", headers=auth_headers, timeout=180)
            assert r.status_code == 200
            time.sleep(3)  # give it time to boot + write
            try:
                from websockets.sync.client import connect as ws_connect
            except Exception:
                pytest.skip("websockets lib not available")
            url = f"{WS_BASE}/api/ws/logs/{proj['id']}?token={token}"
            received = []
            with ws_connect(url, open_timeout=15) as ws:
                # try to read up to 3 messages / 5s
                end = time.time() + 6
                while time.time() < end:
                    try:
                        msg = ws.recv(timeout=2)
                        received.append(msg)
                        if any("BOOT_MARKER_XYZ" in m for m in received):
                            break
                    except Exception:
                        break
            combined = "".join(received)
            assert "BOOT_MARKER_XYZ" in combined, f"WS did not push log content. got: {combined[:500]!r}"
        finally:
            requests.post(f"{API}/projects/{proj['id']}/stop", headers=auth_headers, timeout=30)
            _cleanup_project(auth_headers, proj)
