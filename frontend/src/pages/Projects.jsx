import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, formatError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Play, Square, RotateCw, Trash2, Plus, Boxes, Cpu, Activity, Terminal, Clock, PackageOpen } from "lucide-react";
import { toast } from "sonner";

function StatusPill({ status }) {
  const map = {
    running: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    stopped: "text-zinc-400 bg-zinc-500/10 border-zinc-500/20",
    errored: "text-red-400 bg-red-500/10 border-red-500/20",
  };
  return (
    <span className={`text-[10px] uppercase tracking-[0.15em] font-mono px-2 py-0.5 rounded border ${map[status] || map.stopped}`}>
      {status}
    </span>
  );
}

export default function Projects() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({}); // project_id -> stats
  const navigate = useNavigate();

  const load = async () => {
    try {
      const r = await api.get("/projects");
      setProjects(r.data);
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    const loadStats = async () => {
      const running = projects.filter((p) => p.status === "running");
      const s = {};
      await Promise.all(running.map(async (p) => {
        try {
          const r = await api.get(`/projects/${p.id}/stats`);
          s[p.id] = r.data;
        } catch { /* ignore */ }
      }));
      if (alive) setStats(s);
    };
    if (projects.length) loadStats();
    return () => { alive = false; };
  }, [projects]);

  const doAction = async (p, action) => {
    const t = toast.loading(`${action}…`);
    try {
      await api.post(`/projects/${p.id}/${action}`);
      toast.dismiss(t);
      toast.success(`${p.name}: ${action} ok`);
      load();
    } catch (e) {
      toast.dismiss(t);
      toast.error(formatError(e));
    }
  };

  const doDelete = async (p) => {
    if (!window.confirm(`Delete project "${p.name}"? This does not delete files.`)) return;
    try {
      await api.delete(`/projects/${p.id}`);
      toast.success("Deleted");
      load();
    } catch (e) {
      toast.error(formatError(e));
    }
  };

  return (
    <div className="p-4 md:p-6">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-amber-500 font-mono mb-1">/projects</div>
          <h1 className="font-heading font-bold text-3xl">Projects</h1>
          <p className="text-sm text-zinc-500 mt-1">All the Python scripts you manage. Each has its own isolated <code className="font-mono text-amber-400">.venv</code>.</p>
        </div>
        <Button
          onClick={() => navigate("/files")}
          data-testid="go-to-files-btn"
          className="bg-amber-500 hover:bg-amber-600 text-zinc-950 font-semibold"
        >
          <Plus className="w-4 h-4 mr-1.5" /> Register new project
        </Button>
      </div>

      {loading ? (
        <div className="text-zinc-500 font-mono text-sm">Loading…</div>
      ) : projects.length === 0 ? (
        <div className="border border-dashed border-zinc-800 rounded-lg p-12 text-center bg-zinc-950" data-testid="projects-empty">
          <div className="mx-auto w-14 h-14 rounded-full bg-amber-500/10 flex items-center justify-center mb-3">
            <Boxes className="w-7 h-7 text-amber-500" />
          </div>
          <h2 className="font-heading font-bold text-xl mb-2">No projects yet</h2>
          <p className="text-sm text-zinc-500 mb-5 max-w-md mx-auto">
            Upload a folder containing your Python script in <b>Files</b>, then click the row menu and select <i>Register as project</i>.
          </p>
          <Button onClick={() => navigate("/files")} className="bg-amber-500 hover:bg-amber-600 text-zinc-950 font-semibold">
            Go to Files
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((p) => {
            const s = stats[p.id];
            return (
              <div
                key={p.id}
                data-testid={`project-card-${p.name}`}
                className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden hover:border-zinc-700 transition-colors"
              >
                <div className="px-4 py-3 border-b border-zinc-800 bg-black/40 flex items-center justify-between">
                  <Link to={`/projects/${p.id}`} className="font-heading font-semibold text-lg hover:text-amber-400 truncate">
                    {p.name}
                  </Link>
                  <StatusPill status={p.status} />
                </div>
                <div className="p-4 space-y-3">
                  <div className="text-xs font-mono text-zinc-500 space-y-1">
                    <div className="flex items-center gap-1.5 truncate">
                      <Terminal className="w-3 h-3 shrink-0" /> <span className="truncate">{p.root_dir}/{p.start_script}</span>
                    </div>
                    {p.auto_restart_daily && (
                      <div className="flex items-center gap-1.5 text-amber-400/80">
                        <Clock className="w-3 h-3" /> daily @ {String(p.daily_restart_hour).padStart(2, "0")}:00 UTC
                        {p.auto_pip_update_daily && <span className="ml-1 text-zinc-500">+ pip upgrade</span>}
                      </div>
                    )}
                    {p.venv_created && (
                      <div className="flex items-center gap-1.5 text-emerald-400/80">
                        <PackageOpen className="w-3 h-3" /> venv ready
                      </div>
                    )}
                  </div>

                  {s?.running && (
                    <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                      <div className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 flex items-center justify-between">
                        <span className="flex items-center gap-1 text-zinc-500"><Cpu className="w-3 h-3" /> CPU</span>
                        <span className="text-emerald-400">{s.cpu_percent}%</span>
                      </div>
                      <div className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 flex items-center justify-between">
                        <span className="flex items-center gap-1 text-zinc-500"><Activity className="w-3 h-3" /> MEM</span>
                        <span className="text-emerald-400">{s.memory_mb} MB</span>
                      </div>
                    </div>
                  )}

                  {p.last_error && (
                    <div className="text-[11px] text-red-400 font-mono truncate border border-red-500/20 bg-red-500/5 rounded px-2 py-1" title={p.last_error}>
                      {p.last_error}
                    </div>
                  )}

                  <div className="flex items-center gap-1 pt-1">
                    {p.status === "running" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`stop-btn-${p.name}`}
                        onClick={() => doAction(p, "stop")}
                        className="border-zinc-800 bg-zinc-950 hover:bg-zinc-800 text-zinc-100"
                      >
                        <Square className="w-3.5 h-3.5 mr-1" /> Stop
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        data-testid={`start-btn-${p.name}`}
                        onClick={() => doAction(p, "start")}
                        className="bg-emerald-500/90 hover:bg-emerald-500 text-black font-semibold"
                      >
                        <Play className="w-3.5 h-3.5 mr-1" /> Start
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`restart-btn-${p.name}`}
                      onClick={() => doAction(p, "restart")}
                      className="border-zinc-800 bg-zinc-950 hover:bg-zinc-800 text-zinc-100"
                    >
                      <RotateCw className="w-3.5 h-3.5 mr-1" /> Restart
                    </Button>
                    <Link
                      to={`/projects/${p.id}`}
                      data-testid={`open-project-${p.name}`}
                      className="ml-auto text-xs font-mono text-amber-500 hover:text-amber-400 px-2 py-1"
                    >
                      Open →
                    </Link>
                    <button
                      onClick={() => doDelete(p)}
                      data-testid={`delete-project-${p.name}`}
                      className="text-zinc-500 hover:text-red-400 p-1.5 rounded hover:bg-red-500/10"
                      title="Delete project"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
