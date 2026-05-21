import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import api from "../api/client";
import { motion, AnimatePresence } from "framer-motion";

// ─────────────────────────────────────────────────────────────────────────────
//  Small reusable components
// ─────────────────────────────────────────────────────────────────────────────

const Toggle = ({ enabled, onChange, disabled, size = "md" }) => {
    const w = size === "sm" ? "w-9 h-5" : "w-11 h-6";
    const knob = size === "sm" ? "w-4 h-4 top-0.5 left-0.5" : "w-5 h-5 top-0.5 left-0.5";
    const translate = size === "sm" ? "translate-x-4" : "translate-x-5";
    return (
        <button
            onClick={() => !disabled && onChange(!enabled)}
            disabled={disabled}
            className={`relative ${w} rounded-full transition-all duration-300 focus:outline-none shrink-0 ${
                enabled ? "bg-indigo-600 shadow-lg shadow-indigo-600/30" : "bg-slate-700"
            } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
            aria-checked={enabled}
            role="switch"
        >
            <span
                className={`absolute ${knob} bg-white rounded-full shadow transition-transform duration-300 ${
                    enabled ? translate : "translate-x-0"
                }`}
            />
        </button>
    );
};

const InputField = ({ label, id, type = "text", value, onChange, placeholder, icon, hint }) => (
    <div className="space-y-1.5">
        <label htmlFor={id} className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
            {label}
        </label>
        <div className="relative">
            {icon && (
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm select-none pointer-events-none">
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

// ── Color swatch for group badge ───────────────────────────────────────────
const GroupDot = ({ color }) => (
    <span
        className="w-2 h-2 rounded-full shrink-0 inline-block"
        style={{ backgroundColor: color || "#6366f1" }}
    />
);

// ── Bot row ────────────────────────────────────────────────────────────────
function BotRow({ bot, togglingId, onToggle }) {
    const isToggling = togglingId === bot._id;
    return (
        <div className="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/30 transition-colors group">
            {/* Avatar */}
            <div className="w-7 h-7 rounded-lg bg-indigo-600/20 border border-indigo-500/20 flex items-center justify-center text-xs font-bold text-indigo-400 shrink-0">
                {bot.name?.[0]?.toUpperCase()}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-200 truncate leading-tight">{bot.name}</p>
                <p className="text-[11px] text-slate-500 truncate font-mono">{bot.pm2Name}</p>
            </div>

            {/* Proxy badge — visible on hover or when active */}
            <span
                className={`hidden sm:inline-flex text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border transition-all ${
                    bot.proxyEnabled
                        ? "bg-indigo-500/15 text-indigo-400 border-indigo-500/30"
                        : "bg-slate-800/40 text-slate-600 border-slate-700/30 opacity-0 group-hover:opacity-100"
                }`}
            >
                {bot.proxyEnabled ? "Proxy ON" : "Proxy OFF"}
            </span>

            {/* Spinner or toggle */}
            {isToggling ? (
                <span className="w-11 flex justify-center">
                    <span className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                </span>
            ) : (
                <Toggle enabled={bot.proxyEnabled} onChange={(v) => onToggle(bot, v)} />
            )}
        </div>
    );
}

// ── Collapsible group section ───────────────────────────────────────────────
function GroupSection({ group, bots, togglingId, bulkingGroup, onToggle, onGroupBulk, defaultOpen = true }) {
    const [open, setOpen] = useState(defaultOpen);
    const enabledCount = bots.filter((b) => b.proxyEnabled).length;
    const allEnabled = enabledCount === bots.length;
    const noneEnabled = enabledCount === 0;
    const isBulking = bulkingGroup === group._id;

    return (
        <div className="border border-slate-800/50 rounded-xl overflow-hidden">
            {/* Group header */}
            <button
                onClick={() => setOpen((v) => !v)}
                className="w-full flex items-center gap-3 px-4 py-3 bg-slate-800/40 hover:bg-slate-800/60 transition-colors text-left"
            >
                {/* Chevron */}
                <motion.span
                    animate={{ rotate: open ? 90 : 0 }}
                    transition={{ duration: 0.18 }}
                    className="text-slate-500 text-xs shrink-0"
                >
                    ▶
                </motion.span>

                {/* Group color + name */}
                <GroupDot color={group.color} />
                <span className="font-semibold text-slate-200 text-sm truncate flex-1">{group.name}</span>

                {/* Stats pill */}
                <span className="text-[10px] font-bold text-slate-500 bg-slate-700/40 px-2 py-0.5 rounded-full shrink-0">
                    {enabledCount}/{bots.length} proxied
                </span>

                {/* Bulk quick-actions — stop propagation so they don't toggle collapse */}
                <div
                    className="flex items-center gap-1.5 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                >
                    {isBulking ? (
                        <span className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                    ) : (
                        <>
                            <button
                                onClick={() => onGroupBulk(group._id, bots, true)}
                                disabled={allEnabled}
                                title="Enable all in group"
                                className="text-[10px] px-2 py-1 rounded-md bg-emerald-600/15 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/20 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                            >
                                All ON
                            </button>
                            <button
                                onClick={() => onGroupBulk(group._id, bots, false)}
                                disabled={noneEnabled}
                                title="Disable all in group"
                                className="text-[10px] px-2 py-1 rounded-md bg-red-600/15 hover:bg-red-600/30 text-red-400 border border-red-500/20 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                            >
                                All OFF
                            </button>
                        </>
                    )}
                </div>
            </button>

            {/* Bot rows */}
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden divide-y divide-slate-800/30"
                    >
                        {bots.map((bot) => (
                            <BotRow
                                key={bot._id}
                                bot={bot}
                                togglingId={togglingId}
                                onToggle={onToggle}
                            />
                        ))}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  ProxyPage
// ─────────────────────────────────────────────────────────────────────────────

export default function ProxyPage() {
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
    const [bulkingGroup, setBulkingGroup] = useState(null); // groupId or "__ungrouped__" or "__all__"
    const [toast, setToast] = useState(null);
    const [showPassword, setShowPassword] = useState(false);
    const [search, setSearch] = useState("");
    const [viewMode, setViewMode] = useState("group"); // "group" | "buyer" | "flat"
    const [configOpen, setConfigOpen] = useState(true);

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

    // ── Config handlers ────────────────────────────────────────────────────
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
            showToast("Proxy configuration saved");
        } catch {
            showToast("Failed to save configuration", "error");
        } finally {
            setSavingConfig(false);
        }
    };

    const handleToggleGlobal = async (val) => {
        const prev = config;
        setConfig((c) => ({ ...c, enabled: val }));
        try {
            await api.put("/proxy/config", { enabled: val });
            showToast(val ? "Proxy enabled globally" : "Proxy disabled globally");
        } catch {
            setConfig(prev);
            showToast("Failed to toggle proxy", "error");
        }
    };

    // ── Per-bot toggle ─────────────────────────────────────────────────────
    const handleToggleBot = async (bot, val) => {
        setTogglingId(bot._id);
        setBots((prev) => prev.map((b) => (b._id === bot._id ? { ...b, proxyEnabled: val } : b)));
        try {
            await api.put(`/proxy/bots/${bot._id}`, { proxyEnabled: val });
        } catch {
            setBots((prev) => prev.map((b) => (b._id === bot._id ? { ...b, proxyEnabled: !val } : b)));
            showToast("Failed to update bot", "error");
        } finally {
            setTogglingId(null);
        }
    };

    // ── Group bulk toggle ──────────────────────────────────────────────────
    const handleGroupBulk = async (groupKey, groupBots, proxyEnabled) => {
        setBulkingGroup(groupKey);
        const ids = groupBots.map((b) => b._id);
        try {
            await api.put("/proxy/bots/bulk", { ids, proxyEnabled });
            setBots((prev) =>
                prev.map((b) => (ids.includes(b._id) ? { ...b, proxyEnabled } : b))
            );
            showToast(`${proxyEnabled ? "Enabled" : "Disabled"} proxy for ${ids.length} bots`);
        } catch {
            showToast("Bulk operation failed", "error");
        } finally {
            setBulkingGroup(null);
        }
    };

    // ── Global bulk (all visible) ──────────────────────────────────────────
    const handleAllBulk = async (proxyEnabled) => {
        setBulkingGroup("__all__");
        const ids = filteredBots.map((b) => b._id);
        try {
            await api.put("/proxy/bots/bulk", { ids, proxyEnabled });
            setBots((prev) =>
                prev.map((b) => (ids.includes(b._id) ? { ...b, proxyEnabled } : b))
            );
            showToast(`${proxyEnabled ? "Enabled" : "Disabled"} proxy for ${ids.length} bots`);
        } catch {
            showToast("Bulk operation failed", "error");
        } finally {
            setBulkingGroup(null);
        }
    };

    // ── Derived / grouping ─────────────────────────────────────────────────
    const filteredBots = bots.filter(
        (b) =>
            !search ||
            b.name?.toLowerCase().includes(search.toLowerCase()) ||
            b.buyerID?.toLowerCase().includes(search.toLowerCase()) ||
            b.pm2Name?.toLowerCase().includes(search.toLowerCase())
    );

    const enabledCount = bots.filter((b) => b.proxyEnabled).length;

    // Group by: group object | buyerID | flat
    const buildGroups = () => {
        if (viewMode === "flat") {
            return [{ key: "__flat__", label: null, bots: filteredBots }];
        }

        if (viewMode === "buyer") {
            const map = {};
            filteredBots.forEach((b) => {
                const k = b.buyerID || "Unknown";
                if (!map[k]) map[k] = { key: k, label: k, color: null, bots: [] };
                map[k].bots.push(b);
            });
            return Object.values(map).sort((a, b) => a.label.localeCompare(b.label));
        }

        // "group" mode
        const map = {};
        filteredBots.forEach((b) => {
            const g = b.group;
            if (g) {
                if (!map[g._id]) map[g._id] = { key: g._id, label: g.name, color: g.color, bots: [] };
                map[g._id].bots.push(b);
            } else {
                if (!map["__ungrouped__"])
                    map["__ungrouped__"] = { key: "__ungrouped__", label: "Ungrouped", color: "#475569", bots: [] };
                map["__ungrouped__"].bots.push(b);
            }
        });
        // Named groups first, then ungrouped
        const named = Object.values(map).filter((g) => g.key !== "__ungrouped__").sort((a, b) => a.label.localeCompare(b.label));
        const ungrouped = map["__ungrouped__"] ? [map["__ungrouped__"]] : [];
        return [...named, ...ungrouped];
    };

    const groups = buildGroups();

    // ─────────────────────────────────────────────────────────────────────────
    //  Render
    // ─────────────────────────────────────────────────────────────────────────
    return (
        <div className="p-4 lg:p-6 max-w-5xl mx-auto space-y-5">

            {/* ── Page header ─────────────────────────────────────────────── */}
            <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-xl shrink-0">
                        🔗
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-slate-100">Proxy Manager</h1>
                        <p className="text-xs text-slate-500">Manage proxychains4 per bot</p>
                    </div>
                </div>

                {/* Global master toggle pill */}
                <div className={`flex items-center gap-2.5 px-4 py-2 rounded-xl border transition-all ${
                    config.enabled
                        ? "bg-indigo-600/15 border-indigo-500/40"
                        : "bg-slate-800/60 border-slate-700/50"
                }`}>
                    <span className={`text-xs font-bold ${config.enabled ? "text-indigo-300" : "text-slate-500"}`}>
                        {config.enabled ? "🟢 Proxy Active" : "⚫ Proxy Inactive"}
                    </span>
                    <Toggle enabled={config.enabled} onChange={handleToggleGlobal} />
                </div>
            </div>

            {/* ── Stats row ───────────────────────────────────────────────── */}
            <div className="grid grid-cols-3 gap-3">
                {[
                    {
                        label: "Status",
                        value: config.enabled ? "Active" : "Inactive",
                        icon: "🌐",
                        color: config.enabled ? "text-emerald-400" : "text-slate-500",
                        sub: config.host ? `${config.host}:${config.port}` : "Not configured",
                    },
                    {
                        label: "Proxied Bots",
                        value: `${enabledCount}`,
                        icon: "🤖",
                        color: "text-indigo-400",
                        sub: `of ${bots.length} total`,
                    },
                    {
                        label: "Proxy Type",
                        value: config.type?.toUpperCase() || "—",
                        icon: "🔌",
                        color: "text-sky-400",
                        sub: config.host ? "Configured" : "Not set",
                    },
                ].map((s) => (
                    <div key={s.label} className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-3 flex items-center gap-3 backdrop-blur-sm">
                        <span className="text-xl shrink-0">{s.icon}</span>
                        <div className="min-w-0">
                            <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">{s.label}</p>
                            <p className={`text-sm font-bold ${s.color} truncate`}>{s.value}</p>
                            <p className="text-[10px] text-slate-600 truncate">{s.sub}</p>
                        </div>
                    </div>
                ))}
            </div>

            {/* ── Config card (collapsible) ────────────────────────────────── */}
            <div className="bg-slate-900/60 border border-slate-800/60 rounded-2xl backdrop-blur-sm overflow-hidden">
                <button
                    onClick={() => setConfigOpen((v) => !v)}
                    className="w-full flex items-center justify-between px-5 py-4 border-b border-slate-800/60 hover:bg-slate-800/20 transition-colors"
                >
                    <div className="text-left">
                        <h2 className="text-sm font-bold text-slate-100">Proxy Configuration</h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                            {config.host
                                ? `${config.type?.toUpperCase()} · ${config.host}:${config.port}${config.username ? " · auth" : ""}`
                                : "Click to configure"}
                        </p>
                    </div>
                    <motion.span
                        animate={{ rotate: configOpen ? 180 : 0 }}
                        transition={{ duration: 0.2 }}
                        className="text-slate-500 text-sm"
                    >
                        ▼
                    </motion.span>
                </button>

                <AnimatePresence initial={false}>
                    {configOpen && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.22 }}
                            className="overflow-hidden"
                        >
                            {loadingConfig ? (
                                <div className="p-8 flex justify-center">
                                    <div className="animate-spin h-7 w-7 border-4 border-indigo-500 border-t-transparent rounded-full" />
                                </div>
                            ) : (
                                <div className="p-5 space-y-4">
                                    {/* Type pills */}
                                    <div className="flex gap-2">
                                        {["socks5", "socks4", "http"].map((t) => (
                                            <button
                                                key={t}
                                                onClick={() => setConfig((c) => ({ ...c, type: t }))}
                                                className={`px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all duration-200 ${
                                                    config.type === t
                                                        ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20"
                                                        : "bg-slate-800/60 text-slate-400 hover:bg-slate-700/60 hover:text-slate-200 border border-slate-700/50"
                                                }`}
                                            >
                                                {t}
                                            </button>
                                        ))}
                                    </div>

                                    {/* Host + Port */}
                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                        <div className="sm:col-span-2">
                                            <InputField
                                                id="proxy-host"
                                                label="Host / IP"
                                                icon="🖥️"
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
                                            hint="Leave blank if no auth required"
                                        />
                                        <div className="space-y-1.5">
                                            <label htmlFor="proxy-pass" className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
                                                Password
                                            </label>
                                            <div className="relative">
                                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm select-none pointer-events-none">🔑</span>
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
                                            <p className="text-[10px] text-slate-600">Leave blank if no auth required</p>
                                        </div>
                                    </div>

                                    {/* Info + Save */}
                                    <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
                                        <div className="flex-1 flex items-start gap-2 bg-indigo-500/5 border border-indigo-500/20 rounded-xl px-3 py-2.5">
                                            <span className="text-sm shrink-0 mt-0.5">ℹ️</span>
                                            <p className="text-xs text-slate-400 leading-relaxed">
                                                A <code className="text-indigo-400 font-mono">.proxychains4.conf</code> is written per bot on each start. <code className="text-indigo-400 font-mono">proxychains4</code> must be installed on the server.
                                            </p>
                                        </div>
                                        <button
                                            onClick={handleSaveConfig}
                                            disabled={savingConfig}
                                            className="shrink-0 flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-all shadow-lg shadow-indigo-600/20"
                                        >
                                            {savingConfig ? (
                                                <><span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />Saving…</>
                                            ) : "💾 Save"}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* ── Bot assignments card ─────────────────────────────────────── */}
            <div className="bg-slate-900/60 border border-slate-800/60 rounded-2xl backdrop-blur-sm overflow-hidden">
                {/* Toolbar */}
                <div className="px-5 py-3.5 border-b border-slate-800/60 flex flex-wrap items-center gap-3">
                    <div className="flex-1 min-w-0">
                        <h2 className="text-sm font-bold text-slate-100">Bot Assignments</h2>
                        <p className="text-xs text-slate-500">{enabledCount} of {bots.length} bots using proxy</p>
                    </div>

                    {/* Search */}
                    <div className="relative">
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-xs pointer-events-none">🔍</span>
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search bots…"
                            className="bg-slate-800/60 border border-slate-700/50 rounded-lg text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-indigo-500/70 py-1.5 pl-7 pr-3 w-40 transition-all"
                        />
                    </div>

                    {/* View mode */}
                    <div className="flex bg-slate-800/60 border border-slate-700/40 rounded-lg p-0.5 gap-0.5">
                        {[
                            { key: "group", label: "🗂 Group" },
                            { key: "buyer", label: "👤 Buyer" },
                            { key: "flat",  label: "☰ All" },
                        ].map(({ key, label }) => (
                            <button
                                key={key}
                                onClick={() => setViewMode(key)}
                                className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all ${
                                    viewMode === key
                                        ? "bg-indigo-600 text-white shadow-sm"
                                        : "text-slate-400 hover:text-slate-200"
                                }`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    {/* Global bulk */}
                    <div className="flex gap-1.5">
                        <button
                            onClick={() => handleAllBulk(true)}
                            disabled={bulkingGroup === "__all__" || loadingBots}
                            className="px-3 py-1.5 text-[11px] font-semibold bg-emerald-600/15 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/20 rounded-lg transition-all disabled:opacity-40"
                        >
                            All ON
                        </button>
                        <button
                            onClick={() => handleAllBulk(false)}
                            disabled={bulkingGroup === "__all__" || loadingBots}
                            className="px-3 py-1.5 text-[11px] font-semibold bg-red-600/15 hover:bg-red-600/30 text-red-400 border border-red-500/20 rounded-lg transition-all disabled:opacity-40"
                        >
                            All OFF
                        </button>
                    </div>
                </div>

                {/* Content */}
                {loadingBots ? (
                    <div className="p-10 flex justify-center">
                        <div className="animate-spin h-7 w-7 border-4 border-indigo-500 border-t-transparent rounded-full" />
                    </div>
                ) : filteredBots.length === 0 ? (
                    <div className="p-12 text-center">
                        <p className="text-4xl mb-3">{search ? "🔍" : "🤖"}</p>
                        <p className="text-slate-400 text-sm font-medium">
                            {search ? "No bots match your search" : "No bots found"}
                        </p>
                    </div>
                ) : viewMode === "flat" ? (
                    /* Flat mode — simple list */
                    <div className="divide-y divide-slate-800/30">
                        {filteredBots.map((bot) => (
                            <BotRow
                                key={bot._id}
                                bot={bot}
                                togglingId={togglingId}
                                onToggle={handleToggleBot}
                            />
                        ))}
                    </div>
                ) : (
                    /* Grouped mode (group or buyer) */
                    <div className="p-3 space-y-2">
                        {groups.map((g) => {
                            const fakeGroup = {
                                _id: g.key,
                                name: g.label ?? "All Bots",
                                color: g.color,
                            };
                            return (
                                <GroupSection
                                    key={g.key}
                                    group={fakeGroup}
                                    bots={g.bots}
                                    togglingId={togglingId}
                                    bulkingGroup={bulkingGroup}
                                    onToggle={handleToggleBot}
                                    onGroupBulk={handleGroupBulk}
                                    defaultOpen={groups.length <= 4}
                                />
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ── Toast via portal ─────────────────────────────────────────── */}
            {createPortal(
                <AnimatePresence>
                    {toast && (
                        <motion.div
                            initial={{ opacity: 0, y: 20, scale: 0.95 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 10, scale: 0.95 }}
                            transition={{ duration: 0.2 }}
                            className={`fixed bottom-24 lg:bottom-6 right-4 lg:right-6 z-[9999] px-4 py-3 rounded-xl shadow-2xl text-sm font-semibold flex items-center gap-2 max-w-xs backdrop-blur-xl ${
                                toast.type === "error"
                                    ? "bg-red-900/80 text-red-200 border border-red-500/30"
                                    : "bg-slate-800 text-slate-100 border border-slate-700/60"
                            }`}
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
