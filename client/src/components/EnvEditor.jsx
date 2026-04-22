import { useState, useEffect } from "react";
import api from "../api/client";

export default function EnvEditor({ botId }) {
    const [content, setContent] = useState("");
    const [original, setOriginal] = useState(""); // to detect unsaved changes
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState(null); // { type: 'success'|'error', text }

    // Load .env on mount
    useEffect(() => {
        api.get(`/bots/${botId}/env`)
            .then((r) => {
                setContent(r.data.content);
                setOriginal(r.data.content);
            })
            .catch(() => setMsg({ type: "error", text: "Failed to load .env" }))
            .finally(() => setLoading(false));
    }, [botId]);

    const save = async () => {
        setSaving(true);
        setMsg(null);
        try {
            await api.put(`/bots/${botId}/env`, { content });
            setOriginal(content);
            setMsg({ type: "success", text: "✅ .env saved successfully" });
        } catch (err) {
            setMsg({
                type: "error",
                text: err.response?.data?.error || "Save failed",
            });
        } finally {
            setSaving(false);
        }
    };

    const isDirty = content !== original;

    if (loading) {
        return (
            <div className="flex items-center justify-center h-32">
                <div className="animate-spin h-6 w-6 border-4 border-indigo-500 border-t-transparent rounded-full" />
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            {/* Toolbar */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-200">
                        📝 .env Editor
                    </span>
                    {isDirty && (
                        <span className="text-xs text-amber-400 bg-amber-900/30 border border-amber-800 px-2 py-0.5 rounded">
                            Unsaved changes
                        </span>
                    )}
                </div>
                <button
                    className="btn-primary text-xs py-1.5"
                    onClick={save}
                    disabled={saving || !isDirty}
                >
                    {saving ? "Saving…" : "💾 Save"}
                </button>
            </div>

            {/* Editor */}
            <textarea
                className="input font-mono text-xs leading-relaxed resize-none h-72"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={
                    "TOKEN=your_token_here\nPREFIX=!\n# Add your env vars here"
                }
                spellCheck={false}
            />

            {/* Feedback */}
            {msg && (
                <div
                    className={`text-sm rounded-lg px-3 py-2 border ${
                        msg.type === "success"
                            ? "bg-emerald-900/40 border-emerald-700 text-emerald-400"
                            : "bg-red-900/40 border-red-700 text-red-400"
                    }`}
                >
                    {msg.text}
                </div>
            )}

            <p className="text-xs text-slate-500">
                ⚠️ Restart the bot after saving for changes to take effect.
            </p>
        </div>
    );
}
