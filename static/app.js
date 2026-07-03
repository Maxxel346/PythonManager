'use strict';

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* not json */ }
  if (!res.ok) {
    const msg = (data && (data.detail || data.message)) || res.statusText;
    throw new Error(msg);
  }
  return data;
}
async function apiForm(path, formData, method = 'POST') {
  return api(path, { method, body: formData });
}
async function apiJson(path, obj, method = 'POST') {
  return api(path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toast-stack').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------- nav
$$('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    $$('.view').forEach(v => v.classList.remove('active'));
    $(`#view-${view}`).classList.add('active');
    if (view === 'files') loadFiles(currentPath);
    if (view === 'projects') loadProjects();
  });
});

function openModal(id) {
  $('#modal-backdrop').classList.add('show');
  $(id).classList.add('show');
}
function closeModals() {
  $('#modal-backdrop').classList.remove('show');
  $$('.modal').forEach(m => m.classList.remove('show'));
  stopLogAutoRefresh();
}
$('#modal-backdrop').addEventListener('click', closeModals);
$$('[data-close]').forEach(b => b.addEventListener('click', closeModals));

// ================================================================== FILES
let currentPath = '';

function renderBreadcrumb(path) {
  const parts = path ? path.split('/') : [];
  let html = '<a data-path="">workspace</a>';
  let acc = '';
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    html += ` / <a data-path="${escapeHtml(acc)}">${escapeHtml(p)}</a>`;
  }
  $('#breadcrumb').innerHTML = html;
  $$('#breadcrumb a').forEach(a => a.addEventListener('click', () => loadFiles(a.dataset.path)));
}

async function loadFiles(path = '') {
  currentPath = path;
  renderBreadcrumb(path);
  const data = await api(`/api/files?path=${encodeURIComponent(path)}`);
  const tbody = $('#file-tbody');
  tbody.innerHTML = '';
  $('#files-empty').classList.toggle('hidden', data.items.length > 0);
  for (const item of data.items) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="file-icon">${item.is_dir ? '&#128193;' : '&#128196;'}</td>
      <td><span class="file-name ${item.is_dir ? 'is-dir' : ''}">${escapeHtml(item.name)}</span></td>
      <td class="file-meta">${item.modified.replace('T', ' ')}</td>
      <td class="file-meta">${item.is_dir ? '' : item.size_human}</td>
      <td>
        <div class="file-row-actions">
          <button class="icon-btn" data-act="download">Download</button>
          <button class="icon-btn" data-act="rename">Rename</button>
          <button class="icon-btn" data-act="delete">Delete</button>
        </div>
      </td>`;
    tr.querySelector('.file-name').addEventListener('click', () => {
      if (item.is_dir) loadFiles(item.path);
    });
    tr.querySelector('[data-act="download"]').addEventListener('click', () => {
      window.location = `/api/files/download?path=${encodeURIComponent(item.path)}`;
    });
    tr.querySelector('[data-act="rename"]').addEventListener('click', async () => {
      const name = prompt('New name', item.name);
      if (!name || name === item.name) return;
      await apiForm('/api/files/rename', new URLSearchParams({ path: item.path, new_name: name }));
      loadFiles(currentPath);
    });
    tr.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!confirm(`Delete "${item.name}"? This cannot be undone.`)) return;
      await apiForm('/api/files/delete', new URLSearchParams({ path: item.path }));
      toast(`Deleted ${item.name}`, 'ok');
      loadFiles(currentPath);
    });
    tbody.appendChild(tr);
  }
}

$('#btn-new-folder').addEventListener('click', async () => {
  const name = prompt('Folder name');
  if (!name) return;
  await apiForm('/api/files/mkdir', new URLSearchParams({ path: currentPath, name }));
  loadFiles(currentPath);
});

// -- uploads --
async function uploadFileList(files, path) {
  const fd = new FormData();
  fd.append('path', path);
  for (const f of files) {
    fd.append('files', f, f.name);
    fd.append('relpaths', f.webkitRelativePath || f.name);
  }
  await apiForm('/api/files/upload-files', fd);
  toast(`Uploaded ${files.length} file(s)`, 'ok');
  loadFiles(currentPath);
}

$('#btn-upload-files').addEventListener('click', () => $('#input-upload-files').click());
$('#input-upload-files').addEventListener('change', e => {
  if (e.target.files.length) uploadFileList(e.target.files, currentPath);
  e.target.value = '';
});

$('#btn-upload-folder').addEventListener('click', () => $('#input-upload-folder').click());
$('#input-upload-folder').addEventListener('change', e => {
  if (e.target.files.length) uploadFileList(e.target.files, currentPath);
  e.target.value = '';
});

$('#btn-upload-zip').addEventListener('click', () => $('#input-upload-zip').click());
$('#input-upload-zip').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const fd = new FormData();
  fd.append('path', currentPath);
  fd.append('file', file);
  fd.append('extract', 'true');
  await apiForm('/api/files/upload-zip', fd);
  toast(`Extracted ${file.name}`, 'ok');
  loadFiles(currentPath);
});

const dropzone = $('#dropzone');
['dragenter', 'dragover'].forEach(evt =>
  dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add('drag-over'); }));
['dragleave', 'drop'].forEach(evt =>
  dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove('drag-over'); }));
dropzone.addEventListener('drop', e => {
  const files = e.dataTransfer.files;
  if (files && files.length) uploadFileList(files, currentPath);
});

// ================================================================ PROJECTS
let projectsCache = [];
let statusTimer = null;

async function loadProjects() {
  projectsCache = await api('/api/projects');
  renderProjects();
  $('#stat-total').textContent = projectsCache.length;
  $('#stat-running').textContent = projectsCache.filter(p => p.running).length;
}

function renderProjects() {
  const grid = $('#projects-grid');
  grid.innerHTML = '';
  $('#projects-empty').classList.toggle('hidden', projectsCache.length > 0);
  for (const p of projectsCache) {
    const card = document.createElement('div');
    card.className = 'project-card';
    card.innerHTML = `
      <div class="pc-top">
        <div class="pc-name">${escapeHtml(p.name)}</div>
        <div class="pc-status ${p.running ? 'running' : 'stopped'}">
          <span class="pulse"></span>${p.running ? `running · pid ${p.pid}` : 'stopped'}
        </div>
      </div>
      <div class="pc-path">${escapeHtml(p.root_dir_rel || p.root_dir)} / ${escapeHtml(p.start_script)}</div>
      <div class="pc-badges">
        ${p.auto_restart ? `<span class="badge on">daily restart ${p.restart_time}</span>` : ''}
        ${p.pip_update ? `<span class="badge on">daily pip ${p.pip_update_time}</span>` : ''}
        ${!p.auto_restart && !p.pip_update ? '<span class="badge">manual only</span>' : ''}
      </div>
      <div class="pc-actions">
        <button class="btn btn-small" data-act="start" ${p.running ? 'disabled' : ''}>Start</button>
        <button class="btn btn-small" data-act="stop" ${p.running ? '' : 'disabled'}>Stop</button>
        <button class="btn btn-small" data-act="restart">Restart</button>
        <button class="btn btn-small" data-act="setup">Setup / install deps</button>
        <button class="btn btn-small" data-act="logs">Logs</button>
        <button class="btn btn-small" data-act="edit">Edit</button>
      </div>
      <div class="pc-msg"></div>`;
    const msgEl = card.querySelector('.pc-msg');
    const run = async (act, fn) => {
      msgEl.textContent = 'working…';
      try {
        const r = await fn();
        msgEl.textContent = r && r.message ? r.message : 'done';
        await loadProjects();
      } catch (err) {
        msgEl.textContent = err.message;
        toast(`${p.name}: ${err.message}`, 'err');
      }
    };
    card.querySelector('[data-act="start"]').addEventListener('click', () =>
      run('start', () => api(`/api/projects/${p.id}/start`, { method: 'POST' })));
    card.querySelector('[data-act="stop"]').addEventListener('click', () =>
      run('stop', () => api(`/api/projects/${p.id}/stop`, { method: 'POST' })));
    card.querySelector('[data-act="restart"]').addEventListener('click', () =>
      run('restart', () => api(`/api/projects/${p.id}/restart`, { method: 'POST' })));
    card.querySelector('[data-act="setup"]').addEventListener('click', () =>
      run('setup', () => api(`/api/projects/${p.id}/setup`, { method: 'POST' })));
    card.querySelector('[data-act="logs"]').addEventListener('click', () => openLogs(p));
    card.querySelector('[data-act="edit"]').addEventListener('click', () => openEdit(p));
    grid.appendChild(card);
  }
}

// gentle auto-refresh of running-status while projects view is visible
setInterval(() => {
  if ($('#view-projects').classList.contains('active') && !$('#modal-new-project').classList.contains('show')) {
    loadProjects();
  }
}, 6000);

// -------------------------------------------------------------- logs modal
let logsProjectId = null;
let logAutoTimer = null;

async function openLogs(p) {
  logsProjectId = p.id;
  $('#logs-project-name').textContent = p.name;
  openModal('#modal-logs');
  await refreshLogs();
  startLogAutoRefresh();
}
async function refreshLogs() {
  if (!logsProjectId) return;
  const data = await api(`/api/projects/${logsProjectId}/logs?tail=500`);
  const pane = $('#log-pane');
  const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 20;
  pane.textContent = data.text || '(no log output yet)';
  if (atBottom) pane.scrollTop = pane.scrollHeight;
}
function startLogAutoRefresh() {
  stopLogAutoRefresh();
  logAutoTimer = setInterval(() => {
    if ($('#logs-autorefresh').checked) refreshLogs();
  }, 2000);
}
function stopLogAutoRefresh() {
  if (logAutoTimer) clearInterval(logAutoTimer);
  logAutoTimer = null;
}
$('#logs-refresh').addEventListener('click', refreshLogs);
$('#logs-clear').addEventListener('click', async () => {
  if (!confirm('Clear this log file?')) return;
  await api(`/api/projects/${logsProjectId}/logs/clear`, { method: 'POST' });
  refreshLogs();
});

// -------------------------------------------------------------- edit modal
let editProjectId = null;
function openEdit(p) {
  editProjectId = p.id;
  $('#ep-name-echo').textContent = p.name;
  $('#ep-name').value = p.name;
  $('#ep-script').value = p.start_script;
  $('#ep-req').value = p.requirements_file;
  $('#ep-args').value = (p.args || []).join(' ');
  $('#ep-env').value = Object.entries(p.env_vars || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  $('#ep-auto-restart').checked = !!p.auto_restart;
  $('#ep-restart-time').value = p.restart_time;
  $('#ep-pip-update').checked = !!p.pip_update;
  $('#ep-pip-time').value = p.pip_update_time;
  openModal('#modal-edit-project');
}
function parseEnvBlock(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || !t.includes('=')) continue;
    const idx = t.indexOf('=');
    out[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return out;
}
$('#ep-save').addEventListener('click', async () => {
  try {
    await apiJson(`/api/projects/${editProjectId}`, {
      name: $('#ep-name').value.trim(),
      start_script: $('#ep-script').value.trim(),
      requirements_file: $('#ep-req').value.trim() || 'requirements.txt',
      args: $('#ep-args').value.trim() ? $('#ep-args').value.trim().split(/\s+/) : [],
      env_vars: parseEnvBlock($('#ep-env').value),
      auto_restart: $('#ep-auto-restart').checked,
      restart_time: $('#ep-restart-time').value || '03:00',
      pip_update: $('#ep-pip-update').checked,
      pip_update_time: $('#ep-pip-time').value || '03:30',
    }, 'PUT');
    toast('Project updated', 'ok');
    closeModals();
    loadProjects();
  } catch (err) { toast(err.message, 'err'); }
});
$('#ep-delete').addEventListener('click', async () => {
  if (!confirm('Delete this project? Its files will stay in the workspace unless you also remove them manually.')) return;
  await api(`/api/projects/${editProjectId}`, { method: 'DELETE' });
  toast('Project deleted', 'ok');
  closeModals();
  loadProjects();
});

// ------------------------------------------------------- new project wizard
let npStep = 1;
let npRootBrowsePath = '';
let npSelectedRoot = null;   // relative path
let npScriptBrowsePath = '';
let npSelectedScript = null; // relative path (inside root)

function npGoStep(n) {
  npStep = n;
  $$('.wstep').forEach(s => s.classList.toggle('active', Number(s.dataset.step) === n));
  $$('.wpane').forEach(p => p.classList.toggle('active', Number(p.dataset.pane) === n));
  $('#np-back').disabled = n === 1;
  $('#np-next').classList.toggle('hidden', n === 3);
  $('#np-create').classList.toggle('hidden', n !== 3);
  if (n === 1) renderNpRootBrowser();
  if (n === 2) renderNpScriptBrowser();
}

async function renderNpRootBrowser() {
  const data = await api(`/api/files?path=${encodeURIComponent(npRootBrowsePath)}`);
  $('#np-root-breadcrumb').textContent = '/workspace/' + npRootBrowsePath;
  const box = $('#np-root-browser');
  box.innerHTML = '';
  if (npRootBrowsePath) {
    const up = document.createElement('div');
    up.className = 'mini-row dir';
    up.textContent = '.. (up)';
    up.addEventListener('click', () => {
      npRootBrowsePath = npRootBrowsePath.split('/').slice(0, -1).join('/');
      renderNpRootBrowser();
    });
    box.appendChild(up);
  }
  const dirs = data.items.filter(i => i.is_dir);
  if (!dirs.length) {
    const row = document.createElement('div');
    row.className = 'mini-row disabled';
    row.textContent = '(no subfolders here)';
    box.appendChild(row);
  }
  for (const item of dirs) {
    const row = document.createElement('div');
    row.className = 'mini-row dir';
    row.textContent = '\u{1F4C1} ' + item.name;
    row.addEventListener('click', () => { npRootBrowsePath = item.path; renderNpRootBrowser(); });
    box.appendChild(row);
  }
}
$('#np-root-use').addEventListener('click', () => {
  if (!npRootBrowsePath) { toast('Browse into a folder first', 'err'); return; }
  npSelectedRoot = npRootBrowsePath;
  $('#np-root-selected').textContent = npSelectedRoot;
});

async function renderNpScriptBrowser() {
  if (!npSelectedRoot) { toast('Pick a root folder first', 'err'); npGoStep(1); return; }
  $('#np-root-echo').textContent = npSelectedRoot;
  const full = npSelectedRoot + (npScriptBrowsePath ? '/' + npScriptBrowsePath : '');
  const data = await api(`/api/files?path=${encodeURIComponent(full)}`);
  const box = $('#np-script-browser');
  box.innerHTML = '';
  if (npScriptBrowsePath) {
    const up = document.createElement('div');
    up.className = 'mini-row dir';
    up.textContent = '.. (up)';
    up.addEventListener('click', () => {
      npScriptBrowsePath = npScriptBrowsePath.split('/').slice(0, -1).join('/');
      renderNpScriptBrowser();
    });
    box.appendChild(up);
  }
  for (const item of data.items) {
    const row = document.createElement('div');
    row.className = 'mini-row' + (item.is_dir ? ' dir' : '');
    row.textContent = (item.is_dir ? '\u{1F4C1} ' : '\u{1F40D} ') + item.name;
    row.addEventListener('click', () => {
      if (item.is_dir) {
        npScriptBrowsePath = npScriptBrowsePath ? `${npScriptBrowsePath}/${item.name}` : item.name;
        renderNpScriptBrowser();
      } else if (item.name.endsWith('.py')) {
        npSelectedScript = item.path.slice(npSelectedRoot.length + 1);
        $('#np-script-selected').textContent = npSelectedScript;
      }
    });
    box.appendChild(row);
  }
}

$('#np-next').addEventListener('click', () => {
  if (npStep === 1) {
    if (!npSelectedRoot) { toast('Select a root folder first', 'err'); return; }
    npGoStep(2);
  } else if (npStep === 2) {
    if (!npSelectedScript) { toast('Select a start script (.py file)', 'err'); return; }
    $('#np-name').value = $('#np-name').value || npSelectedRoot.split('/').pop();
    npGoStep(3);
  }
});
$('#np-back').addEventListener('click', () => npGoStep(Math.max(1, npStep - 1)));

$('#btn-new-project').addEventListener('click', () => {
  npStep = 1; npRootBrowsePath = ''; npSelectedRoot = null;
  npScriptBrowsePath = ''; npSelectedScript = null;
  $('#np-root-selected').textContent = '(none — browse into a folder, then click "Use this folder")';
  $('#np-script-selected').textContent = '(none)';
  $('#np-name').value = ''; $('#np-req').value = 'requirements.txt';
  $('#np-args').value = ''; $('#np-env').value = '';
  $('#np-auto-restart').checked = false; $('#np-restart-time').value = '03:00';
  $('#np-pip-update').checked = false; $('#np-pip-time').value = '03:30';
  openModal('#modal-new-project');
  npGoStep(1);
});

$('#np-create').addEventListener('click', async () => {
  const name = $('#np-name').value.trim();
  if (!name) { toast('Project needs a name', 'err'); return; }
  try {
    await apiJson('/api/projects', {
      name,
      root_dir: npSelectedRoot,
      start_script: npSelectedScript,
      requirements_file: $('#np-req').value.trim() || 'requirements.txt',
      args: $('#np-args').value.trim() ? $('#np-args').value.trim().split(/\s+/) : [],
      env_vars: parseEnvBlock($('#np-env').value),
      auto_restart: $('#np-auto-restart').checked,
      restart_time: $('#np-restart-time').value || '03:00',
      pip_update: $('#np-pip-update').checked,
      pip_update_time: $('#np-pip-time').value || '03:30',
    });
    toast(`Project "${name}" created`, 'ok');
    closeModals();
    loadProjects();
  } catch (err) { toast(err.message, 'err'); }
});

// ---------------------------------------------------------------- init
loadProjects();
