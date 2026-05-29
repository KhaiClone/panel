import { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useData } from "../context/DataContext";
import api from "../api/client";
import { motion, AnimatePresence } from "framer-motion";
import ConfirmModal from "../components/ConfirmModal";

// ── Status helpers ──────────────────────────────────────────────────────────
const STATUS_DOT = {
    online: "bg-emerald-400",
    stopped: "bg-rose-400",
    errored: "bg-orange-400",
    launching: "bg-yellow-400",
};
const STATUS_LABEL = {
    online: "Online",
    stopped: "Stopped",
    errored: "Errored",
    launching: "Launching",
};

// ── Action definitions ──────────────────────────────────────────────────────
const ACTIONS = [
    {
        key: "start",
        label: "Start",
        bg: "rgba(5,150,105,0.18)",
        border: "rgba(16,185,129,0.35)",
        color: "#34d399",
        hoverBg: "rgba(5,150,105,0.32)",
        shadow: "rgba(16,185,129,0.2)",
        disabledBg: "rgba(5,150,105,0.06)",
        disabledBorder: "rgba(16,185,129,0.1)",
        icon: (
            <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                className="w-[18px] h-[18px]"
            >
                <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
        ),
    },
    {
        key: "stop",
        label: "Stop",
        bg: "rgba(220,38,38,0.18)",
        border: "rgba(239,68,68,0.35)",
        color: "#f87171",
        hoverBg: "rgba(220,38,38,0.32)",
        shadow: "rgba(239,68,68,0.2)",
        disabledBg: "rgba(220,38,38,0.06)",
        disabledBorder: "rgba(239,68,68,0.1)",
        icon: (
            <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                className="w-[18px] h-[18px]"
            >
                <rect x="6" y="6" width="12" height="12" rx="1.5" />
            </svg>
        ),
    },
    {
        key: "restart",
        label: "Restart",
        bg: "rgba(217,119,6,0.18)",
        border: "rgba(245,158,11,0.35)",
        color: "#fbbf24",
        hoverBg: "rgba(217,119,6,0.32)",
        shadow: "rgba(245,158,11,0.2)",
        disabledBg: "rgba(217,119,6,0.06)",
        disabledBorder: "rgba(245,158,11,0.1)",
        icon: (
            <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-[18px] h-[18px]"
            >
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 .49-4.5" />
            </svg>
        ),
    },
    {
        key: "install",
        label: "Install",
        bg: "rgba(79,70,229,0.18)",
        border: "rgba(99,102,241,0.35)",
        color: "#818cf8",
        hoverBg: "rgba(79,70,229,0.32)",
        shadow: "rgba(99,102,241,0.2)",
        disabledBg: "rgba(79,70,229,0.06)",
        disabledBorder: "rgba(99,102,241,0.1)",
        icon: (
            <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-[18px] h-[18px]"
            >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
        ),
    },
    {
        key: "update",
        label: "Update",
        bg: "rgba(6,182,212,0.18)",
        border: "rgba(34,211,238,0.35)",
        color: "#22d3ee",
        hoverBg: "rgba(6,182,212,0.32)",
        shadow: "rgba(34,211,238,0.2)",
        disabledBg: "rgba(6,182,212,0.06)",
        disabledBorder: "rgba(34,211,238,0.1)",
        icon: (
            <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-[18px] h-[18px]"
            >
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 .49-4.5" />
                <polyline points="17 14 21 14 21 10" />
            </svg>
        ),
    },
    {
        key: "remove",
        label: "Remove",
        danger: true,
        bg: "rgba(190,18,60,0.2)",
        border: "rgba(244,63,94,0.4)",
        color: "#fb7185",
        hoverBg: "rgba(190,18,60,0.36)",
        shadow: "rgba(244,63,94,0.25)",
        disabledBg: "rgba(190,18,60,0.06)",
        disabledBorder: "rgba(244,63,94,0.1)",
        icon: (
            <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-[18px] h-[18px]"
            >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14H6L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4h6v2" />
            </svg>
        ),
    },
];

// ── Single Action Button (used inside toolbar) ──────────────────────────────
function ActionButton({ action, busy, disabled, onClick }) {
    const [hovered, setHovered] = useState(false);
    const isLoading = busy === action.key;
    const isDisabled = disabled || (!!busy && !isLoading);

    return (
        <motion.button
            whileHover={!isDisabled ? { scale: 1.04, y: -2 } : {}}
            whileTap={!isDisabled ? { scale: 0.96 } : {}}
            transition={{ type: "spring", stiffness: 400, damping: 20 }}
            onClick={onClick}
            disabled={isDisabled}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            className="flex flex-col items-center gap-1.5 py-3 px-2.5 rounded-xl flex-1 min-w-[68px] relative overflow-hidden"
            style={{
                background: isDisabled
                    ? action.disabledBg
                    : hovered
                      ? action.hoverBg
                      : action.bg,
                border: `1px solid ${isDisabled ? action.disabledBorder : action.border}`,
                color: isDisabled ? `${action.color}40` : action.color,
                boxShadow:
                    !isDisabled && hovered
                        ? `0 8px 24px ${action.shadow}`
                        : "none",
                cursor: isDisabled ? "not-allowed" : "pointer",
                transition:
                    "background 0.2s, border-color 0.2s, color 0.2s, box-shadow 0.2s",
            }}
        >
            {/* Hover sweep */}
            <AnimatePresence>
                {hovered && !isDisabled && (
                    <motion.div
                        initial={{ x: "-100%", opacity: 0 }}
                        animate={{ x: "150%", opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.45, ease: "easeInOut" }}
                        className="absolute inset-0 pointer-events-none"
                        style={{
                            background: `linear-gradient(90deg, transparent, ${action.color}20, transparent)`,
                        }}
                    />
                )}
            </AnimatePresence>

            {isLoading ? (
                <>
                    <svg
                        className="animate-spin w-[18px] h-[18px]"
                        viewBox="0 0 24 24"
                        fill="none"
                    >
                        <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                        />
                        <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                    </svg>
                    <span className="text-[9px] font-black uppercase tracking-widest">
                        Working…
                    </span>
                </>
            ) : (
                <>
                    <span className="relative z-10">{action.icon}</span>
                    <span className="relative z-10 text-[9px] font-black uppercase tracking-widest">
                        {action.label}
                    </span>
                </>
            )}
        </motion.button>
    );
}

// ── Compact bot row ────────────────────────────────────────────────────────
function BotRow({ bot, selected, onToggle }) {
    const status = bot.live?.status || "stopped";
    const dotClass = STATUS_DOT[status] || "bg-slate-400";
    const isExpired = bot.expiresAt && bot.expiresAt <= Date.now();

    return (
        <motion.label
            layout
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer transition-all duration-200 group select-none ${
                selected
                    ? "bg-indigo-500/10 border border-indigo-500/30 shadow-lg shadow-indigo-500/5"
                    : "bg-slate-900/30 border border-slate-800/40 hover:bg-slate-800/40 hover:border-slate-700/50"
            }`}
        >
            {/* Checkbox */}
            <div
                className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all shrink-0 ${
                    selected
                        ? "bg-indigo-500 border-indigo-500 shadow-md shadow-indigo-500/30"
                        : "border-slate-600 group-hover:border-slate-500"
                }`}
            >
                {selected && (
                    <motion.svg
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        className="w-3 h-3 text-white"
                        viewBox="0 0 12 12"
                        fill="none"
                    >
                        <path
                            d="M2 6l3 3 5-5"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </motion.svg>
                )}
            </div>
            <input
                type="checkbox"
                checked={selected}
                onChange={onToggle}
                className="sr-only"
            />

            {/* Status dot */}
            <span className="relative flex h-2.5 w-2.5 shrink-0">
                {status === "online" && (
                    <span
                        className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${dotClass}`}
                    />
                )}
                <span
                    className={`relative inline-flex rounded-full h-2.5 w-2.5 ${dotClass}`}
                />
            </span>

            {/* Bot info */}
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-slate-100 truncate">
                        {bot.name}
                    </span>
                    {isExpired && (
                        <span className="text-[9px] font-black uppercase tracking-wider bg-rose-500/10 border border-rose-500/20 text-rose-400 px-1.5 py-0.5 rounded-full">
                            Expired
                        </span>
                    )}
                </div>
                <p className="text-[10px] text-slate-500 font-mono truncate">
                    {bot.buyerID} / {bot.botID}
                </p>
            </div>

            <span
                className={`text-[9px] font-black uppercase tracking-widest ${
                    status === "online"
                        ? "text-emerald-400"
                        : status === "errored"
                          ? "text-orange-400"
                          : "text-slate-600"
                }`}
            >
                {STATUS_LABEL[status] || "Unknown"}
            </span>
        </motion.label>
    );
}

// ── Group section ──────────────────────────────────────────────────────────
function GroupSection({
    label,
    color,
    bots,
    selected,
    onToggleBot,
    onToggleGroup,
}) {
    const [open, setOpen] = useState(true);
    const allSelected =
        bots.length > 0 && bots.every((b) => selected.has(b._id));
    const someSelected = bots.some((b) => selected.has(b._id));

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-3">
                <button
                    onClick={() =>
                        onToggleGroup(
                            bots.map((b) => b._id),
                            !allSelected,
                        )
                    }
                    className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all shrink-0 ${
                        allSelected
                            ? "bg-indigo-500 border-indigo-500 shadow-md shadow-indigo-500/30"
                            : someSelected
                              ? "bg-indigo-500/30 border-indigo-500/50"
                              : "border-slate-600 hover:border-slate-500"
                    }`}
                >
                    {allSelected && (
                        <svg
                            className="w-3 h-3 text-white"
                            viewBox="0 0 12 12"
                            fill="none"
                        >
                            <path
                                d="M2 6l3 3 5-5"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        </svg>
                    )}
                    {someSelected && !allSelected && (
                        <div className="w-2 h-0.5 bg-white rounded-full" />
                    )}
                </button>

                <button
                    onClick={() => setOpen((v) => !v)}
                    className="flex items-center gap-2 flex-1 text-left group"
                >
                    <span
                        className="w-3 h-3 rounded-full shrink-0"
                        style={{
                            background: color,
                            boxShadow: `0 0 10px ${color}44`,
                        }}
                    />
                    <span className="text-sm font-bold text-slate-400 group-hover:text-slate-100 transition-colors uppercase tracking-wider">
                        {label}
                    </span>
                    <span className="text-xs text-slate-600 font-mono ml-1">
                        [{bots.length}]
                    </span>
                    {someSelected && (
                        <span className="text-[9px] font-black text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded-full border border-indigo-500/20">
                            {bots.filter((b) => selected.has(b._id)).length}{" "}
                            selected
                        </span>
                    )}
                    <motion.span
                        animate={{ rotate: open ? 0 : -90 }}
                        className="ml-auto text-slate-600 text-xs"
                    >
                        ▾
                    </motion.span>
                </button>
            </div>

            <AnimatePresence>
                {open && (
                    <motion.div
                        key="bots"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden"
                    >
                        <div
                            className="space-y-1.5 pl-4 border-l-2 ml-2"
                            style={{ borderLeftColor: `${color}33` }}
                        >
                            {bots.map((bot) => (
                                <BotRow
                                    key={bot._id}
                                    bot={bot}
                                    selected={selected.has(bot._id)}
                                    onToggle={() => onToggleBot(bot._id)}
                                />
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

// ── Results Modal ──────────────────────────────────────────────────────────
function ResultsModal({ results, actionLabel, onClose }) {
    const okCount = results.filter((r) => r.status === "ok").length;
    const errCount = results.filter((r) => r.status === "error").length;

    return createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                className="w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col rounded-2xl"
                style={{
                    background:
                        "linear-gradient(135deg, rgba(17,24,39,0.98), rgba(13,21,37,0.98))",
                    border: "1px solid rgba(255,255,255,0.08)",
                    boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
                }}
            >
                <div
                    className="flex items-center justify-between p-5 pb-4"
                    style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
                >
                    <div>
                        <h2 className="text-base font-black text-slate-100">
                            Bulk {actionLabel} — Results
                        </h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                            <span className="text-emerald-400 font-bold">
                                {okCount} succeeded
                            </span>
                            {errCount > 0 && (
                                <span className="text-rose-400 font-bold ml-2">
                                    · {errCount} failed
                                </span>
                            )}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:text-white transition-colors"
                        style={{ background: "rgba(255,255,255,0.05)" }}
                    >
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            className="w-4 h-4"
                        >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-5 space-y-2">
                    {results.map((r, i) => (
                        <motion.div
                            key={r.botId}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: i * 0.03 }}
                            className="flex items-center gap-3 px-3 py-2.5 rounded-xl border"
                            style={{
                                background:
                                    r.status === "ok"
                                        ? "rgba(5,150,105,0.08)"
                                        : "rgba(220,38,38,0.08)",
                                borderColor:
                                    r.status === "ok"
                                        ? "rgba(16,185,129,0.2)"
                                        : "rgba(239,68,68,0.2)",
                            }}
                        >
                            <span className="text-base shrink-0">
                                {r.status === "ok" ? "✅" : "❌"}
                            </span>
                            <div className="flex-1 min-w-0">
                                <p className="font-bold text-slate-200 truncate text-sm">
                                    {r.name}
                                </p>
                                <p
                                    className="text-[10px] font-mono truncate"
                                    style={{
                                        color:
                                            r.status === "ok"
                                                ? "rgba(52,211,153,0.7)"
                                                : "rgba(248,113,113,0.7)",
                                    }}
                                >
                                    {r.message}
                                </p>
                            </div>
                        </motion.div>
                    ))}
                </div>
                <div
                    className="p-5 pt-4"
                    style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
                >
                    <button
                        onClick={onClose}
                        className="btn-primary w-full py-2.5 font-black uppercase tracking-widest text-[10px]"
                    >
                        Close
                    </button>
                </div>
            </motion.div>
        </div>,
        document.body,
    );
}

// ── Main Page ──────────────────────────────────────────────────────────────
export default function MultiManage() {
    const { bots, groups, tags, refresh } = useData();
    const [selected, setSelected] = useState(new Set());
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("all");
    const [selectedTags, setSelectedTags] = useState([]);
    const [busy, setBusy] = useState(null);
    const [results, setResults] = useState(null);
    const [confirm, setConfirm] = useState(null);
    const [lastAction, setLastAction] = useState("");

    const filtered = useMemo(
        () =>
            bots.filter((b) => {
                const matchSearch =
                    !search.trim() ||
                    b.name.toLowerCase().includes(search.toLowerCase()) ||
                    b.botID.toLowerCase().includes(search.toLowerCase()) ||
                    b.buyerID.toLowerCase().includes(search.toLowerCase()) ||
                    (b.tags || []).some((tid) => {
                        const tag = tags.find((t) => t._id === tid);
                        return tag?.name.toLowerCase().includes(search.toLowerCase());
                    });
                const matchStatus =
                    statusFilter === "all" ||
                    (statusFilter === "online" &&
                        b.live?.status === "online") ||
                    (statusFilter === "stopped" && b.live?.status !== "online");
                const matchTags =
                    selectedTags.length === 0 ||
                    selectedTags.some((tid) => (b.tags || []).includes(tid));
                return matchSearch && matchStatus && matchTags;
            }),
        [bots, search, statusFilter, selectedTags, tags],
    );

    const toggleTag = (tagId) =>
        setSelectedTags((prev) =>
            prev.includes(tagId) ? prev.filter((t) => t !== tagId) : [...prev, tagId]
        );

    const groupMap = useMemo(
        () => Object.fromEntries(groups.map((g) => [g._id, g])),
        [groups],
    );
    const botsByGroup = useMemo(
        () =>
            groups
                .map((g) => ({
                    group: g,
                    bots: filtered.filter((b) => b.groupId === g._id),
                }))
                .filter((s) => s.bots.length > 0),
        [groups, filtered],
    );
    const ungrouped = useMemo(
        () => filtered.filter((b) => !b.groupId || !groupMap[b.groupId]),
        [filtered, groupMap],
    );

    const toggleBot = (id) =>
        setSelected((prev) => {
            const n = new Set(prev);
            n.has(id) ? n.delete(id) : n.add(id);
            return n;
        });
    const toggleGroup = (ids, add) =>
        setSelected((prev) => {
            const n = new Set(prev);
            ids.forEach((id) => (add ? n.add(id) : n.delete(id)));
            return n;
        });
    const selectAll = () => setSelected(new Set(filtered.map((b) => b._id)));
    const deselectAll = () => setSelected(new Set());

    useEffect(() => {
        const ids = new Set(filtered.map((b) => b._id));
        setSelected((prev) => {
            const n = new Set([...prev].filter((id) => ids.has(id)));
            return n.size !== prev.size ? n : prev;
        });
    }, [filtered]);

    const executeBulk = async (action) => {
        if (selected.size === 0) return;
        setBusy(action);
        setLastAction(ACTIONS.find((a) => a.key === action)?.label || action);
        try {
            const { data } = await api.post(`/bulk/${action}`, {
                botIds: [...selected],
            });
            setResults(data.results);
            if (action === "remove") {
                const removed = new Set(
                    data.results
                        .filter((r) => r.status === "ok")
                        .map((r) => r.botId),
                );
                setSelected(
                    (prev) =>
                        new Set([...prev].filter((id) => !removed.has(id))),
                );
            }
            refresh();
        } catch (err) {
            setResults([
                {
                    botId: "-",
                    name: "System Error",
                    status: "error",
                    message: err.response?.data?.error || err.message,
                },
            ]);
        } finally {
            setBusy(null);
        }
    };

    const handleAction = (action) => {
        if (action === "remove") setConfirm({ action: "remove" });
        else executeBulk(action);
    };

    const selectedCount = selected.size;
    const hasSelection = selectedCount > 0;
    const allFilteredSelected =
        filtered.length > 0 && filtered.every((b) => selected.has(b._id));

    return (
        <div className="p-5 lg:p-7 max-w-5xl mx-auto space-y-5">
            {/* ── Page header ── */}
            <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
                <div>
                    <h1 className="text-2xl lg:text-3xl font-black text-slate-100 tracking-tight">
                        Multi Manage
                    </h1>
                    <p className="text-xs text-slate-500 mt-1 font-medium">
                        Bulk operations on{" "}
                        <span className="text-violet-400 font-bold">
                            {bots.length}
                        </span>{" "}
                        instances
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={allFilteredSelected ? deselectAll : selectAll}
                        className="btn-ghost text-xs"
                    >
                        {allFilteredSelected ? "Deselect All" : "Select All"}
                    </button>
                </div>
            </motion.div>

            {/* ══════════════════════════════════════════════════════════════════
          ALWAYS-VISIBLE ACTION TOOLBAR
      ══════════════════════════════════════════════════════════════════ */}
            <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.06 }}
                className="relative rounded-2xl overflow-hidden"
                style={{
                    // Glowing border when active, subtle when idle
                    boxShadow: hasSelection
                        ? "0 0 0 1px rgba(124,58,237,0.4), 0 8px 32px rgba(124,58,237,0.15), 0 2px 8px rgba(0,0,0,0.4)"
                        : "0 0 0 1px rgba(255,255,255,0.05), 0 2px 8px rgba(0,0,0,0.3)",
                    transition: "box-shadow 0.4s ease",
                }}
            >
                {/* Animated glow halo when active */}
                <AnimatePresence>
                    {hasSelection && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.35 }}
                            className="absolute -inset-[1px] rounded-2xl pointer-events-none"
                            style={{
                                background:
                                    "linear-gradient(135deg, rgba(124,58,237,0.3), rgba(79,70,229,0.2), rgba(16,185,129,0.12))",
                                filter: "blur(4px)",
                            }}
                        />
                    )}
                </AnimatePresence>

                <div
                    className="relative rounded-2xl p-4"
                    style={{
                        background:
                            "linear-gradient(160deg, rgba(13,18,30,0.97) 0%, rgba(8,12,22,0.97) 100%)",
                        border: `1px solid ${hasSelection ? "rgba(124,58,237,0.2)" : "rgba(255,255,255,0.06)"}`,
                        transition: "border-color 0.4s ease",
                    }}
                >
                    {/* Toolbar header */}
                    <div className="flex items-center gap-3 mb-3">
                        {/* Status indicator */}
                        <div className="flex items-center gap-2">
                            <span className="relative flex h-2 w-2 shrink-0">
                                {hasSelection && (
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-60" />
                                )}
                                <span
                                    className="relative inline-flex h-2 w-2 rounded-full transition-colors duration-300"
                                    style={{
                                        background: hasSelection
                                            ? "#a78bfa"
                                            : "#334155",
                                    }}
                                />
                            </span>
                            <span
                                className="text-[10px] font-black uppercase tracking-[0.14em] transition-colors duration-300"
                                style={{
                                    color: hasSelection ? "#c4b5fd" : "#475569",
                                }}
                            >
                                {hasSelection
                                    ? `${selectedCount} bot${selectedCount !== 1 ? "s" : ""} ready`
                                    : "Select bots to enable actions"}
                            </span>
                        </div>

                        <div className="flex-1" />

                        {/* Clear button — only when active */}
                        <AnimatePresence>
                            {hasSelection && (
                                <motion.button
                                    initial={{ opacity: 0, scale: 0.8 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.8 }}
                                    onClick={deselectAll}
                                    className="text-[9px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-lg transition-all"
                                    style={{
                                        color: "#64748b",
                                        background: "rgba(255,255,255,0.04)",
                                        border: "1px solid rgba(255,255,255,0.07)",
                                    }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.color = "#e2e8f0";
                                        e.currentTarget.style.background =
                                            "rgba(255,255,255,0.08)";
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.color = "#64748b";
                                        e.currentTarget.style.background =
                                            "rgba(255,255,255,0.04)";
                                    }}
                                >
                                    Clear ✕
                                </motion.button>
                            )}
                        </AnimatePresence>
                    </div>

                    {/* Action buttons row */}
                    <div className="flex gap-2 flex-wrap">
                        {ACTIONS.map((action) => (
                            <ActionButton
                                key={action.key}
                                action={action}
                                busy={busy}
                                disabled={!hasSelection}
                                onClick={() => handleAction(action.key)}
                            />
                        ))}
                    </div>
                </div>
            </motion.div>

            {/* ── Filters ── */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.1 }}
                className="flex flex-col lg:flex-row lg:items-center gap-3 rounded-2xl p-3 lg:p-4"
                style={{
                    background: "rgba(13,21,37,0.7)",
                    border: "1px solid rgba(255,255,255,0.05)",
                    backdropFilter: "blur(12px)",
                }}
            >
                <div className="relative w-full lg:max-w-xs">
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="w-4 h-4"
                        >
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                    </div>
                    <input
                        className="input pl-9"
                        placeholder="Search bots…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>

                <div
                    className="flex gap-1 p-1 rounded-xl"
                    style={{
                        background: "rgba(6,11,20,0.6)",
                        border: "1px solid rgba(255,255,255,0.05)",
                    }}
                >
                    {["all", "online", "stopped"].map((f) => {
                        const isActive = statusFilter === f;
                        return (
                            <button
                                key={f}
                                className="relative px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-[0.08em] select-none"
                                style={{
                                    color: isActive ? "#fff" : "#64748b",
                                    transition: "color 0.2s ease",
                                    zIndex: 1,
                                }}
                                onClick={() => setStatusFilter(f)}
                            >
                                {isActive && (
                                    <motion.div
                                        layoutId="multiFilterPill"
                                        className="absolute inset-0 rounded-lg"
                                        initial={false}
                                        transition={{
                                            type: "spring",
                                            stiffness: 400,
                                            damping: 32,
                                        }}
                                        style={{
                                            background:
                                                "linear-gradient(135deg,#7C3AED,#4F46E5)",
                                            boxShadow:
                                                "0 4px 14px rgba(124,58,237,0.35)",
                                        }}
                                    />
                                )}
                                <span
                                    className="relative"
                                    style={{ zIndex: 2 }}
                                >
                                    {f}
                                </span>
                            </button>
                        );
                    })}
                </div>

                <span className="text-[10px] font-mono text-slate-600 ml-auto hidden lg:inline">
                    {filtered.length} / {bots.length} bots
                </span>
            </motion.div>

            {/* ── Tag filter pills ── */}
            {tags.length > 0 && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.15 }}
                    className="flex flex-wrap gap-2 items-center px-1"
                >
                    <span className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-600 shrink-0">Tags:</span>
                    {selectedTags.length > 0 && (
                        <button
                            onClick={() => setSelectedTags([])}
                            className="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full transition-colors"
                            style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171" }}
                        >
                            ✕ Clear
                        </button>
                    )}
                    {tags.map((tag) => {
                        const isActive = selectedTags.includes(tag._id);
                        return (
                            <button
                                key={tag._id}
                                onClick={() => toggleTag(tag._id)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[9px] font-black uppercase tracking-[0.07em] transition-all duration-150"
                                style={{
                                    background: isActive ? `${tag.color}22` : "rgba(255,255,255,0.03)",
                                    border: `1px solid ${isActive ? tag.color + "55" : "rgba(255,255,255,0.07)"}`,
                                    color: isActive ? tag.color : "#64748b",
                                    transform: isActive ? "scale(1.05)" : "scale(1)",
                                    boxShadow: isActive ? `0 0 10px ${tag.color}30` : "none",
                                }}
                            >
                                <span className="w-1.5 h-1.5 rounded-full" style={{ background: isActive ? tag.color : "#64748b" }} />
                                {tag.name}
                            </button>
                        );
                    })}
                </motion.div>
            )}

            {/* ── Bot List ── */}
            {filtered.length === 0 ? (
                <motion.div
                    initial={{ opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex flex-col items-center justify-center py-24 rounded-2xl"
                    style={{
                        border: "1px dashed rgba(255,255,255,0.08)",
                        background: "rgba(255,255,255,0.01)",
                    }}
                >
                    <div className="text-5xl mb-4 opacity-30">⚡</div>
                    <p className="text-slate-400 font-medium text-sm">
                        {bots.length === 0
                            ? "No bots found. Create some bots first."
                            : "No bots match your filters."}
                    </p>
                </motion.div>
            ) : (
                <div className="space-y-6 pb-8">
                    {botsByGroup.map(({ group, bots: gb }) => (
                        <GroupSection
                            key={group._id}
                            label={group.name}
                            color={group.color}
                            bots={gb}
                            selected={selected}
                            onToggleBot={toggleBot}
                            onToggleGroup={toggleGroup}
                        />
                    ))}
                    {ungrouped.length > 0 && (
                        <GroupSection
                            label="Ungrouped"
                            color="#64748b"
                            bots={ungrouped}
                            selected={selected}
                            onToggleBot={toggleBot}
                            onToggleGroup={toggleGroup}
                        />
                    )}
                </div>
            )}

            {/* ── Results modal ── */}
            {results && (
                <ResultsModal
                    results={results}
                    actionLabel={lastAction}
                    onClose={() => setResults(null)}
                />
            )}

            {/* ── Confirm remove ── */}
            {confirm?.action === "remove" && (
                <ConfirmModal
                    title={`Remove ${selectedCount} bot${selectedCount !== 1 ? "s" : ""}?`}
                    message={`This will permanently stop and delete ${selectedCount} bot${selectedCount !== 1 ? "s" : ""}.\nLocal-sourced bots will keep their files on disk.\n\nThis cannot be undone.`}
                    confirmText="Remove All"
                    onConfirm={() => {
                        setConfirm(null);
                        executeBulk("remove");
                    }}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </div>
    );
}
