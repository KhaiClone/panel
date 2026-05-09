import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import api from "../api/client";

// ── Helpers ────────────────────────────────────────────────────────────────

const defaultForm = {
    // common
    source: "git", // "git" | "local"
    buyerID: "",
    botID: "",
    name: "",
    startScript: "npm start",
    expiresAt: "",
    groupId: "",
    maxMemory: "",
    currentPrice: "",
    // git-only
    repoUrl: "",
    branch: "main",
    // local-only
    localPath: "",
    installCommand: "npm install --omit=dev",
};

const MEM_HINT = 'e.g. "300M", "1G" — leave blank for no limit';

export default function CreateBotModal({ onClose, onCreated }) {
    const [form, setForm] = useState(defaultForm);
    const [groups, setGroups] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    // Fetch groups for the dropdown
    useEffect(() => {
        api.get("/groups")
            .then((r) => setGroups(r.data))
            .catch(() => {});
    }, []);

    const set = (field) => (e) => {
        const val =
            e.target.type === "checkbox" ? e.target.checked : e.target.value;
        setForm((f) => ({ ...f, [field]: val }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        setLoading(true);

        try {
            const endpoint =
                form.source === "local" ? "/bots/import-local" : "/bots";

            const payload =
                form.source === "git"
                    ? {
                          buyerID: form.buyerID,
                          botID: form.botID,
                          name: form.name,
                          repoUrl: form.repoUrl,
                          branch: form.branch || "main",
                          startScript: form.startScript || "npm start",
                          installCommand: form.installCommand || null,
                          expiresAt: form.expiresAt
                              ? new Date(form.expiresAt).toISOString()
                              : null,
                          groupId: form.groupId || null,
                          maxMemory: form.maxMemory || null,
                          currentPrice: form.currentPrice
                              ? Number(form.currentPrice)
                              : null,
                      }
                    : {
                          buyerID: form.buyerID,
                          botID: form.botID,
                          name: form.name,
                          localPath: form.localPath,
                          startScript: form.startScript || "npm start",
                          installCommand: form.installCommand || null,
                          expiresAt: form.expiresAt
                              ? new Date(form.expiresAt).toISOString()
                              : null,
                          groupId: form.groupId || null,
                          maxMemory: form.maxMemory || null,
                          currentPrice: form.currentPrice
                              ? Number(form.currentPrice)
                              : null,
                      };

            const { data } = await api.post(endpoint, payload);
            onCreated(data);
            onClose();
        } catch (err) {
            setError(err.response?.data?.error || "Failed to create bot");
        } finally {
            setLoading(false);
        }
    };

    const isGit = form.source === "git";

    return createPortal(
        /* Backdrop */
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
            <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 sticky top-0 bg-slate-800 z-10">
                    <h2 className="text-lg font-semibold text-slate-100">
                        ➕ Add Bot
                    </h2>
                    <button
                        onClick={onClose}
                        className="text-slate-500 hover:text-slate-300 text-xl leading-none"
                    >
                        ✕
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-6 space-y-4">
                    {/* ── Source Type Toggle ─────────────────────────────── */}
                    <div>
                        <label className="label">Source</label>
                        <div className="flex gap-2 mt-1">
                            {["git", "local"].map((s) => (
                                <button
                                    key={s}
                                    type="button"
                                    onClick={() =>
                                        setForm((f) => ({ ...f, source: s }))
                                    }
                                    className={`relative flex-1 py-2 rounded-lg text-sm font-medium border transition-all overflow-hidden ${
                                        form.source === s
                                            ? "border-indigo-500/50 text-indigo-400 bg-indigo-500/10"
                                            : "bg-slate-700/30 border-slate-700/50 text-slate-500 hover:text-slate-300 hover:bg-slate-700/50"
                                    }`}
                                >
                                    {s === "git"
                                        ? "🔗 GitHub / Git URL"
                                        : "📂 Local Folder"}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* ── Common Fields ──────────────────────────────────── */}
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="label">Buyer Discord ID *</label>
                            <input
                                className="input"
                                placeholder="123456789012345678"
                                value={form.buyerID}
                                onChange={set("buyerID")}
                                required
                            />
                        </div>
                        <div>
                            <label className="label">Bot Slug *</label>
                            <input
                                className="input"
                                placeholder="my-bot"
                                value={form.botID}
                                onChange={set("botID")}
                                required
                                pattern="[a-zA-Z0-9_-]+"
                                title="Letters, numbers, hyphens, underscores only"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="label">Display Name *</label>
                        <input
                            className="input"
                            placeholder="My Awesome Bot"
                            value={form.name}
                            onChange={set("name")}
                            required
                        />
                    </div>

                    {/* ── Git-only Fields ────────────────────────────────── */}
                    {isGit && (
                        <>
                            <div>
                                <label className="label">
                                    Git Repository URL *
                                </label>
                                <input
                                    className="input"
                                    placeholder="https://github.com/user/repo.git"
                                    value={form.repoUrl}
                                    onChange={set("repoUrl")}
                                    required={isGit}
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="label">Branch</label>
                                    <input
                                        className="input"
                                        placeholder="main"
                                        value={form.branch}
                                        onChange={set("branch")}
                                    />
                                </div>
                                <div>
                                    <label className="label">
                                        Start Command
                                    </label>
                                    <input
                                        className="input"
                                        placeholder="npm start"
                                        value={form.startScript}
                                        onChange={set("startScript")}
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="label">
                                    Install Command
                                </label>
                                <input
                                    className="input"
                                    placeholder="npm install --omit=dev"
                                    value={form.installCommand}
                                    onChange={set("installCommand")}
                                />
                                <p className="text-xs text-slate-500 mt-1">
                                    Leave empty to skip (e.g. Lavalink)
                                </p>
                            </div>
                        </>
                    )}

                    {/* ── Local-only Fields ──────────────────────────────── */}
                    {!isGit && (
                        <>
                            <div>
                                <label className="label">
                                    Absolute Path on Server *
                                </label>
                                <input
                                    className="input font-mono text-sm"
                                    placeholder="/root/bots/my-project"
                                    value={form.localPath}
                                    onChange={set("localPath")}
                                    required={!isGit}
                                />
                                <p className="text-xs text-slate-500 mt-1">
                                    Must be an existing directory on the server.
                                </p>
                            </div>
                            <div>
                                <label className="label">Start Command</label>
                                <input
                                    className="input"
                                    placeholder="npm start"
                                    value={form.startScript}
                                    onChange={set("startScript")}
                                />
                            </div>
                            <div>
                                <label className="label">Install Command</label>
                                <input
                                    className="input"
                                    placeholder="npm install --omit=dev"
                                    value={form.installCommand}
                                    onChange={set("installCommand")}
                                />
                                <p className="text-xs text-slate-500 mt-1">
                                    Leave empty to skip install step.
                                </p>
                            </div>
                        </>
                    )}

                    {/* ── Shared Optional Fields ─────────────────────────── */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        {/* Group */}
                        <div>
                            <label className="label">Group</label>
                            <select
                                className="input"
                                value={form.groupId}
                                onChange={set("groupId")}
                            >
                                <option value="">— No group —</option>
                                {groups.map((g) => (
                                    <option key={g._id} value={g._id}>
                                        {g.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        {/* Max Memory */}
                        <div>
                            <label className="label">Max Memory</label>
                            <input
                                className="input font-mono"
                                placeholder="300M"
                                value={form.maxMemory}
                                onChange={set("maxMemory")}
                                pattern="^\d+[KMG]?$"
                                title={MEM_HINT}
                            />
                            <p className="text-xs text-slate-500 mt-1">
                                {MEM_HINT}
                            </p>
                        </div>
                        {/* Current Price */}
                        <div>
                            <label className="label">Current Price</label>
                            <input
                                type="number"
                                className="input font-mono disabled:opacity-50"
                                placeholder="Optional"
                                value={form.currentPrice}
                                onChange={set("currentPrice")}
                                disabled={!form.maxMemory}
                                title="Only available when Max Memory is set"
                            />
                            <p className="text-xs text-slate-500 mt-1">
                                Optional override price.
                            </p>
                        </div>
                    </div>

                    {/* Expiry */}
                    <div>
                        <label className="label">Expiry Date (optional)</label>
                        <input
                            type="datetime-local"
                            className="input"
                            value={form.expiresAt}
                            onChange={set("expiresAt")}
                        />
                        <p className="text-xs text-slate-500 mt-1">
                            Leave empty for no expiry.
                        </p>
                    </div>

                    {/* Error */}
                    {error && (
                        <div className="bg-red-900/40 border border-red-700 text-red-400 text-sm rounded-lg px-3 py-2">
                            {error}
                        </div>
                    )}

                    {loading && (
                        <div className="bg-indigo-900/40 border border-indigo-700 text-indigo-300 text-sm rounded-lg px-3 py-2">
                            {isGit
                                ? "⏳ Cloning repo and installing dependencies — this may take a moment…"
                                : "⏳ Registering bot…"}
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex gap-3 justify-end pt-2">
                        <button
                            type="button"
                            className="btn-ghost"
                            onClick={onClose}
                            disabled={loading}
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            className="btn-primary"
                            disabled={loading}
                        >
                            {loading
                                ? "Adding…"
                                : isGit
                                  ? "🔗 Clone & Add"
                                  : "📂 Import Bot"}
                        </button>
                    </div>
                </form>
            </div>
        </div>,
        document.body,
    );
}
