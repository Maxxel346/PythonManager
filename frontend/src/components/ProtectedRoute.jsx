import React from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";

export default function ProtectedRoute({ children }) {
  const { user, ready } = useAuth();
  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-500 font-mono text-sm">
        <span data-testid="auth-loading">Loading…</span>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}
