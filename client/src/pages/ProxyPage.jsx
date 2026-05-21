import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import api from "../api/client";
import { motion, AnimatePresence } from "framer-motion";

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

const statusColors = {
    online: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30",
    stopped: "bg-slate-500/20 text-slate-400 border border-slate-500/30",
    errored: "bg-red-500/20 text-red-400 border border-red-500/30",
    launching: "bg-amber-500/20 text-amber-400 border border-amber-500/30",
};

const StatusBadge = ({ status = "stopped" }) => (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${statusColors[status] || statusColors.stopped}`}>
        {status}
    </span>
);

const Toggle = ({ enabled, onChange, disabled }) => (
    <button
        onClick={() => !disabled && onChange(!enabled)}
        disabled={disabled}
        className={`relative w-11 h-6 rounded-full transition-all duration-300 focus:outline-none ${
            enabled ? "bg-indigo-600 shadow-lg shadow-indigo-600/30" : "bg-slate-700"
        } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
        aria-checked={enabled}
        role="switch"
    >
        <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-300 ${
                enabled ? "translate-x-5" : "translate-x-0"
            }`}
        />
    </button>
);

const InputField = ({ label, id, type = "text", value, onChange, placeholder, icon, hint }) => (
    <div className="space-y-1.5">
        <label htmlFor={id} className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
            {label}
        </label>
        <div className="relative">
            {icon && (
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm select-none">
                    {icon}
                </span>
            )}
            <input
                id={id}
                type={type}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className={`w-full bg-slate-800/60 border border-slate-700/50 rounded-lg text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500/70 focus:ring-1 focus:ring-indigo-500/30 transition-all duration-200 py-2.5 pr-3 ${
                    icon ? "pl-9" : "pl-3"
                }`}
            />
        </div>
        {hint && <p className="text-[10px] text-slate-600">{hint}</p>}
    </div>
);

// ─────────────────────────────────────────────────────────────────────────────
//  ProxyPage
// ─────────────────────────────────────────────────────────────────────────────

export default function ProxyPage() {
    // ── State ──────────────────────────────────────────────────────────────
    const [config, setConfig] = useState({
        enabled: false,
        type: "socks5",
        host: "",
        port: 1080,
        username: "",
        password: "",
    });
    const [bots, setBots] = useState([]);
    const [loadingConfig, setLoadingConfig] = useState(true);
    const [loadingBots, setLoadingBots] = useState(true);
    const [savingConfig, setSavingConfig] = useState(false);
    const [togglingId, setTogglingId] = useState(null);
    const [bulkWorking, setBulkWorking] = useState(false);
    const [toast, setToast] = useState(null);
    const [showPassword, setShowPassword] = useState(false);
    const [search, setSearch] = useState("");

    // ── Fetch ──────────────────────────────────────────────────────────────
    const fetchConfig = useCallback(async () => {
        try {
            const { data } = await api.get("/proxy/config");
            setConfig({
                enabled: data.enabled ?? false,
                type: data.type ?? "socks5",
                host: data.host ?? "",
                port: data.port ?? 1080,
                username: data.username ?? "",
                password: data.password ?? "",
            });
        } catch {
            showToast("Failed to load proxy config", "error");
        } finally {
            setLoadingConfig(false);
        }
    }, []);

    const fetchBots = useCallback(async () => {
        try {
            const { data } = await api.get("/proxy/bots");
            setBots(data);
        } catch {
            showToast("Failed to load bots", "error");
        } finally {
            setLoadingBots(false);
        }
    }, []);

    useEffect(() => {
        fetchConfig();
        fetchBots();
    }, [fetchConfig, fetchBots]);

    // ── Toast ──────────────────────────────────────────────────────────────
    const showToast = (message, type = "success") => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 3500);
    };

    // ── Handlers ───────────────────────────────────────────────────────────
    const handleSaveConfig = async () => {
        setSavingConfig(true);
        try {
            const payload = {
                ...config,
                port: Number(config.port),
                username: config.username || null,
                password: config.password || null,
            };
            const { data } = await api.put("/proxy/config", payload);
            setConfig((c) => ({ ...c, ...data }));
            showToast("Proxy configuration saved", "success");
        } catch {
            showToast("Failed to save configuration", "error");
        } finally {
            setSavingConfig(false);
        }
    };

    const handleToggleGlobal = async (val) => {
        const next = { ...config, enabled: val };
        setConfig(next);
        try {
            await api.put("/proxy/config", { enabled: val });
            showToast(val ? "Proxy enabled globally" : "Proxy disabled globally", "success");
        } catch {
            setConfig(config);
            showToast("Failed to toggle proxy", "error");
        }
    };

    const handleToggleBot = async (bot, val) => {
        setTogglingId(bot._id);
        setBots((prev) => prev.map((b) => (b._id === bot._id ? { ...b, proxyEnabled: val } : b)));
        try {
            await api.put(`/proxy/bots/${bot._id}`, { proxyEnabled: val });
            showToast(`Proxy ${val ? "enabled" : "disabled"} for ${bot.name}`, "success");
        } catch {
            setBots((prev) => prev.map((b) => (b._id === bot._id ? { ...b, proxyEnabled: !val } : b)));
            showToast("Failed to update bot proxy setting", "error");
        } finally {
            setTogglingId(null);
        }
    };

    const handleBulk = async (proxyEnabled) => {
        setBulkWorking(true);
        const ids = filteredBots.map((b) => b._id);
        try {
            await api.put("/proxy/bots/bulk", { ids, proxyEnabled });
            setBots((prev) =>
                prev.map((b) => (ids.includes(b._id) ? { ...b, proxyEnabled } : b))
            );
            showToast(`Proxy ${proxyEnabled ? "enabled" : "disabled"} for ${ids.length} bots`, "success");
        } catch {
            showToast("Bulk operation failed", "error");
        } finally {
            setBulkWorking(false);
        }
    };

    // ── Derived ────────────────────────────────────────────────────────────
    const filteredBots = bots.filter(
        (b) =>
            b.name?.toLowerCase().includes(search.toLowerCase()) ||
            b.buyerID?.toLowerCase().includes(search.toLowerCase()) ||
            b.botID?.toLowerCase().includes(search.toLowerCase())
    );
    const enabledCount = bots.filter((b) => b.proxyEnabled).length;

    // ─────────────────────────────────────────────────────────────────────────
    //  Render
    // ─────────────────────────────────────────────────────────────────────────
    return (
        <div className="p-4 lg:p-6 max-w-5xl mx-auto space-y-6">
            {/* ── Header ─────────────────────────────────────────────────── */}
            <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-xl">
                    🔗
                </div>
                <div>
                    <h1 className="text-xl font-bold text-slate-100">Proxy Manager</h1>
                    <p className="text-xs text-slate-500">Configure proxychains4 for your bots</p>
                </div>
            </div>

            {/* ── Stats Strip ────────────────────────────────────────────── */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[
                    {
                        label: "Global Proxy",
                        value: config.enabled ? "Active" : "Inactive",
                        icon: "🌐",
                        color: config.enabled ? "text-emerald-400" : "text-slate-500",
                    },
                    {
                        label: "Bots Using Proxy",
                        value: `${enabledCount} / ${bots.length}`,
                        icon: "🤖",
                        color: "text-indigo-400",
                    },
                    {
                        label: "Proxy Host",
                        value: config.host ? `${config.host}:${config.port}` : "Not set",
                        icon: "🖧",
                        color: "text-slate-300",
                    },
                ].map((s) => (
                    <div
                        key={s.label}
                        className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-3 flex items-center gap-3 backdrop-blur-sm"
                    >
                        <span className="text-2xl">{s.icon}</span>
                        <div>
                            <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">{s.label}</p>
                            <p className={`text-sm font-bold ${s.color}`}>{s.value}</p>
                        </div>
                    </div>
                ))}
            </div>

            {/* ── Global Config Card ─────────────────────────────────────── */}
            <div className="bg-slate-900/60 border border-slate-800/60 rounded-2xl backdrop-blur-sm overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-800/60 flex items-center justify-between">
                    <div>
                        <h2 className="text-sm font-bold text-slate-100">Global Proxy Configuration</h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                            Settings applied to all proxy-enabled bots
                        </p>
                    </div>
                    {/* Master toggle */}
                    <div className="flex items-center gap-3">
                        <span className="text-xs text-slate-400 font-medium">
                            {config.enabled ? "Enabled" : "Disabled"}
                        </span>
                        <Toggle enabled={config.enabled} onChange={handleToggleGlobal} />
                    </div>
                </div>

                {loadingConfig ? (
                    <div className="p-8 flex justify-center">
                        <div className="animate-spin h-7 w-7 border-4 border-indigo-500 border-t-transparent rounded-full" />
                    </div>
                ) : (
                    <div className="p-5 space-y-5">
                        {/* Type selector */}
                        <div className="space-y-1.5">
                            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
                                Proxy Type
                            </label>
                            <div className="flex gap-2">
                                {["socks5", "socks4", "http"].map((t) => (
                                    <button
                                        key={t}
                                        onClick={() => setConfig((c) => ({ ...c, type: t }))}
                                        className={`px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all duration-200 ${
                                            config.type === t
                                                ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20"
                                                : "bg-slate-800/60 text-slate-400 hover:bg-slate-700/60 hover:text-slate-200 border border-slate-700/50"
                                        }`}
                                    >
                                        {t}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Host / Port */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <div className="sm:col-span-2">
                                <InputField
                                    id="proxy-host"
                                    label="Host / IP"
                                    icon="🖧"
                                    value={config.host}
                                    onChange={(v) => setConfig((c) => ({ ...c, host: v }))}
                                    placeholder="127.0.0.1 or proxy IP"
                                />
                            </div>
                            <InputField
                                id="proxy-port"
                                label="Port"
                                icon="🔌"
                                type="number"
                                value={config.port}
                                onChange={(v) => setConfig((c) => ({ ...c, port: v }))}
                                placeholder="1080"
                            />
                        </div>

                        {/* Auth */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <InputField
                                id="proxy-user"
                                label="Username"
                                icon="👤"
                                value={config.username}
                                onChange={(v) => setConfig((c) => ({ ...c, username: v }))}
                                placeholder="Optional"
                                hint="Leave blank if no authentication is required"
                            />
                            <div className="space-y-1.5">
                                <label htmlFor="proxy-pass" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
                                    Password
                                </label>
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm select-none">🔑</span>
                                    <input
                                        id="proxy-pass"
                                        type={showPassword ? "text" : "password"}
                                        value={config.password}
                                        onChange={(e) => setConfig((c) => ({ ...c, password: e.target.value }))}
                                        placeholder="Optional"
                                        className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500/70 focus:ring-1 focus:ring-indigo-500/30 transition-all duration-200 py-2.5 pl-9 pr-10"
                                    />
                                    <button
                                        onClick={() => setShowPassword((v) => !v)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors text-xs"
                                    >
                                        {showPassword ? "🙈" : "👁"}
                                    </button>
                                </div>
                                <p className="text-[10px] text-slate-600">Leave blank if no authentication is required</p>
                            </div>
                        </div>

                        {/* Info box */}
                        <div className="bg-indigo-500/5 border border-indigo-500/20 rounded-xl p-3 flex gap-2.5">
                            <span className="text-base shrink-0">ℹ️</span>
                            <p className="text-xs text-slate-400 leading-relaxed">
                                A per-bot <code className="text-indigo-400 font-mono">.proxychains4.conf</code> file is
                                written to each bot's directory on start/restart. The{" "}
                                <code className="text-indigo-400 font-mono">proxychains4</code> binary must be installed on
                                the server. Changes apply on the bot's next start or restart.
                            </p>
                        </div>

                        <div className="flex justify-end pt-1">
                            <button
                                onClick={handleSaveConfig}
                                disabled={savingConfig}
                                className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-all duration-200 shadow-lg shadow-indigo-600/20"
                            >
                                {savingConfig ? (
                                    <>
                                        <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                                        Saving…
                                    </>
                                ) : (
                                    <>💾 Save Configuration</>
                                )}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* ── Per-Bot Table ──────────────────────────────────────────── */}
            <div className="bg-slate-900/60 border border-slate-800/60 rounded-2xl backdrop-blur-sm overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-800/60 flex flex-wrap items-center gap-3">
                    <div className="flex-1 min-w-0">
                        <h2 className="text-sm font-bold text-slate-100">Bot Proxy Assignments</h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                            {enabledCount} of {bots.length} bots have proxy enabled
                        </p>
                    </div>

                    {/* Search */}
                    <div className="relative">
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-xs">🔍</span>
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Filter bots…"
                            className="bg-slate-800/60 border border-slate-700/50 rounded-lg text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500/70 focus:ring-1 focus:ring-indigo-500/30 py-1.5 pl-7 pr-3 w-44 transition-all"
                        />
                    </div>

                    {/* Bulk actions */}
                    <div className="flex gap-2">
                        <button
                            onClick={() => handleBulk(true)}
                            disabled={bulkWorking || loadingBots}
                            className="px-3 py-1.5 text-xs font-semibold bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/30 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            ✅ Enable All
                        </button>
                        <button
                            onClick={() => handleBulk(false)}
                            disabled={bulkWorking || loadingBots}
                            className="px-3 py-1.5 text-xs font-semibold bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            ❌ Disable All
                        </button>
                    </div>
                </div>

                {loadingBots ? (
                    <div className="p-10 flex justify-center">
                        <div className="animate-spin h-7 w-7 border-4 border-indigo-500 border-t-transparent rounded-full" />
                    </div>
                ) : filteredBots.length === 0 ? (
                    <div className="p-10 text-center">
                        <p className="text-4xl mb-3">🤖</p>
                        <p className="text-slate-400 text-sm font-medium">
                            {search ? "No bots match your search" : "No bots found"}
                        </p>
                    </div>
                ) : (
                    <div className="divide-y divide-slate-800/40">
                        {filteredBots.map((bot) => (
                            <div
                                key={bot._id}
                                className="flex items-center gap-4 px-5 py-3.5 hover:bg-slate-800/20 transition-colors"
                            >
                                {/* Avatar */}
                                <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/20 flex items-center justify-center text-sm font-bold text-indigo-400 shrink-0">
                                    {bot.name?.[0]?.toUpperCase()}
                                </div>

                                {/* Info */}
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-semibold text-slate-100 truncate">{bot.name}</p>
                                    <p className="text-xs text-slate-500 truncate">
                                        <span className="font-mono">{bot.buyerID}</span>
                                        <span className="mx-1 text-slate-700">·</span>
                                        <span className="font-mono text-slate-600">{bot.pm2Name}</span>
                                    </p>
                                </div>

                                {/* Proxy status badge */}
                                <span
                                    className={`hidden sm:inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border shrink-0 ${
                                        bot.proxyEnabled
                                            ? "bg-indigo-500/15 text-indigo-400 border-indigo-500/30"
                                            : "bg-slate-700/30 text-slate-600 border-slate-700/40"
                                    }`}
                                >
                                    {bot.proxyEnabled ? "Proxy ON" : "Proxy OFF"}
                                </span>

                                {/* Toggle */}
                                <Toggle
                                    enabled={bot.proxyEnabled}
                                    onChange={(val) => handleToggleBot(bot, val)}
                                    disabled={togglingId === bot._id}
                                />
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* ── Toast (portal so fixed pos is relative to real viewport) ── */}
            {createPortal(
                <AnimatePresence>
                    {toast && (
                        <motion.div
                            initial={{ opacity: 0, y: 20, scale: 0.95 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 10, scale: 0.95 }}
                            transition={{ duration: 0.2 }}
                            className={`fixed bottom-24 lg:bottom-6 right-4 lg:right-6 z-[9999] px-4 py-3 rounded-xl shadow-2xl text-sm font-semibold flex items-center gap-2 max-w-xs ${
                                toast.type === "error"
                                    ? "bg-red-900/80 text-red-200 border border-red-500/30"
                                    : "bg-slate-800 text-slate-100 border border-slate-700/60"
                            } backdrop-blur-xl`}
                        >
                            <span>{toast.type === "error" ? "❌" : "✅"}</span>
                            {toast.message}
                        </motion.div>
                    )}
                </AnimatePresence>,
                document.body
            )}
        </div>
    );
}
