import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, formatError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Folder, FileText, ChevronRight, Upload, FolderUp, FolderPlus, Download,
  Trash2, Edit3, MoreVertical, RefreshCw, Home, Rocket, FileCode,
} from "lucide-react";
import { toast } from "sonner";

function humanBytes(n) {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtDate(s) {
  if (!s) return "—";
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

export default function FileManager() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const path = params.get("path") || "";
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirName, setMkdirName] = useState("");
  const [renameFor, setRenameFor] = useState(null);
  const [renameTo, setRenameTo] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [projectFor, setProjectFor] = useState(null); // { root_dir }
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  const crumbs = useMemo(() => {
    const parts = path.split("/").filter(Boolean);
    const list = [{ name: "workspace", path: "" }];
    let acc = "";
    parts.forEach((p) => {
      acc = acc ? `${acc}/${p}` : p;
      list.push({ name: p, path: acc });
    });
    return list;
  }, [path]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get("/files/list", { params: { path } });
      setItems(r.data);
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => { load(); }, [load]);

  const openItem = (it) => {
    if (it.is_dir) {
      setParams({ path: it.path });
    } else if (/\.(py|txt|json|yaml|yml|md|env|ini|toml|cfg|sh|log)$/i.test(it.name)) {
      navigate(`/editor?path=${encodeURIComponent(it.path)}`);
    } else {
      downloadItem(it);
    }
  };

  const doUpload = async (files, mode) => {
    if (!files || !files.length) return;
    const t = toast.loading(`Uploading ${files.length} file${files.length > 1 ? "s" : ""}…`);
    try {
      for (const f of files) {
        const fd = new FormData();
        fd.append("dest", path);
        fd.append("file", f);
        const rel = f.webkitRelativePath || "";
        if (mode === "folder" && rel) fd.append("relative_path", rel);
        await api.post("/files/upload", fd, { headers: { "Content-Type": "multipart/form-data" } });
      }
      toast.dismiss(t);
      toast.success(`Uploaded ${files.length} file${files.length > 1 ? "s" : ""}`);
      load();
    } catch (e) {
      toast.dismiss(t);
      toast.error(formatError(e));
    }
  };

  const onDragOver = (e) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = (e) => { e.preventDefault(); setDragging(false); };
  const onDrop = async (e) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files || []);
    doUpload(files, "file");
  };

  const mkdir = async () => {
    if (!mkdirName.trim()) return;
    const full = path ? `${path}/${mkdirName.trim()}` : mkdirName.trim();
    try {
      await api.post("/files/mkdir", { path: full });
      setMkdirOpen(false);
      setMkdirName("");
      toast.success("Folder created");
      load();
    } catch (e) {
      toast.error(formatError(e));
    }
  };

  const doRename = async () => {
    if (!renameFor || !renameTo.trim()) return;
    const parent = path;
    const toPath = parent ? `${parent}/${renameTo.trim()}` : renameTo.trim();
    try {
      await api.post("/files/rename", { from_path: renameFor.path, to_path: toPath });
      setRenameFor(null);
      setRenameTo("");
      toast.success("Renamed");
      load();
    } catch (e) {
      toast.error(formatError(e));
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    try {
      await api.post("/files/delete", { path: confirmDelete.path });
      setConfirmDelete(null);
      toast.success("Deleted");
      load();
    } catch (e) {
      toast.error(formatError(e));
    }
  };

  const downloadItem = (it) => {
    const token = localStorage.getItem("psm_token");
    const url = `${api.defaults.baseURL}/files/download?path=${encodeURIComponent(it.path)}`;
    // Fetch with auth header, then blob download
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!r.ok) throw new Error("Download failed");
        return r.blob();
      })
      .then((blob) => {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = it.is_dir ? `${it.name}.zip` : it.name;
        link.click();
      })
      .catch(() => toast.error("Download failed"));
  };

  const createProjectFromFolder = async (it) => {
    setProjectFor({ root_dir: it.path, name: it.name });
  };

  return (
    <div
      className="p-4 md:p-6 min-h-[calc(100vh-2rem)]"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-amber-500 font-mono mb-1">/files</div>
          <h1 className="font-heading font-bold text-3xl">Files</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="refresh-files-btn"
            onClick={load}
            className="border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-100"
          >
            <RefreshCw className="w-4 h-4 mr-1.5" /> Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="new-folder-btn"
            onClick={() => setMkdirOpen(true)}
            className="border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-100"
          >
            <FolderPlus className="w-4 h-4 mr-1.5" /> New folder
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="upload-file-btn"
            onClick={() => fileInputRef.current?.click()}
            className="border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-100"
          >
            <Upload className="w-4 h-4 mr-1.5" /> Upload files
          </Button>
          <Button
            size="sm"
            data-testid="upload-folder-btn"
            onClick={() => folderInputRef.current?.click()}
            className="bg-amber-500 hover:bg-amber-600 text-zinc-950 font-semibold"
          >
            <FolderUp className="w-4 h-4 mr-1.5" /> Upload folder
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => doUpload(Array.from(e.target.files || []), "file")}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            hidden
            webkitdirectory=""
            onChange={(e) => doUpload(Array.from(e.target.files || []), "folder")}
          />
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-sm font-mono mb-4 bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 overflow-x-auto">
        {crumbs.map((c, i) => (
          <React.Fragment key={c.path + i}>
            {i > 0 && <ChevronRight className="w-3 h-3 text-zinc-600" />}
            <button
              data-testid={`crumb-${i}`}
              onClick={() => setParams({ path: c.path })}
              className={`px-1.5 py-0.5 rounded hover:bg-zinc-800 ${i === crumbs.length - 1 ? "text-amber-500" : "text-zinc-400"}`}
            >
              {i === 0 ? <Home className="w-3.5 h-3.5 inline mr-1" /> : null}
              {c.name}
            </button>
          </React.Fragment>
        ))}
      </div>

      {/* Content */}
      <div
        className={`bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden ${dragging ? "dropzone-active" : ""}`}
        data-testid="files-container"
      >
        <div className="grid grid-cols-12 text-[10px] uppercase tracking-[0.15em] text-zinc-500 font-mono border-b border-zinc-800 px-4 py-2.5 bg-black/40">
          <div className="col-span-6">Name</div>
          <div className="col-span-2">Size</div>
          <div className="col-span-3">Modified</div>
          <div className="col-span-1 text-right">Actions</div>
        </div>

        {loading ? (
          <div className="px-6 py-12 text-center text-zinc-500 font-mono text-sm">Loading…</div>
        ) : items.length === 0 ? (
          <div className="px-6 py-16 text-center text-zinc-500 space-y-2" data-testid="empty-state">
            <div className="mx-auto w-12 h-12 rounded-full bg-zinc-800 flex items-center justify-center">
              <Folder className="w-6 h-6 text-zinc-500" />
            </div>
            <p className="text-sm">This folder is empty.</p>
            <p className="text-xs text-zinc-600">Drag & drop files here or use the upload buttons.</p>
          </div>
        ) : (
          items.map((it) => (
            <div
              key={it.path}
              data-testid={`file-row-${it.name}`}
              className="grid grid-cols-12 items-center px-4 py-2.5 border-b border-zinc-800/60 hover:bg-zinc-800/40 group"
            >
              <button
                className="col-span-6 flex items-center gap-2 text-left truncate"
                onClick={() => openItem(it)}
                data-testid={`open-${it.name}`}
              >
                {it.is_dir ? (
                  <Folder className="w-4 h-4 text-amber-500 shrink-0" strokeWidth={1.75} />
                ) : /\.py$/i.test(it.name) ? (
                  <FileCode className="w-4 h-4 text-emerald-400 shrink-0" strokeWidth={1.75} />
                ) : (
                  <FileText className="w-4 h-4 text-zinc-400 shrink-0" strokeWidth={1.5} />
                )}
                <span className="truncate text-sm">{it.name}</span>
              </button>
              <div className="col-span-2 text-xs font-mono text-zinc-500">
                {it.is_dir ? "—" : humanBytes(it.size)}
              </div>
              <div className="col-span-3 text-xs font-mono text-zinc-500">{fmtDate(it.modified)}</div>
              <div className="col-span-1 flex justify-end">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      data-testid={`row-menu-${it.name}`}
                      className="w-8 h-8 flex items-center justify-center rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-100"
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="bg-zinc-900 border-zinc-800 text-zinc-200">
                    {it.is_dir && (
                      <DropdownMenuItem
                        data-testid={`create-project-${it.name}`}
                        onClick={() => createProjectFromFolder(it)}
                        className="focus:bg-amber-500/10 focus:text-amber-400"
                      >
                        <Rocket className="w-4 h-4 mr-2" /> Register as project
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => downloadItem(it)} data-testid={`download-${it.name}`}>
                      <Download className="w-4 h-4 mr-2" /> Download{it.is_dir ? " (zip)" : ""}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => { setRenameFor(it); setRenameTo(it.name); }}
                      data-testid={`rename-${it.name}`}
                    >
                      <Edit3 className="w-4 h-4 mr-2" /> Rename
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className="bg-zinc-800" />
                    <DropdownMenuItem
                      onClick={() => setConfirmDelete(it)}
                      data-testid={`delete-${it.name}`}
                      className="text-red-400 focus:text-red-400 focus:bg-red-500/10"
                    >
                      <Trash2 className="w-4 h-4 mr-2" /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))
        )}
      </div>

      {/* mkdir */}
      <Dialog open={mkdirOpen} onOpenChange={setMkdirOpen}>
        <DialogContent className="bg-zinc-950 border-zinc-800 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="font-heading">New folder</DialogTitle>
            <DialogDescription className="text-zinc-500">
              Create a folder inside <span className="font-mono text-amber-500">{path || "workspace"}</span>
            </DialogDescription>
          </DialogHeader>
          <Input
            data-testid="mkdir-name-input"
            value={mkdirName}
            onChange={(e) => setMkdirName(e.target.value)}
            placeholder="folder name"
            className="bg-zinc-900 border-zinc-800 font-mono"
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMkdirOpen(false)} className="text-zinc-400">Cancel</Button>
            <Button data-testid="mkdir-confirm-btn" onClick={mkdir} className="bg-amber-500 hover:bg-amber-600 text-zinc-950">Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* rename */}
      <Dialog open={!!renameFor} onOpenChange={(o) => !o && setRenameFor(null)}>
        <DialogContent className="bg-zinc-950 border-zinc-800 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="font-heading">Rename</DialogTitle>
            <DialogDescription className="text-zinc-500 font-mono">{renameFor?.path}</DialogDescription>
          </DialogHeader>
          <Input
            data-testid="rename-input"
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
            className="bg-zinc-900 border-zinc-800 font-mono"
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameFor(null)}>Cancel</Button>
            <Button data-testid="rename-confirm-btn" onClick={doRename} className="bg-amber-500 hover:bg-amber-600 text-zinc-950">Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* delete */}
      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="bg-zinc-950 border-zinc-800 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="font-heading">Delete?</DialogTitle>
            <DialogDescription className="text-zinc-500">
              This will permanently delete <span className="font-mono text-red-400">{confirmDelete?.path}</span>.
              {confirmDelete?.is_dir ? " Everything inside will be removed." : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button data-testid="delete-confirm-btn" onClick={doDelete} className="bg-red-500 hover:bg-red-600 text-white">Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* create project from folder */}
      <CreateProjectDialog
        open={!!projectFor}
        rootDir={projectFor?.root_dir}
        suggestedName={projectFor?.name}
        onClose={(created) => {
          setProjectFor(null);
          if (created) navigate(`/projects/${created.id}`);
        }}
      />
    </div>
  );
}

function CreateProjectDialog({ open, rootDir, suggestedName, onClose }) {
  const [name, setName] = useState("");
  const [startScript, setStartScript] = useState("");
  const [scripts, setScripts] = useState([]);
  const [autoRestart, setAutoRestart] = useState(false);
  const [autoPip, setAutoPip] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !rootDir) return;
    setName(suggestedName || "");
    setStartScript("");
    api.get("/files/list", { params: { path: rootDir } }).then((r) => {
      const py = r.data.filter((f) => !f.is_dir && /\.py$/i.test(f.name)).map((f) => f.name);
      setScripts(py);
      if (py.includes("main.py")) setStartScript("main.py");
      else if (py.length === 1) setStartScript(py[0]);
    }).catch(() => {});
  }, [open, rootDir, suggestedName]);

  const submit = async () => {
    if (!name || !startScript) {
      toast.error("Name and start script required");
      return;
    }
    setSaving(true);
    try {
      const r = await api.post("/projects", {
        name, root_dir: rootDir, start_script: startScript,
        args: "", env_vars: [],
        auto_restart_daily: autoRestart, daily_restart_hour: 3,
        auto_pip_update_daily: autoPip,
      });
      toast.success("Project registered");
      onClose(r.data);
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose(null)}>
      <DialogContent className="bg-zinc-950 border-zinc-800 text-zinc-100 max-w-md">
        <DialogHeader>
          <DialogTitle className="font-heading flex items-center gap-2">
            <Rocket className="w-5 h-5 text-amber-500" /> Register as project
          </DialogTitle>
          <DialogDescription className="text-zinc-500 font-mono">{rootDir}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-zinc-400">Project name</Label>
            <Input data-testid="new-project-name" value={name} onChange={(e) => setName(e.target.value)} className="bg-zinc-900 border-zinc-800 font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-zinc-400">Start script</Label>
            <select
              data-testid="new-project-script"
              value={startScript}
              onChange={(e) => setStartScript(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-amber-500"
            >
              <option value="">— pick a .py file —</option>
              {scripts.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            {scripts.length === 0 && <p className="text-[11px] text-red-400 font-mono">No .py files in this folder.</p>}
          </div>
          <div className="space-y-2 pt-1">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" data-testid="new-project-auto-restart" checked={autoRestart} onChange={(e) => setAutoRestart(e.target.checked)} className="accent-amber-500" />
              <span>Daily auto-restart</span>
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" data-testid="new-project-auto-pip" checked={autoPip} onChange={(e) => setAutoPip(e.target.checked)} className="accent-amber-500" />
              <span>Daily <code className="font-mono text-amber-400">pip install --upgrade</code></span>
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onClose(null)}>Cancel</Button>
          <Button data-testid="new-project-submit" disabled={saving} onClick={submit} className="bg-amber-500 hover:bg-amber-600 text-zinc-950">
            {saving ? "Creating…" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
