import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

// ── Helpers ────────────────────────────────────────────────────────────────
const fmt = (bytes) => {
    if (!bytes && bytes !== 0) return "—";
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
};

const fmtUptime = (ts) => {
    if (!ts) return "—";
    const diff = Date.now() - ts;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${sec % 60}s`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ${min % 60}m`;
    const day = Math.floor(hr / 24);
    return `${day}d ${hr % 24}h`;
};

// ── Status config ──────────────────────────────────────────────────────────
const STATUS_MAP = {
    online: { label: "Online", color: "text-emerald-400", bg: "bg-emerald-500/10", ring: "ring-emerald-500/30", dot: "bg-emerald-400", glow: "shadow-emerald-500/20" },
    stopping: { label: "Stopping", color: "text-amber-400", bg: "bg-amber-500/10", ring: "ring-amber-500/30", dot: "bg-amber-400", glow: "shadow-amber-500/20" },
    stopped: { label: "Stopped", color: "text-slate-400", bg: "bg-slate-500/10", ring: "ring-slate-500/30", dot: "bg-slate-400", glow: "shadow-slate-500/20" },
    errored: { label: "Errored", color: "text-red-400", bg: "bg-red-500/10", ring: "ring-red-500/30", dot: "bg-red-400", glow: "shadow-red-500/20" },
    launching: { label: "Launching", color: "text-blue-400", bg: "bg-blue-500/10", ring: "ring-blue-500/30", dot: "bg-blue-400", glow: "shadow-blue-500/20" },
    not_found: { label: "Not Found", color: "text-slate-500", bg: "bg-slate-500/10", ring: "ring-slate-500/30", dot: "bg-slate-500", glow: "shadow-slate-500/20" },
    unknown: { label: "Unknown", color: "text-slate-500", bg: "bg-slate-500/10", ring: "ring-slate-500/30", dot: "bg-slate-500", glow: "shadow-slate-500/20" },
};

// ── Reconnect overlay ──────────────────────────────────────────────────────
function ReconnectOverlay({ onReconnected }) {
    const [dots, setDots] = useState("");
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        const dotTimer = setInterval(() => {
            setDots((d) => (d.length >= 3 ? "" : d + "."));
        }, 500);
        return () => clearInterval(dotTimer);
    }, []);

    useEffect(() => {
        const timer = setInterval(async () => {
            setAttempt((a) => a + 1);
            try {
                await api.get("/panel/status");
                onReconnected();
            } catch {
                // still down
            }
        }, 2000);
        return () => clearInterval(timer);
    }, [onReconnected]);

    return (
        <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-xl flex flex-col items-center justify-center gap-6">
            <div className="relative">
                <div className="w-20 h-20 rounded-full border-4 border-indigo-500/30 border-t-indigo-500 animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-3xl">🔄</span>
                </div>
            </div>
            <div className="text-center space-y-2">
                <h2 className="text-xl font-bold text-slate-100">
                    Panel Restarting{dots}
                </h2>
                <p className="text-sm text-slate-400">
                    Waiting for the panel to come back online
                </p>
                <p className="text-xs text-slate-600">
                    Attempt #{attempt}
                </p>
            </div>
        </div>
    );
}

// ── Stat card ──────────────────────────────────────────────────────────────
function StatCard({ icon, label, value, sub, accent = "text-slate-100" }) {
    return (
        <div className="card group hover:scale-[1.02] transition-transform duration-200">
            <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-slate-800/80 flex items-center justify-center text-lg shrink-0 group-hover:scale-110 transition-transform">
                    {icon}
                </div>
                <div className="min-w-0">
                    <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">{label}</p>
                    <p className={`text-lg font-bold ${accent} truncate`}>{value}</p>
                    {sub && <p className="text-[10px] text-slate-500 truncate">{sub}</p>}
                </div>
            </div>
        </div>
    );
}

// ── Action button ──────────────────────────────────────────────────────────
function ActionButton({ icon, label, description, onClick, loading, disabled, color = "indigo" }) {
    const colors = {
        indigo: "from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 shadow-indigo-600/20 disabled:from-indigo-900 disabled:to-indigo-900",
        amber: "from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 shadow-amber-600/20 disabled:from-amber-900 disabled:to-amber-900",
        rose: "from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 shadow-rose-600/20 disabled:from-rose-900 disabled:to-rose-900",
    };

    return (
        <button
            onClick={onClick}
            disabled={loading || disabled}
            className={`relative w-full p-4 rounded-xl bg-gradient-to-br ${colors[color]} shadow-lg text-left transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 group`}
        >
            <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center text-lg shrink-0">
                    {loading ? (
                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                        icon
                    )}
                </div>
                <div className="min-w-0">
                    <p className="font-bold text-white text-sm">{label}</p>
                    <p className="text-[11px] text-white/60 truncate">{description}</p>
                </div>
            </div>
        </button>
    );
}

// ── Add Key Modal ──────────────────────────────────────────────────────────
function AddKeyModal({ onClose, onCreated }) {
    const [mode, setMode] = useState("generate"); // "generate" | "import"
    const [name, setName] = useState("");
    const [comment, setComment] = useState("");
    const [privateKey, setPrivateKey] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
            const payload =
                mode === "generate"
                    ? { name, mode: "generate", comment }
                    : { name, mode: "import", privateKey };
            const { data } = await api.post("/github/keys", payload);
            onCreated(data);
            onClose();
        } catch (err) {
            setError(err.response?.data?.error || "Failed to add key");
        } finally {
            setLoading(false);
        }
    };

    return createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
            <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 sticky top-0 bg-slate-800 z-10">
                    <h2 className="text-lg font-semibold text-slate-100">
                        🔑 Add SSH Key
                    </h2>
                    <button
                        onClick={onClose}
                        className="text-slate-500 hover:text-slate-300 text-xl leading-none"
                    >
                        ✕
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-6 space-y-4">
                    {/* Mode toggle */}
                    <div>
                        <label className="label">Mode</label>
                        <div className="flex gap-2 mt-1">
                            {[
                                { v: "generate", l: "🔧 Generate New Key" },
                                { v: "import", l: "📋 Import Existing" },
                            ].map(({ v, l }) => (
                                <button
                                    key={v}
                                    type="button"
                                    onClick={() => setMode(v)}
                                    className={`relative flex-1 py-2 rounded-lg text-sm font-medium border transition-all overflow-hidden ${
                                        mode === v
                                            ? "border-indigo-500/50 text-indigo-400 bg-indigo-500/10"
                                            : "bg-slate-700/30 border-slate-700/50 text-slate-500 hover:text-slate-300 hover:bg-slate-700/50"
                                    }`}
                                >
                                    {l}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Key name */}
                    <div>
                        <label className="label">Key Name *</label>
                        <input
                            className="input font-mono"
                            placeholder="github_myaccount"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            required
                            pattern="[a-zA-Z0-9_-]+"
                            title="Letters, numbers, hyphens, underscores only"
                        />
                        <p className="text-xs text-slate-500 mt-1">
                            Will be saved as <code className="text-indigo-400">~/.ssh/{name || "..."}</code>
                        </p>
                    </div>

                    {mode === "generate" ? (
                        <div>
                            <label className="label">Email / Comment</label>
                            <input
                                className="input"
                                placeholder="you@example.com"
                                value={comment}
                                onChange={(e) => setComment(e.target.value)}
                            />
                            <p className="text-xs text-slate-500 mt-1">
                                Optional — used in the public key comment field
                            </p>
                        </div>
                    ) : (
                        <div>
                            <label className="label">Private Key *</label>
                            <textarea
                                className="input font-mono text-xs min-h-[160px] resize-y"
                                placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
                                value={privateKey}
                                onChange={(e) => setPrivateKey(e.target.value)}
                                required={mode === "import"}
                                spellCheck={false}
                            />
                            <p className="text-xs text-slate-500 mt-1">
                                Paste your private key content. Public key will be auto-derived.
                            </p>
                        </div>
                    )}

                    {error && (
                        <div className="bg-red-900/40 border border-red-700 text-red-400 text-sm rounded-lg px-3 py-2">
                            {error}
                        </div>
                    )}

                    {loading && (
                        <div className="bg-indigo-900/40 border border-indigo-700 text-indigo-300 text-sm rounded-lg px-3 py-2">
                            ⏳ {mode === "generate" ? "Generating key pair…" : "Importing key…"}
                        </div>
                    )}

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
                                : mode === "generate"
                                  ? "🔧 Generate"
                                  : "📋 Import Key"}
                        </button>
                    </div>
                </form>
            </div>
        </div>,
        document.body,
    );
}

// ── GitHub Section ─────────────────────────────────────────────────────────
function GitHubSection() {
    const [keys, setKeys] = useState([]);
    const [keysLoading, setKeysLoading] = useState(true);
    const [showAddModal, setShowAddModal] = useState(false);
    const [testResults, setTestResults] = useState({}); // { keyName: { loading, success, output } }
    const [copiedKey, setCopiedKey] = useState(null);
    const [gitConfig, setGitConfig] = useState({ name: "", email: "" });
    const [editingConfig, setEditingConfig] = useState(false);
    const [configForm, setConfigForm] = useState({ name: "", email: "" });
    const [configSaving, setConfigSaving] = useState(false);
    const [expandedKey, setExpandedKey] = useState(null);
    const [deleteConfirm, setDeleteConfirm] = useState(null);

    const fetchKeys = useCallback(async () => {
        setKeysLoading(true);
        try {
            const { data } = await api.get("/github/keys");
            setKeys(data);
        } catch {
            // ignore
        } finally {
            setKeysLoading(false);
        }
    }, []);

    const fetchGitConfig = useCallback(async () => {
        try {
            const { data } = await api.get("/github/git-config");
            setGitConfig(data);
            setConfigForm(data);
        } catch {
            // ignore
        }
    }, []);

    useEffect(() => {
        fetchKeys();
        fetchGitConfig();
    }, [fetchKeys, fetchGitConfig]);

    const handleTest = async (keyName = null) => {
        const id = keyName || "__default__";
        setTestResults((r) => ({ ...r, [id]: { loading: true } }));
        try {
            const url = keyName ? `/github/keys/${keyName}/test` : "/github/test";
            const { data } = await api.post(url);
            setTestResults((r) => ({ ...r, [id]: { loading: false, ...data } }));
        } catch {
            setTestResults((r) => ({
                ...r,
                [id]: { loading: false, success: false, output: "Request failed" },
            }));
        }
    };

    const handleCopy = async (publicKey, keyName) => {
        try {
            await navigator.clipboard.writeText(publicKey);
            setCopiedKey(keyName);
            setTimeout(() => setCopiedKey(null), 2000);
        } catch {
            // Fallback
            const t = document.createElement("textarea");
            t.value = publicKey;
            document.body.appendChild(t);
            t.select();
            document.execCommand("copy");
            document.body.removeChild(t);
            setCopiedKey(keyName);
            setTimeout(() => setCopiedKey(null), 2000);
        }
    };

    const handleDelete = async (keyName) => {
        try {
            await api.delete(`/github/keys/${keyName}`);
            setKeys((k) => k.filter((key) => key.name !== keyName));
            setDeleteConfirm(null);
        } catch {
            // ignore
        }
    };

    const handleSaveConfig = async () => {
        setConfigSaving(true);
        try {
            const { data } = await api.put("/github/git-config", configForm);
            setGitConfig(data);
            setEditingConfig(false);
        } catch {
            // ignore
        } finally {
            setConfigSaving(false);
        }
    };

    const defaultTest = testResults["__default__"];

    return (
        <>
            {/* Delete confirm modal */}
            {deleteConfirm && (
                <ConfirmModal
                    title={`Delete Key "${deleteConfirm}"`}
                    message={`This will permanently delete the SSH key pair and its SSH config entry.\n\n⚠️ Any GitHub repos using this key will no longer be accessible.`}
                    confirmText="Delete Key"
                    onConfirm={() => handleDelete(deleteConfirm)}
                    onCancel={() => setDeleteConfirm(null)}
                />
            )}

            {/* Add key modal */}
            {showAddModal && (
                <AddKeyModal
                    onClose={() => setShowAddModal(false)}
                    onCreated={() => fetchKeys()}
                />
            )}

            <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
                        GitHub & SSH Keys
                    </h2>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => handleTest(null)}
                            disabled={defaultTest?.loading}
                            className="text-xs text-slate-400 hover:text-slate-200 transition-colors px-2 py-1 rounded bg-slate-800/60 hover:bg-slate-700/60 disabled:opacity-50"
                        >
                            {defaultTest?.loading ? "Testing…" : "🔗 Test Default"}
                        </button>
                        <button
                            onClick={() => setShowAddModal(true)}
                            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors px-2 py-1 rounded bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30"
                        >
                            + Add Key
                        </button>
                    </div>
                </div>

                {/* Default test result */}
                {defaultTest && !defaultTest.loading && (
                    <div
                        className={`card border text-sm ${
                            defaultTest.success
                                ? "border-emerald-500/30 bg-emerald-500/5"
                                : "border-red-500/30 bg-red-500/5"
                        }`}
                    >
                        <div className="flex items-center gap-2">
                            <span>{defaultTest.success ? "✅" : "❌"}</span>
                            <span className={defaultTest.success ? "text-emerald-400" : "text-red-400"}>
                                {defaultTest.success ? "Connected" : "Connection Failed"}
                            </span>
                            <button
                                onClick={() => setTestResults((r) => { const n = { ...r }; delete n["__default__"]; return n; })}
                                className="ml-auto text-slate-500 hover:text-slate-300 text-xs"
                            >
                                Dismiss
                            </button>
                        </div>
                        {defaultTest.output && (
                            <pre className="text-xs text-slate-400 mt-2 font-mono whitespace-pre-wrap">
                                {defaultTest.output}
                            </pre>
                        )}
                    </div>
                )}

                {/* Git Config */}
                <div className="card">
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                            <span className="text-lg">⚙️</span>
                            <h3 className="text-sm font-bold text-slate-200">Git Global Config</h3>
                        </div>
                        {!editingConfig ? (
                            <button
                                onClick={() => {
                                    setConfigForm(gitConfig);
                                    setEditingConfig(true);
                                }}
                                className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                            >
                                ✏️ Edit
                            </button>
                        ) : (
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setEditingConfig(false)}
                                    className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSaveConfig}
                                    disabled={configSaving}
                                    className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors disabled:opacity-50"
                                >
                                    {configSaving ? "Saving…" : "💾 Save"}
                                </button>
                            </div>
                        )}
                    </div>
                    {editingConfig ? (
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                                    user.name
                                </label>
                                <input
                                    className="input mt-1 text-sm"
                                    value={configForm.name}
                                    onChange={(e) => setConfigForm((f) => ({ ...f, name: e.target.value }))}
                                    placeholder="Your Name"
                                />
                            </div>
                            <div>
                                <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                                    user.email
                                </label>
                                <input
                                    className="input mt-1 text-sm"
                                    value={configForm.email}
                                    onChange={(e) => setConfigForm((f) => ({ ...f, email: e.target.value }))}
                                    placeholder="you@example.com"
                                />
                            </div>
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                                    user.name
                                </p>
                                <p className="text-sm text-slate-200 font-mono mt-0.5">
                                    {gitConfig.name || <span className="text-slate-600 italic">Not set</span>}
                                </p>
                            </div>
                            <div>
                                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                                    user.email
                                </p>
                                <p className="text-sm text-slate-200 font-mono mt-0.5">
                                    {gitConfig.email || <span className="text-slate-600 italic">Not set</span>}
                                </p>
                            </div>
                        </div>
                    )}
                </div>

                {/* Keys list */}
                {keysLoading ? (
                    <div className="flex justify-center py-6">
                        <div className="animate-spin h-6 w-6 border-4 border-indigo-500 border-t-transparent rounded-full" />
                    </div>
                ) : keys.length === 0 ? (
                    <div className="card text-center py-8">
                        <p className="text-slate-500 text-sm">No SSH keys found on this VPS</p>
                        <p className="text-slate-600 text-xs mt-1">
                            Add a key to connect to GitHub repositories
                        </p>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {keys.map((key) => {
                            const test = testResults[key.name];
                            const isExpanded = expandedKey === key.name;

                            return (
                                <div
                                    key={key.name}
                                    className="card group transition-all duration-200 hover:border-slate-700"
                                >
                                    {/* Key header */}
                                    <div className="flex items-center gap-3">
                                        <div className="w-9 h-9 rounded-lg bg-slate-800/80 flex items-center justify-center text-base shrink-0">
                                            🔑
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <p className="text-sm font-bold text-slate-100 font-mono truncate">
                                                    {key.name}
                                                </p>
                                                {key.hostAlias && (
                                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 shrink-0">
                                                        {key.hostAlias}
                                                    </span>
                                                )}
                                            </div>
                                            {key.fingerprint && (
                                                <p className="text-[10px] text-slate-500 font-mono truncate mt-0.5">
                                                    {key.fingerprint}
                                                </p>
                                            )}
                                        </div>

                                        {/* Actions */}
                                        <div className="flex items-center gap-1 shrink-0">
                                            {/* Test */}
                                            <button
                                                onClick={() => handleTest(key.name)}
                                                disabled={test?.loading}
                                                className={`text-xs px-2 py-1 rounded transition-colors ${
                                                    test?.loading
                                                        ? "text-slate-500"
                                                        : test?.success === true
                                                          ? "text-emerald-400 bg-emerald-500/10"
                                                          : test?.success === false
                                                            ? "text-red-400 bg-red-500/10"
                                                            : "text-slate-400 hover:text-slate-200 bg-slate-800/60 hover:bg-slate-700/60"
                                                }`}
                                                title="Test SSH connection"
                                            >
                                                {test?.loading ? "⏳" : test?.success === true ? "✅" : test?.success === false ? "❌" : "🔗"}
                                            </button>
                                            {/* Copy pub key */}
                                            {key.publicKey && (
                                                <button
                                                    onClick={() => handleCopy(key.publicKey, key.name)}
                                                    className="text-xs px-2 py-1 rounded text-slate-400 hover:text-slate-200 bg-slate-800/60 hover:bg-slate-700/60 transition-colors"
                                                    title="Copy public key"
                                                >
                                                    {copiedKey === key.name ? "✓" : "📋"}
                                                </button>
                                            )}
                                            {/* Expand */}
                                            <button
                                                onClick={() => setExpandedKey(isExpanded ? null : key.name)}
                                                className="text-xs px-2 py-1 rounded text-slate-400 hover:text-slate-200 bg-slate-800/60 hover:bg-slate-700/60 transition-colors"
                                                title={isExpanded ? "Collapse" : "Show public key"}
                                            >
                                                {isExpanded ? "▲" : "▼"}
                                            </button>
                                            {/* Delete */}
                                            <button
                                                onClick={() => setDeleteConfirm(key.name)}
                                                className="text-xs px-2 py-1 rounded text-red-400/60 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                                title="Delete key"
                                            >
                                                🗑️
                                            </button>
                                        </div>
                                    </div>

                                    {/* Expanded: public key + test output */}
                                    {isExpanded && (
                                        <div className="mt-3 space-y-2">
                                            {key.publicKey && (
                                                <div>
                                                    <div className="flex items-center justify-between mb-1">
                                                        <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                                                            Public Key
                                                        </p>
                                                        <button
                                                            onClick={() => handleCopy(key.publicKey, key.name)}
                                                            className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
                                                        >
                                                            {copiedKey === key.name ? "✓ Copied!" : "Copy"}
                                                        </button>
                                                    </div>
                                                    <pre className="text-[10px] text-slate-400 bg-slate-950/80 rounded-lg p-2.5 font-mono whitespace-pre-wrap break-all select-all leading-relaxed">
                                                        {key.publicKey}
                                                    </pre>
                                                </div>
                                            )}
                                            {key.hostAlias && (
                                                <div>
                                                    <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                                                        Clone URL Pattern
                                                    </p>
                                                    <p className="text-xs text-slate-400 font-mono bg-slate-950/80 rounded-lg p-2.5">
                                                        git@{key.hostAlias}:username/repo.git
                                                    </p>
                                                </div>
                                            )}
                                            {test && !test.loading && test.output && (
                                                <div>
                                                    <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                                                        Test Result
                                                    </p>
                                                    <pre className="text-[10px] text-slate-400 bg-slate-950/80 rounded-lg p-2.5 font-mono whitespace-pre-wrap">
                                                        {test.output}
                                                    </pre>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main Page
// ═══════════════════════════════════════════════════════════════════════════
export default function PanelManage() {
    const [status, setStatus] = useState(null);
    const [logs, setLogs] = useState("");
    const [logsLoading, setLogsLoading] = useState(false);
    const [showLogs, setShowLogs] = useState(false);
    const [reconnecting, setReconnecting] = useState(false);
    const [confirm, setConfirm] = useState(null);
    const [building, setBuilding] = useState(false);
    const [buildOutput, setBuildOutput] = useState(null);
    const logsEndRef = useRef(null);

    // ── Fetch status ───────────────────────────────────────────────────────
    const fetchStatus = useCallback(() => {
        api.get("/panel/status")
            .then((r) => setStatus(r.data))
            .catch(() => {});
    }, []);

    useEffect(() => {
        fetchStatus();
        const interval = setInterval(fetchStatus, 5000);
        return () => clearInterval(interval);
    }, [fetchStatus]);

    // ── Fetch logs ─────────────────────────────────────────────────────────
    const fetchLogs = async () => {
        setLogsLoading(true);
        try {
            const r = await api.get("/panel/logs?lines=200");
            setLogs(r.data.logs || "No logs available");
        } catch {
            setLogs("Failed to fetch logs");
        } finally {
            setLogsLoading(false);
        }
    };

    useEffect(() => {
        if (showLogs) fetchLogs();
    }, [showLogs]);

    useEffect(() => {
        if (logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [logs]);

    // ── Actions ────────────────────────────────────────────────────────────
    const handleRestart = () => {
        setConfirm({
            title: "Restart Panel",
            message: "The panel will restart. You'll lose connection for a few seconds while it comes back up. Continue?",
            onConfirm: async () => {
                setConfirm(null);
                try {
                    await api.post("/panel/restart");
                    // Show reconnect overlay after a short delay
                    setTimeout(() => setReconnecting(true), 1000);
                } catch (err) {
                    alert("Failed to restart: " + (err.response?.data?.message || err.message));
                }
            },
        });
    };

    const handleRebuild = () => {
        setConfirm({
            title: "Rebuild & Restart Panel",
            message: "This will rebuild the client UI (may take 30-60 seconds) and then restart the panel. The panel stays online during the build. Continue?",
            onConfirm: async () => {
                setConfirm(null);
                setBuilding(true);
                setBuildOutput(null);
                try {
                    const r = await api.post("/panel/rebuild");
                    setBuildOutput({ success: true, output: r.data.buildOutput, message: r.data.message });
                    // Show reconnect overlay after a short delay
                    setTimeout(() => setReconnecting(true), 1000);
                } catch (err) {
                    const data = err.response?.data;
                    setBuildOutput({
                        success: false,
                        output: data?.buildOutput || err.message,
                        message: data?.message || "Build failed",
                    });
                } finally {
                    setBuilding(false);
                }
            },
        });
    };

    const handleReconnected = useCallback(() => {
        setReconnecting(false);
        fetchStatus();
        // Refresh the page to load potentially new assets
        window.location.reload();
    }, [fetchStatus]);

    // ── Render ─────────────────────────────────────────────────────────────
    const s = status ? STATUS_MAP[status.status] || STATUS_MAP.unknown : null;

    return (
        <div className="p-6 max-w-4xl mx-auto space-y-6">
            {/* Reconnect overlay */}
            {reconnecting && <ReconnectOverlay onReconnected={handleReconnected} />}

            {/* Confirm modal */}
            {confirm && (
                <ConfirmModal
                    title={confirm.title}
                    message={confirm.message}
                    onConfirm={confirm.onConfirm}
                    onCancel={() => setConfirm(null)}
                />
            )}

            {/* Header */}
            <div>
                <div className="flex items-center gap-3">
                    <h1 className="text-2xl font-bold text-slate-100">Panel Management</h1>
                    {s && (
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ring-1 ${s.bg} ${s.color} ${s.ring}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${s.dot} animate-pulse`} />
                            {s.label}
                        </span>
                    )}
                </div>
                <p className="text-sm text-slate-500 mt-1">
                    Manage the panel itself — restart, rebuild, and view logs
                </p>
            </div>

            {/* Status cards */}
            {status ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <StatCard
                        icon="📛"
                        label="PM2 Name"
                        value={status.name}
                        sub={status.pm_id !== null ? `ID: ${status.pm_id}` : null}
                    />
                    <StatCard
                        icon="⏱️"
                        label="Uptime"
                        value={fmtUptime(status.uptime)}
                        accent="text-indigo-400"
                    />
                    <StatCard
                        icon="🧠"
                        label="Memory"
                        value={fmt(status.memory)}
                        sub={`CPU: ${status.cpu}%`}
                        accent="text-blue-400"
                    />
                    <StatCard
                        icon="🔁"
                        label="Restarts"
                        value={status.restarts}
                        accent={status.restarts > 10 ? "text-amber-400" : "text-slate-100"}
                    />
                </div>
            ) : (
                <div className="flex justify-center py-8">
                    <div className="animate-spin h-8 w-8 border-4 border-indigo-500 border-t-transparent rounded-full" />
                </div>
            )}

            {/* Action buttons */}
            <div className="space-y-3">
                <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
                    Actions
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <ActionButton
                        icon="🔄"
                        label="Restart Panel"
                        description="Restart the PM2 process (~3s downtime)"
                        onClick={handleRestart}
                        color="indigo"
                    />
                    <ActionButton
                        icon="🏗️"
                        label="Rebuild & Restart"
                        description="Rebuild client UI, then restart (30-60s)"
                        onClick={handleRebuild}
                        loading={building}
                        color="amber"
                    />
                </div>
            </div>

            {/* Build output */}
            {buildOutput && (
                <div className={`card border ${buildOutput.success ? "border-emerald-500/30" : "border-red-500/30"}`}>
                    <div className="flex items-center gap-2 mb-3">
                        <span className="text-lg">{buildOutput.success ? "✅" : "❌"}</span>
                        <h3 className={`text-sm font-bold ${buildOutput.success ? "text-emerald-400" : "text-red-400"}`}>
                            {buildOutput.message}
                        </h3>
                        <button
                            onClick={() => setBuildOutput(null)}
                            className="ml-auto text-slate-500 hover:text-slate-300 text-xs"
                        >
                            Dismiss
                        </button>
                    </div>
                    {buildOutput.output && (
                        <pre className="text-xs text-slate-400 bg-slate-900/60 rounded-lg p-3 max-h-48 overflow-auto font-mono whitespace-pre-wrap">
                            {buildOutput.output}
                        </pre>
                    )}
                </div>
            )}
            {/* Logs section */}

            {/* ── GitHub & SSH Keys ──────────────────────────────────────── */}
            <GitHubSection />

            {/* ── Panel Logs ─────────────────────────────────────────────── */}
            <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
                        Panel Logs
                    </h2>
                    <div className="flex items-center gap-2">
                        {showLogs && (
                            <button
                                onClick={fetchLogs}
                                disabled={logsLoading}
                                className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors disabled:opacity-50"
                            >
                                {logsLoading ? "Loading..." : "🔄 Refresh"}
                            </button>
                        )}
                        <button
                            onClick={() => setShowLogs((v) => !v)}
                            className="text-xs text-slate-400 hover:text-slate-200 transition-colors px-2 py-1 rounded bg-slate-800/60 hover:bg-slate-700/60"
                        >
                            {showLogs ? "Hide Logs" : "Show Logs"}
                        </button>
                    </div>
                </div>

                {showLogs && (
                    <div className="card p-0 overflow-hidden">
                        <pre className="text-xs text-slate-300 bg-slate-950 p-4 max-h-96 overflow-auto font-mono whitespace-pre-wrap leading-relaxed">
                            {logsLoading ? (
                                <span className="text-slate-500">Loading logs...</span>
                            ) : (
                                logs
                            )}
                            <div ref={logsEndRef} />
                        </pre>
                    </div>
                )}
            </div>
        </div>
    );
}
