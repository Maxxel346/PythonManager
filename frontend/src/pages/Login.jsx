import React, { useState } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Terminal, LogIn } from "lucide-react";
import { formatError } from "@/lib/api";

export default function Login() {
  const { user, ready, login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  if (ready && user) return <Navigate to="/projects" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      await login(username.trim(), password);
      navigate("/projects");
    } catch (e2) {
      setErr(formatError(e2));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid md:grid-cols-2 bg-zinc-950 text-zinc-100">
      <div
        className="hidden md:flex relative items-end p-10 bg-cover bg-center"
        style={{
          backgroundImage:
            "linear-gradient(rgba(0,0,0,0.55), rgba(0,0,0,0.85)), url(https://images.pexels.com/photos/13156181/pexels-photo-13156181.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940)",
        }}
      >
        <div className="max-w-md space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-amber-500 text-black flex items-center justify-center">
              <Terminal className="w-5 h-5" />
            </div>
            <span className="font-heading font-black text-2xl tracking-tight">PYMANAGER</span>
          </div>
          <h1 className="font-heading font-black text-4xl leading-[1.05] tracking-tight">
            Command center for your Python scripts.
          </h1>
          <p className="text-sm text-zinc-400 font-mono">
            Upload · Isolate venvs · Schedule · Watch logs · One click.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-center p-6 md:p-12">
        <form
          onSubmit={submit}
          className="w-full max-w-sm space-y-6"
          data-testid="login-form"
        >
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-[0.25em] text-amber-500 font-mono">
              /auth
            </div>
            <h2 className="font-heading font-bold text-3xl">Sign in</h2>
            <p className="text-sm text-zinc-500">Use your admin credentials.</p>
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="username" className="text-xs uppercase tracking-wider text-zinc-400">
                Username
              </Label>
              <Input
                id="username"
                data-testid="login-username-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                className="bg-zinc-950 border-zinc-800 font-mono focus-visible:ring-amber-500 focus-visible:border-amber-500"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-xs uppercase tracking-wider text-zinc-400">
                Password
              </Label>
              <Input
                id="password"
                data-testid="login-password-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="bg-zinc-950 border-zinc-800 font-mono focus-visible:ring-amber-500 focus-visible:border-amber-500"
                required
              />
            </div>
          </div>

          {err && (
            <div
              data-testid="login-error"
              className="text-xs text-red-400 font-mono border border-red-500/20 bg-red-500/5 px-3 py-2 rounded"
            >
              {err}
            </div>
          )}

          <Button
            data-testid="login-submit-button"
            type="submit"
            disabled={loading}
            className="w-full bg-amber-500 hover:bg-amber-600 text-zinc-950 font-semibold"
          >
            <LogIn className="w-4 h-4 mr-2" />
            {loading ? "Signing in…" : "Sign in"}
          </Button>

          <p className="text-[11px] text-zinc-600 font-mono text-center">
            Default: admin / admin123 (change via <code>backend/.env</code>)
          </p>
        </form>
      </div>
    </div>
  );
}
