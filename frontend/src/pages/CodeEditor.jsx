import React, { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { api, formatError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Save } from "lucide-react";
import { toast } from "sonner";

export default function CodeEditor() {
  const [params] = useSearchParams();
  const path = params.get("path") || "";
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const parentPath = path.split("/").slice(0, -1).join("/");
  const filename = path.split("/").pop() || path;

  useEffect(() => {
    if (!path) return;
    setLoading(true);
    api.get("/files/read", { params: { path } })
      .then((r) => { setContent(r.data.content || ""); setDirty(false); })
      .catch((e) => toast.error(formatError(e)))
      .finally(() => setLoading(false));
  }, [path]);

  const save = async () => {
    setSaving(true);
    try {
      await api.put("/files/write", { path, content });
      toast.success("Saved");
      setDirty(false);
    } catch (e) { toast.error(formatError(e)); }
    finally { setSaving(false); }
  };

  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault(); if (dirty) save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  return (
    <div className="p-4 md:p-6">
      <div className="flex items-center gap-3 mb-4">
        <Link to={`/files?path=${encodeURIComponent(parentPath)}`} data-testid="editor-back" className="text-zinc-500 hover:text-zinc-100"><ArrowLeft className="w-5 h-5" /></Link>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-[0.25em] text-amber-500 font-mono mb-1">/editor</div>
          <div className="flex items-center gap-2">
            <h1 className="font-heading font-bold text-2xl truncate">{filename}</h1>
            {dirty && <span className="text-[10px] font-mono uppercase tracking-wider text-amber-400 border border-amber-500/30 px-1.5 py-0.5 rounded">unsaved</span>}
          </div>
          <p className="text-xs font-mono text-zinc-500 truncate">{path}</p>
        </div>
        <Button data-testid="editor-save-btn" onClick={save} disabled={!dirty || saving} className="bg-amber-500 hover:bg-amber-600 text-zinc-950 disabled:opacity-50">
          <Save className="w-4 h-4 mr-1.5" /> {saving ? "Saving…" : "Save"}
        </Button>
      </div>

      {loading ? (
        <div className="text-zinc-500 font-mono text-sm">Loading…</div>
      ) : (
        <textarea
          data-testid="editor-textarea"
          className="code-editor-textarea"
          value={content}
          onChange={(e) => { setContent(e.target.value); setDirty(true); }}
          spellCheck={false}
        />
      )}
      <p className="text-[11px] text-zinc-600 font-mono mt-2">Cmd/Ctrl + S to save. Max size 2 MB.</p>
    </div>
  );
}
