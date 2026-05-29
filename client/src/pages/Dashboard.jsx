import { useState, useCallback } from "react";
import { useData } from "../context/DataContext";
import api from "../api/client";
import StatsWidget from "../components/StatsWidget";
import BotCard from "../components/BotCard";
import CreateBotModal from "../components/CreateBotModal";
import GroupManager from "../components/GroupManager";
import { motion, AnimatePresence } from "framer-motion";

// ── Stat card ──────────────────────────────────────────────────────────────
function StatCard({ label, value, icon, color, glow, delay = 0 }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay, type: "spring", stiffness: 300, damping: 24 }}
            className="stat-card"
        >
            <div className="flex items-start justify-between gap-2">
                <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-500">{label}</p>
                    <p className={`text-3xl font-black mt-2 tracking-tight ${color}`}>{value}</p>
                </div>
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0"
                    style={{ background: glow, border: `1px solid ${glow}` }}>
                    {icon}
                </div>
            </div>
        </motion.div>
    );
}

// ── Group section ──────────────────────────────────────────────────────────
function GroupSection({ label, color, bots, onRefresh, defaultOpen = true }) {
    const [open, setOpen] = useState(defaultOpen);
    const [animating, setAnimating] = useState(false);
    return (
        <motion.div layout className="space-y-3">
            <button
                onClick={() => { setAnimating(true); setOpen((v) => !v); }}
                className="flex items-center gap-3 w-full text-left group"
            >
                <span className="w-2.5 h-2.5 rounded-full shrink-0 transition-transform group-hover:scale-110"
                    style={{ background: color || "#64748b", boxShadow: `0 0 10px ${color}55` }} />
                <span className="text-xs font-black text-slate-400 group-hover:text-slate-200 transition-colors uppercase tracking-[0.12em]">
                    {label}
                </span>
                <span className="text-[10px] text-slate-600 font-mono px-1.5 py-0.5 rounded"
                    style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }}>
                    {bots.length}
                </span>
                <motion.div animate={{ rotate: open ? 0 : -90 }} className="ml-auto text-slate-600">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                        <polyline points="6 9 12 15 18 9"/>
                    </svg>
                </motion.div>
            </button>
            <AnimatePresence>
                {open && (
                    <motion.div
                        key="group-content"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        onAnimationComplete={() => setAnimating(false)}
                        style={{ overflow: animating ? "hidden" : "visible" }}
                    >
                        <div
                            className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 pl-5 pt-2"
                            style={{ borderLeft: `2px solid ${color ? `${color}33` : "rgba(255,255,255,0.05)"}` }}
                        >
                            {bots.map((bot) => (
                                <BotCard key={bot._id} bot={bot} onRefresh={onRefresh} />
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
}

// ── Dashboard ──────────────────────────────────────────────────────────────
export default function Dashboard() {
    const { bots, groups, tags, loading, refresh: fetchAll } = useData();
    const [showCreate, setShowCreate] = useState(false);
    const [showGroups, setShowGroups] = useState(false);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState("all");
    const [selectedTags, setSelectedTags] = useState([]);

    const online       = bots.filter((b) => b.live?.status === "online").length;
    const errored      = bots.filter((b) => b.live?.status === "errored").length;
    const expiringSoon = bots.filter((b) => {
        if (!b.expiresAt) return false;
        return (new Date(b.expiresAt) - Date.now()) / 86_400_000 <= 3;
    }).length;

    const visible = bots.filter((b) => {
        const ms = b.name.toLowerCase().includes(search.toLowerCase()) ||
                   b.botID.toLowerCase().includes(search.toLowerCase()) ||
                   b.buyerID.toLowerCase().includes(search.toLowerCase()) ||
                   (b.tags || []).some((tid) => {
                       const tag = tags.find((t) => t._id === tid);
                       return tag?.name.toLowerCase().includes(search.toLowerCase());
                   });
        const mf = filter === "all" ||
                   (filter === "online" && b.live?.status === "online") ||
                   (filter === "stopped" && b.live?.status !== "online");
        const mt = selectedTags.length === 0 ||
                   selectedTags.some((tid) => (b.tags || []).includes(tid));
        return ms && mf && mt;
    });

    const toggleTag = (tagId) => {
        setSelectedTags((prev) =>
            prev.includes(tagId) ? prev.filter((t) => t !== tagId) : [...prev, tagId]
        );
    };

    const groupMap    = Object.fromEntries(groups.map((g) => [g._id, g]));
    const botsByGroup = groups.map((g) => ({ group: g, bots: visible.filter((b) => b.groupId === g._id) })).filter((s) => s.bots.length > 0);
    const ungrouped   = visible.filter((b) => !b.groupId || !groupMap[b.groupId]);
    const isFiltering = search.trim() !== "" || filter !== "all" || selectedTags.length > 0;

    const FILTERS = ["all", "online", "stopped"];

    return (
        <div className="p-5 lg:p-7 space-y-7 max-w-7xl mx-auto">

            {/* ── Page header ── */}
            <motion.div
                initial={{ opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
                <div>
                    <h1 className="text-2xl lg:text-3xl font-black text-slate-100 tracking-tight">Dashboard</h1>
                    <p className="text-xs text-slate-500 mt-1 font-medium">
                        Monitoring <span className="text-violet-400 font-bold">{bots.length}</span> bot instances
                    </p>
                </div>
                <div className="flex gap-2">
                    <button
                        id="btn-create-bot"
                        className="btn-primary text-xs"
                        onClick={() => setShowCreate(true)}
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                        New Bot
                    </button>
                </div>
            </motion.div>

            {/* ── Stat cards ── */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 lg:gap-4">
                <StatCard label="Total Bots"   value={bots.length} icon="🤖" color="text-violet-400" glow="rgba(124,58,237,0.12)" delay={0}    />
                <StatCard label="Online"       value={online}       icon="✅" color="text-emerald-400" glow="rgba(16,185,129,0.12)" delay={0.04}  />
                <StatCard label="Errored"      value={errored}      icon="⚡" color="text-rose-400"    glow="rgba(239,68,68,0.12)"  delay={0.08}  />
                <StatCard label="Expiring"     value={expiringSoon} icon="⏳" color="text-amber-400"   glow="rgba(245,158,11,0.12)" delay={0.12}  />
            </div>

            {/* ── System stats widget ── */}
            <motion.div initial={{ opacity: 0, scale: 0.99 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.15 }}>
                <StatsWidget />
            </motion.div>

            {/* ── Bot list ── */}
            <div className="space-y-5">
                {/* Filter bar */}
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.2 }}
                    className="flex flex-col lg:flex-row lg:items-center gap-3 rounded-2xl p-3 lg:p-4"
                    style={{ background: "rgba(13,21,37,0.7)", border: "1px solid rgba(255,255,255,0.05)", backdropFilter: "blur(12px)" }}
                >
                    {/* Search */}
                    <div className="relative w-full lg:max-w-xs">
                        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                            </svg>
                        </div>
                        <input
                            id="bot-search"
                            className="input pl-9 text-sm"
                            placeholder="Search bots…"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </div>

                    {/* Filter pills — sliding indicator via Framer Motion layoutId */}
                    <div
                        className="flex gap-1 p-1 rounded-xl"
                        style={{ background: "rgba(6,11,20,0.6)", border: "1px solid rgba(255,255,255,0.05)" }}
                    >
                        {FILTERS.map((f) => {
                            const isActive = filter === f;
                            return (
                                <button
                                    key={f}
                                    id={`filter-${f}`}
                                    onClick={() => setFilter(f)}
                                    className="relative px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-[0.08em] select-none"
                                    style={{
                                        color: isActive ? "#fff" : "#64748b",
                                        transition: "color 0.2s ease",
                                        zIndex: 1,
                                    }}
                                >
                                    {/* Sliding background — only ONE lives in the DOM at a time (inside the active btn) */}
                                    {isActive && (
                                        <motion.div
                                            layoutId="dashFilterPill"
                                            className="absolute inset-0 rounded-lg"
                                            initial={false}
                                            transition={{ type: "spring", stiffness: 400, damping: 32 }}
                                            style={{
                                                background: "linear-gradient(135deg,#7C3AED,#4F46E5)",
                                                boxShadow: "0 4px 14px rgba(124,58,237,0.35)",
                                            }}
                                        />
                                    )}
                                    <span className="relative" style={{ zIndex: 2 }}>{f}</span>
                                </button>
                            );
                        })}
                    </div>


                    <span className="text-[10px] font-mono text-slate-600 ml-auto hidden lg:inline">
                        {visible.length} <span className="opacity-40">/</span> {bots.length} bots
                    </span>
                </motion.div>

                {/* Tag filter pills */}
                {tags.length > 0 && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.25 }}
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
                                    id={`tag-filter-${tag._id}`}
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

                {/* Bot grid / groups */}
                {loading && bots.length === 0 ? (
                    <div className="flex flex-col items-center justify-center pt-24 gap-4">
                        <div className="relative w-12 h-12">
                            <div className="absolute inset-0 rounded-full" style={{ border: "3px solid rgba(124,58,237,0.15)" }} />
                            <div className="absolute inset-0 rounded-full border-t-violet-500 animate-spin" style={{ border: "3px solid transparent", borderTopColor: "#7C3AED" }} />
                        </div>
                        <p className="text-xs text-slate-500 font-bold uppercase tracking-widest animate-pulse">Initializing…</p>
                    </div>
                ) : visible.length === 0 ? (
                    <motion.div
                        initial={{ opacity: 0, scale: 0.97 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="flex flex-col items-center justify-center py-24 rounded-2xl"
                        style={{ border: "1px dashed rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.01)" }}
                    >
                        <div className="text-5xl mb-4 opacity-30">🤖</div>
                        <p className="text-slate-500 font-medium text-sm">
                            {bots.length === 0 ? "No bots yet. Create your first instance." : "No results match your filters."}
                        </p>
                        {bots.length === 0 && (
                            <button className="btn-primary mt-5 text-xs" onClick={() => setShowCreate(true)}>
                                Create Bot
                            </button>
                        )}
                    </motion.div>
                ) : isFiltering ? (
                    <motion.div
                        layout
                        className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3"
                    >
                        <AnimatePresence mode="popLayout">
                            {visible.map((bot) => (
                                <motion.div
                                    key={bot._id}
                                    layout
                                    initial={{ opacity: 0, scale: 0.92 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.92 }}
                                >
                                    <BotCard bot={bot} onRefresh={fetchAll} />
                                </motion.div>
                            ))}
                        </AnimatePresence>
                    </motion.div>
                ) : (
                    <div className="space-y-8">
                        {botsByGroup.map(({ group, bots: gb }) => (
                            <GroupSection key={group._id} label={group.name} color={group.color} bots={gb} onRefresh={fetchAll} />
                        ))}
                        {ungrouped.length > 0 && (
                            <GroupSection label="Ungrouped" color="#64748b" bots={ungrouped} onRefresh={fetchAll} />
                        )}
                    </div>
                )}
            </div>

            {showCreate && <CreateBotModal onClose={() => setShowCreate(false)} onCreated={() => fetchAll()} />}
            {showGroups && <GroupManager onClose={() => setShowGroups(false)} onChanged={() => fetchAll()} />}
        </div>
    );
}
