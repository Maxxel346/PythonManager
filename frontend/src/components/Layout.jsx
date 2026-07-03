import React from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  FolderTree,
  Boxes,
  Terminal,
  LogOut,
  Cpu,
  HardDrive,
  Activity,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { api } from "@/lib/api";
import { useEffect, useState } from "react";

const nav = [
  { to: "/projects", icon: Boxes, label: "Projects", testid: "nav-projects" },
  { to: "/files", icon: FolderTree, label: "Files", testid: "nav-files" },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.get("/system/stats").then((r) => alive && setStats(r.data)).catch(() => {});
    };
    load();
    api.get("/system/info").then((r) => alive && setInfo(r.data)).catch(() => {});
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const doLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <div className="min-h-screen flex bg-zinc-950 text-zinc-100">
      <aside className="w-16 bg-black border-r border-zinc-900 flex flex-col items-center py-4 fixed inset-y-0 left-0 z-40">
        <div className="w-9 h-9 rounded-md bg-amber-500 text-black flex items-center justify-center font-black font-heading mb-6 shadow-[0_0_20px_rgba(245,158,11,0.35)]" data-testid="brand-logo">
          <Terminal className="w-5 h-5" strokeWidth={2} />
        </div>
        <nav className="flex flex-col gap-1 items-center">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              data-testid={n.testid}
              title={n.label}
              className={({ isActive }) =>
                `w-10 h-10 flex items-center justify-center rounded-md transition-colors ${
                  isActive
                    ? "bg-amber-500/10 text-amber-500 border border-amber-500/30"
                    : "text-zinc-500 hover:text-zinc-100 hover:bg-zinc-900"
                }`
              }
            >
              <n.icon className="w-5 h-5" strokeWidth={1.5} />
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex flex-col items-center gap-2">
          <button
            onClick={doLogout}
            data-testid="logout-button"
            title={`Logout (${user?.username})`}
            className="w-10 h-10 flex items-center justify-center rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <LogOut className="w-5 h-5" strokeWidth={1.5} />
          </button>
        </div>
      </aside>

      <main className="flex-1 ml-16 pb-10">
        <Outlet />
      </main>

      <footer
        data-testid="status-bar"
        className="fixed bottom-0 left-16 right-0 h-8 bg-black border-t border-zinc-900 flex items-center px-4 text-[11px] font-mono text-zinc-500 z-30 gap-6"
      >
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          ONLINE
        </span>
        {info && (
          <span className="hidden sm:inline">python {info.python_version}</span>
        )}
        {stats && (
          <>
            <span className="flex items-center gap-1.5" data-testid="status-cpu">
              <Cpu className="w-3 h-3" /> CPU {stats.cpu_percent?.toFixed?.(0)}%
            </span>
            <span className="flex items-center gap-1.5" data-testid="status-mem">
              <Activity className="w-3 h-3" /> MEM {stats.memory_percent?.toFixed?.(0)}%
            </span>
            <span className="flex items-center gap-1.5" data-testid="status-disk">
              <HardDrive className="w-3 h-3" /> DISK {stats.disk_percent?.toFixed?.(0)}%
            </span>
          </>
        )}
        <span className="ml-auto text-zinc-600">
          {user?.username ? `@${user.username}` : ""}
        </span>
      </footer>
    </div>
  );
}
