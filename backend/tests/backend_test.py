"""Backend tests for Python Script Manager (auth, files, projects control)."""
import os
import time
import uuid
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://pymanager-hub.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="session")
def token():
    r = requests.post(f"{API}/auth/login", json={"username": "admin", "password": "admin123"}, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["username"] == "admin"
    assert data["access_token"]
    return data["access_token"]


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

    def test_projects_requires_auth(self):
        r = requests.get(f"{API}/projects", timeout=30)
        assert r.status_code == 401


# --- System stats ---
class TestSystem:
    def test_system_stats(self, auth_headers):
        r = requests.get(f"{API}/system/stats", headers=auth_headers, timeout=30)
        assert r.status_code == 200
        data = r.json()
        for k in ("cpu_percent", "memory_percent", "disk_percent"):
            assert k in data


# --- Files ---
class TestFiles:
    @pytest.fixture(scope="class")
    def test_dir(self, auth_headers):
        name = f"TEST_dir_{uuid.uuid4().hex[:8]}"
        r = requests.post(f"{API}/files/mkdir", headers=auth_headers, json={"path": name}, timeout=30)
        assert r.status_code == 200, r.text
        yield name
        requests.post(f"{API}/files/delete", headers=auth_headers, json={"path": name}, timeout=30)

    def test_list_workspace_root(self, auth_headers):
        r = requests.get(f"{API}/files/list", headers=auth_headers, timeout=30)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_mkdir_and_list_shows_it(self, auth_headers, test_dir):
        r = requests.get(f"{API}/files/list", headers=auth_headers, timeout=30)
        assert r.status_code == 200
        names = [n["name"] for n in r.json()]
        assert test_dir in names

    def test_upload_and_read(self, auth_headers, test_dir):
        content = "import time\nprint('hello from test')\ntime.sleep(300)\n"
        files = {"file": ("main.py", content, "text/x-python")}
        r = requests.post(f"{API}/files/upload", headers=auth_headers, data={"dest": test_dir}, files=files, timeout=60)
        assert r.status_code == 200, r.text
        # read back
        r2 = requests.get(f"{API}/files/read", headers=auth_headers, params={"path": f"{test_dir}/main.py"}, timeout=30)
        assert r2.status_code == 200
        assert r2.json()["content"] == content

    def test_write_and_read_persists(self, auth_headers, test_dir):
        path = f"{test_dir}/edited.py"
        # write
        r = requests.put(f"{API}/files/write", headers=auth_headers, json={"path": path, "content": "print(1)\n"}, timeout=30)
        assert r.status_code == 200
        r2 = requests.put(f"{API}/files/write", headers=auth_headers, json={"path": path, "content": "print(2)\n"}, timeout=30)
        assert r2.status_code == 200
        r3 = requests.get(f"{API}/files/read", headers=auth_headers, params={"path": path}, timeout=30)
        assert r3.status_code == 200
        assert r3.json()["content"] == "print(2)\n"

    def test_path_traversal_rejected(self, auth_headers):
        r = requests.get(f"{API}/files/list", headers=auth_headers, params={"path": "../../"}, timeout=30)
        assert r.status_code == 400


# --- Projects (start/stop/install/env/schedule) ---
class TestProjects:
    @pytest.fixture(scope="class")
    def project(self, auth_headers):
        # create workspace dir + script
        name = f"TEST_proj_{uuid.uuid4().hex[:8]}"
        r = requests.post(f"{API}/files/mkdir", headers=auth_headers, json={"path": name}, timeout=30)
        assert r.status_code == 200, r.text
        script = "import time\nprint('=== hello ===')\ntime.sleep(300)\n"
        files = {"file": ("main.py", script, "text/x-python")}
        r = requests.post(f"{API}/files/upload", headers=auth_headers, data={"dest": name}, files=files, timeout=60)
        assert r.status_code == 200
        # create project
        payload = {"name": name, "root_dir": name, "start_script": "main.py"}
        r = requests.post(f"{API}/projects", headers=auth_headers, json=payload, timeout=30)
        assert r.status_code == 200, r.text
        proj = r.json()
        yield proj
        # cleanup
        requests.post(f"{API}/projects/{proj['id']}/stop", headers=auth_headers, timeout=30)
        requests.delete(f"{API}/projects/{proj['id']}", headers=auth_headers, timeout=30)
        requests.post(f"{API}/files/delete", headers=auth_headers, json={"path": name}, timeout=60)

    def test_list_projects(self, auth_headers, project):
        r = requests.get(f"{API}/projects", headers=auth_headers, timeout=30)
        assert r.status_code == 200
        ids = [p["id"] for p in r.json()]
        assert project["id"] in ids

    def test_get_project(self, auth_headers, project):
        r = requests.get(f"{API}/projects/{project['id']}", headers=auth_headers, timeout=30)
        assert r.status_code == 200
        assert r.json()["name"] == project["name"]

    def test_start_then_stop(self, auth_headers, project):
        # start (this creates venv on first run - may take a while)
        r = requests.post(f"{API}/projects/{project['id']}/start", headers=auth_headers, timeout=180)
        assert r.status_code == 200, r.text
        assert r.json().get("pid")
        time.sleep(3)
        # logs should contain === start ===
        r2 = requests.get(f"{API}/projects/{project['id']}/logs", headers=auth_headers, timeout=30)
        assert r2.status_code == 200
        logs = r2.json()["content"]
        assert "=== start" in logs or "=== hello ===" in logs, f"logs missing markers: {logs[-500:]}"
        # get should show running
        r3 = requests.get(f"{API}/projects", headers=auth_headers, timeout=30)
        me = [p for p in r3.json() if p["id"] == project["id"]][0]
        assert me["status"] == "running"
        # stop
        r4 = requests.post(f"{API}/projects/{project['id']}/stop", headers=auth_headers, timeout=30)
        assert r4.status_code == 200
        time.sleep(1)
        r5 = requests.get(f"{API}/projects/{project['id']}", headers=auth_headers, timeout=30)
        assert r5.json()["status"] == "stopped"

    def test_pip_install_no_requirements(self, auth_headers, project):
        r = requests.post(f"{API}/projects/{project['id']}/install", headers=auth_headers, timeout=180)
        assert r.status_code == 200, r.text

    def test_update_env_persists(self, auth_headers, project):
        env_vars = [{"key": "FOO", "value": "bar123"}]
        r = requests.put(f"{API}/projects/{project['id']}", headers=auth_headers, json={"env_vars": env_vars}, timeout=30)
        assert r.status_code == 200
        r2 = requests.get(f"{API}/projects/{project['id']}", headers=auth_headers, timeout=30)
        got = r2.json()["env_vars"]
        assert any(ev["key"] == "FOO" and ev["value"] == "bar123" for ev in got)

    def test_update_daily_restart_persists(self, auth_headers, project):
        r = requests.put(f"{API}/projects/{project['id']}", headers=auth_headers,
                         json={"auto_restart_daily": True, "daily_restart_hour": 7}, timeout=30)
        assert r.status_code == 200
        r2 = requests.get(f"{API}/projects/{project['id']}", headers=auth_headers, timeout=30)
        d = r2.json()
        assert d["auto_restart_daily"] is True
        assert d["daily_restart_hour"] == 7
