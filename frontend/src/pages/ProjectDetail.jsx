import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, formatError, API_BASE } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ArrowLeft, Play, Square, RotateCw, PackageOpen, Trash2, Save, Plus,
  ScrollText, Eraser, Cpu, Activity, Clock, Terminal, Radio,
} from "lucide-react";
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

function useLogSocket(projectId, enabled) {
  const [content, setContent] = useState("");
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);

  useEffect(() => {
    if (!enabled || !projectId) return;
    const token = localStorage.getItem("psm_token");
    if (!token) return;
    // Build ws url from API_BASE (works with absolute preview URL AND relative "/api" behind nginx)
    let wsBase;
    if (API_BASE.startsWith("http")) {
      wsBase = API_BASE.replace(/^http/, "ws");
    } else {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      wsBase = `${proto}//${window.location.host}${API_BASE}`;
    }
    const url = `${wsBase}/ws/logs/${projectId}?token=${encodeURIComponent(token)}`;
    let closed = false;
    setContent("");
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onmessage = (e) => setContent((prev) => (prev + e.data).slice(-200000));
    ws.onerror = () => setConnected(false);
    ws.onclose = () => { setConnected(false); if (closed) return; };
    return () => { closed = true; try { ws.close(); } catch { /* ignore */ } };
  }, [projectId, enabled]);

  const clear = () => setContent("");
  return { content, connected, clear };
}

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [proj, setProj] = useState(null);
  const [stats, setStats] = useState(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [installing, setInstalling] = useState(false);
  const logRef = useRef(null);
  const { content: logs, connected: wsConnected, clear: clearLocal } = useLogSocket(id, !!proj);

  const load = async () => {
    try {
      const r = await api.get(`/projects/${id}`);
      setProj(r.data);
    } catch (e) {
      toast.error(formatError(e));
      navigate("/projects");
    }
  };

  const loadStats = async () => {
    try {
      const r = await api.get(`/projects/${id}/stats`);
      setStats(r.data);
    } catch { /* ignore */ }
  };

  useEffect(() => { load(); loadStats(); }, [id]);

  useEffect(() => {
    const t = setInterval(() => { loadStats(); load(); }, 3500);
    return () => clearInterval(t);
  }, [id]);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const doAction = async (action) => {
    const t = toast.loading(`${action}…`);
    try {
      await api.post(`/projects/${id}/${action}`);
      toast.dismiss(t); toast.success(action + " ok");
      load();
    } catch (e) { toast.dismiss(t); toast.error(formatError(e)); }
  };

  const install = async (upgrade = false) => {
    setInstalling(true);
    const t = toast.loading(upgrade ? "pip install --upgrade…" : "pip install…");
    try {
      const r = await api.post(`/projects/${id}/install`, null, { params: { upgrade } });
      toast.dismiss(t);
      if (r.data.returncode === 0) toast.success("pip install ok");
      else toast.error(`pip returned ${r.data.returncode}`);
      load();
    } catch (e) { toast.dismiss(t); toast.error(formatError(e)); }
    finally { setInstalling(false); }
  };

  const clearLogs = async () => {
    try {
      await api.post(`/projects/${id}/logs/clear`);
      clearLocal();
      toast.success("Logs cleared");
    } catch (e) { toast.error(formatError(e)); }
  };

  const savePatch = async (patch) => {
    try {
      const r = await api.put(`/projects/${id}`, patch);
      setProj(r.data);
      toast.success("Saved");
    } catch (e) { toast.error(formatError(e)); }
  };

  if (!proj) {
    return <div className="p-6 text-zinc-500 font-mono text-sm">Loading…</div>;
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Link to="/projects" className="text-zinc-500 hover:text-zinc-100" data-testid="back-to-projects"><ArrowLeft className="w-5 h-5" /></Link>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-[0.25em] text-amber-500 font-mono mb-1">/projects/{proj.id.slice(0, 8)}</div>
          <div className="flex items-center gap-3">
            <h1 className="font-heading font-bold text-2xl truncate">{proj.name}</h1>
            <StatusPill status={proj.status} />
            {proj.restart_count > 0 && (
              <span className="text-[10px] uppercase tracking-wider font-mono text-amber-400 border border-amber-500/30 px-1.5 py-0.5 rounded" data-testid="restart-count">
                restarted ×{proj.restart_count}
              </span>
            )}
          </div>
          <p className="text-xs font-mono text-zinc-500 mt-1 truncate">
            <Terminal className="w-3 h-3 inline mr-1" />
            {proj.root_dir}/{proj.start_script} {proj.args && <span className="text-zinc-600">— {proj.args}</span>}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {proj.status === "running" ? (
            <Button data-testid="detail-stop-btn" onClick={() => doAction("stop")} variant="outline" className="border-zinc-800 bg-zinc-900 hover:bg-zinc-800">
              <Square className="w-4 h-4 mr-1.5" /> Stop
            </Button>
          ) : (
            <Button data-testid="detail-start-btn" onClick={() => doAction("start")} className="bg-emerald-500/90 hover:bg-emerald-500 text-black font-semibold">
              <Play className="w-4 h-4 mr-1.5" /> Start
            </Button>
          )}
          <Button data-testid="detail-restart-btn" onClick={() => doAction("restart")} variant="outline" className="border-zinc-800 bg-zinc-900 hover:bg-zinc-800">
            <RotateCw className="w-4 h-4 mr-1.5" /> Restart
          </Button>
          <Button data-testid="detail-install-btn" onClick={() => install(false)} disabled={installing} variant="outline" className="border-zinc-800 bg-zinc-900 hover:bg-zinc-800">
            <PackageOpen className="w-4 h-4 mr-1.5" /> pip install
          </Button>
        </div>
      </div>

      {stats?.running && (
        <div className="flex gap-2 flex-wrap">
          <div className="bg-zinc-900 border border-zinc-800 rounded px-3 py-1.5 text-xs font-mono flex items-center gap-2">
            <Cpu className="w-3.5 h-3.5 text-zinc-500" /> CPU <span className="text-emerald-400">{stats.cpu_percent}%</span>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded px-3 py-1.5 text-xs font-mono flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-zinc-500" /> MEM <span className="text-emerald-400">{stats.memory_mb} MB</span>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded px-3 py-1.5 text-xs font-mono flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-zinc-500" /> PID <span className="text-zinc-100">{stats.pid}</span>
          </div>
        </div>
      )}

      <Tabs defaultValue="logs" className="w-full">
        <TabsList className="bg-zinc-900 border border-zinc-800">
          <TabsTrigger value="logs" data-testid="tab-logs" className="data-[state=active]:bg-amber-500/10 data-[state=active]:text-amber-400"><ScrollText className="w-4 h-4 mr-1.5" />Logs</TabsTrigger>
          <TabsTrigger value="env" data-testid="tab-env" className="data-[state=active]:bg-amber-500/10 data-[state=active]:text-amber-400">Environment</TabsTrigger>
          <TabsTrigger value="settings" data-testid="tab-settings" className="data-[state=active]:bg-amber-500/10 data-[state=active]:text-amber-400">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="logs" className="mt-3">
          <div className="flex items-center gap-2 mb-2">
            <label className="text-xs font-mono flex items-center gap-1.5 text-zinc-500">
              <input type="checkbox" data-testid="autoscroll-toggle" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} className="accent-amber-500" />
              auto-scroll
            </label>
            <span className={`text-[10px] font-mono px-2 py-0.5 rounded border flex items-center gap-1 ${wsConnected ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/5" : "text-zinc-500 border-zinc-800"}`} data-testid="ws-status">
              <Radio className={`w-3 h-3 ${wsConnected ? "animate-pulse" : ""}`} /> {wsConnected ? "LIVE" : "OFFLINE"}
            </span>
            <div className="ml-auto flex gap-1.5">
              <Button size="sm" variant="outline" data-testid="clear-logs-btn" onClick={clearLogs} className="border-zinc-800 bg-zinc-900 hover:bg-zinc-800"><Eraser className="w-3.5 h-3.5 mr-1" />Clear</Button>
            </div>
          </div>
          <div ref={logRef} className="log-viewer h-[62vh]" data-testid="log-viewer">
            {logs || "(no output yet — logs will appear here in real time when the process runs)"}
          </div>
        </TabsContent>

        <TabsContent value="env" className="mt-3">
          <EnvEditor project={proj} onSave={(vars) => savePatch({ env_vars: vars })} />
        </TabsContent>

        <TabsContent value="settings" className="mt-3">
          <SettingsEditor project={proj} onSave={savePatch} onDelete={async () => {
            if (!window.confirm("Delete this project? Files stay on disk.")) return;
            await api.delete(`/projects/${id}`);
            toast.success("Deleted"); navigate("/projects");
          }} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function EnvEditor({ project, onSave }) {
  const [vars, setVars] = useState(project.env_vars || []);
  useEffect(() => { setVars(project.env_vars || []); }, [project.id]);
  const add = () => setVars((v) => [...v, { key: "", value: "" }]);
  const remove = (i) => setVars((v) => v.filter((_, idx) => idx !== i));
  const upd = (i, field, val) => setVars((v) => v.map((r, idx) => idx === i ? { ...r, [field]: val } : r));
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-heading font-semibold">Environment variables</h3>
          <p className="text-xs text-zinc-500">Injected into the process when it starts.</p>
        </div>
        <Button size="sm" variant="outline" data-testid="add-env-btn" onClick={add} className="border-zinc-800 bg-zinc-950 hover:bg-zinc-800"><Plus className="w-3.5 h-3.5 mr-1" />Add</Button>
      </div>
      <div className="space-y-2">
        {vars.length === 0 && <p className="text-xs text-zinc-500 font-mono">No env vars.</p>}
        {vars.map((r, i) => (
          <div key={i} className="grid grid-cols-12 gap-2">
            <Input data-testid={`env-key-${i}`} placeholder="KEY" value={r.key} onChange={(e) => upd(i, "key", e.target.value)} className="col-span-4 bg-zinc-950 border-zinc-800 font-mono text-sm" />
            <Input data-testid={`env-value-${i}`} placeholder="value" value={r.value} onChange={(e) => upd(i, "value", e.target.value)} className="col-span-7 bg-zinc-950 border-zinc-800 font-mono text-sm" />
            <button data-testid={`env-remove-${i}`} onClick={() => remove(i)} className="col-span-1 flex items-center justify-center text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <Button data-testid="save-env-btn" onClick={() => onSave(vars.filter((r) => r.key.trim()))} className="bg-amber-500 hover:bg-amber-600 text-zinc-950">
          <Save className="w-4 h-4 mr-1.5" /> Save
        </Button>
      </div>
    </div>
  );
}

function SettingsEditor({ project, onSave, onDelete }) {
  const [name, setName] = useState(project.name);
  const [startScript, setStartScript] = useState(project.start_script);
  const [args, setArgs] = useState(project.args || "");
  const [autoRestart, setAutoRestart] = useState(!!project.auto_restart_daily);
  const [scheduleType, setScheduleType] = useState(project.schedule_type || "daily");
  const [hour, setHour] = useState(project.daily_restart_hour ?? 3);
  const [cronExpression, setCronExpression] = useState(project.cron_expression || "");
  const [autoPip, setAutoPip] = useState(!!project.auto_pip_update_daily);
  const [crashRestart, setCrashRestart] = useState(!!project.auto_restart_on_crash);
  const [maxRestarts, setMaxRestarts] = useState(project.max_restarts ?? 3);
  const [backoff, setBackoff] = useState(project.restart_backoff_seconds ?? 5);

  useEffect(() => {
    setName(project.name); setStartScript(project.start_script); setArgs(project.args || "");
    setAutoRestart(!!project.auto_restart_daily);
    setScheduleType(project.schedule_type || "daily");
    setHour(project.daily_restart_hour ?? 3);
    setCronExpression(project.cron_expression || "");
    setAutoPip(!!project.auto_pip_update_daily);
    setCrashRestart(!!project.auto_restart_on_crash);
    setMaxRestarts(project.max_restarts ?? 3);
    setBackoff(project.restart_backoff_seconds ?? 5);
  }, [project.id]);

  const save = () => onSave({
    name, start_script: startScript, args,
    auto_restart_daily: autoRestart, daily_restart_hour: Number(hour) || 0,
    auto_pip_update_daily: autoPip,
    schedule_type: scheduleType,
    cron_expression: cronExpression,
    auto_restart_on_crash: crashRestart,
    max_restarts: Number(maxRestarts) || 0,
    restart_backoff_seconds: Number(backoff) || 5,
  });

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-5">
      <div>
        <h3 className="font-heading font-semibold">Settings</h3>
        <p className="text-xs text-zinc-500 font-mono mt-1">root_dir: {project.root_dir}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs uppercase tracking-wider text-zinc-400">Name</Label>
          <Input data-testid="settings-name" value={name} onChange={(e) => setName(e.target.value)} className="bg-zinc-950 border-zinc-800 font-mono" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs uppercase tracking-wider text-zinc-400">Start script (relative)</Label>
          <Input data-testid="settings-start-script" value={startScript} onChange={(e) => setStartScript(e.target.value)} className="bg-zinc-950 border-zinc-800 font-mono" />
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <Label className="text-xs uppercase tracking-wider text-zinc-400">CLI arguments</Label>
          <Input data-testid="settings-args" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="--flag value" className="bg-zinc-950 border-zinc-800 font-mono" />
        </div>
      </div>

      {/* Scheduled restart */}
      <div className="border-t border-zinc-800 pt-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Scheduled restart</div>
            <div className="text-xs text-zinc-500">Cron-triggered restart. Optionally does <code className="font-mono text-amber-400">pip install --upgrade</code> first.</div>
          </div>
          <Switch data-testid="settings-auto-restart" checked={autoRestart} onCheckedChange={setAutoRestart} />
        </div>
        {autoRestart && (
          <div className="pl-3 border-l-2 border-amber-500/30 space-y-3">
            <div className="flex items-center gap-2 text-xs font-mono">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" name="sched" data-testid="sched-type-daily" checked={scheduleType === "daily"} onChange={() => setScheduleType("daily")} className="accent-amber-500" />
                <span>Daily at hour</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer ml-4">
                <input type="radio" name="sched" data-testid="sched-type-cron" checked={scheduleType === "cron"} onChange={() => setScheduleType("cron")} className="accent-amber-500" />
                <span>Custom cron</span>
              </label>
            </div>
            {scheduleType === "daily" ? (
              <div className="flex items-center gap-3">
                <Label className="text-xs uppercase tracking-wider text-zinc-400">Hour (UTC 0-23)</Label>
                <Input data-testid="settings-hour" type="number" min="0" max="23" value={hour} onChange={(e) => setHour(e.target.value)} className="bg-zinc-950 border-zinc-800 font-mono w-24" />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-xs uppercase tracking-wider text-zinc-400">Cron expression (UTC)</Label>
                <Input
                  data-testid="settings-cron-expression"
                  value={cronExpression}
                  onChange={(e) => setCronExpression(e.target.value)}
                  placeholder="*/30 * * * *  (every 30 min)"
                  className="bg-zinc-950 border-zinc-800 font-mono"
                />
                <p className="text-[11px] text-zinc-600 font-mono">Format: <code>m h dom mon dow</code>. Examples: <code>0 */6 * * *</code> every 6h · <code>0 3 * * 1</code> Mondays 03:00 UTC</p>
              </div>
            )}
            <div className="flex items-center justify-between">
              <div className="text-xs">Also run <code className="font-mono text-amber-400">pip install --upgrade</code> before restart</div>
              <Switch data-testid="settings-auto-pip" checked={autoPip} onCheckedChange={setAutoPip} />
            </div>
          </div>
        )}
      </div>

      {/* Crash recovery */}
      <div className="border-t border-zinc-800 pt-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Auto-restart on crash</div>
            <div className="text-xs text-zinc-500">If the process exits unexpectedly, restart with backoff. Counter resets after 60s of stable uptime.</div>
          </div>
          <Switch data-testid="settings-crash-restart" checked={crashRestart} onCheckedChange={setCrashRestart} />
        </div>
        {crashRestart && (
          <div className="pl-3 border-l-2 border-amber-500/30 grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wider text-zinc-400">Max restarts (0 = unlimited)</Label>
              <Input data-testid="settings-max-restarts" type="number" min="0" value={maxRestarts} onChange={(e) => setMaxRestarts(e.target.value)} className="bg-zinc-950 border-zinc-800 font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wider text-zinc-400">Backoff seconds</Label>
              <Input data-testid="settings-backoff" type="number" min="1" value={backoff} onChange={(e) => setBackoff(e.target.value)} className="bg-zinc-950 border-zinc-800 font-mono" />
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-between pt-3 border-t border-zinc-800">
        <Button data-testid="delete-project-btn" onClick={onDelete} variant="outline" className="border-red-500/30 bg-red-500/5 hover:bg-red-500/10 text-red-400">
          <Trash2 className="w-4 h-4 mr-1.5" /> Delete project
        </Button>
        <Button data-testid="save-settings-btn" onClick={save} className="bg-amber-500 hover:bg-amber-600 text-zinc-950">
          <Save className="w-4 h-4 mr-1.5" /> Save changes
        </Button>
      </div>
    </div>
  );
}
