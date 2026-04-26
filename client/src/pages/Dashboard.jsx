import { useState, useEffect, useCallback } from "react";
import { useData } from "../context/DataContext";
import api from "../api/client";
import StatsWidget from "../components/StatsWidget";
import BotCard from "../components/BotCard";
import CreateBotModal from "../components/CreateBotModal";
import GroupManager from "../components/GroupManager";
import { motion, AnimatePresence } from "framer-motion";

const containerVariants = {
    hidden: { opacity: 0 },
    show: {
        opacity: 1,
        transition: {
            staggerChildren: 0.05
        }
    }
};

const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 300, damping: 24 } }
};

function GroupSection({ label, color, bots, onRefresh, defaultOpen = true }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <motion.div layout className="space-y-3">
            <button
                onClick={() => setOpen((v) => !v)}
                className="flex items-center gap-2 w-full text-left group"
            >
                <span className="w-3 h-3 rounded-full shrink-0 shadow-sm" style={{ background: color || "#64748b", boxShadow: `0 0 10px ${color}44` }} />
                <span className="text-sm font-bold text-slate-400 group-hover:text-slate-100 transition-colors uppercase tracking-wider">
                    {label}
                </span>
                <span className="text-xs text-slate-600 font-mono ml-1">[{bots.length}]</span>
                <motion.span 
                    animate={{ rotate: open ? 0 : -90 }}
                    className="ml-auto text-slate-600 text-xs"
                >
                    ▾
                </motion.span>
            </button>
            <AnimatePresence>
                {open && (
                    <motion.div 
                        key="group-content"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden"
                    >
                        <motion.div 
                            variants={containerVariants}
                            initial="hidden"
                            animate="show"
                            className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 pl-5 border-l border-slate-800/50" 
                            style={{ borderLeftColor: color ? `${color}33` : "#1e293b" }}
                        >
                            {bots.map((bot) => (
                                <motion.div key={bot._id} variants={itemVariants} layout>
                                    <BotCard bot={bot} onRefresh={onRefresh} />
                                </motion.div>
                            ))}
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
}

export default function Dashboard() {
    const { bots, groups, loading, refresh: fetchAll } = useData();
    const [showCreate, setShowCreate] = useState(false);
    const [showGroups, setShowGroups] = useState(false);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState("all");

    const online       = bots.filter((b) => b.live?.status === "online").length;
    const errored      = bots.filter((b) => b.live?.status === "errored").length;
    const expiringSoon = bots.filter((b) => {
        if (!b.expiresAt) return false;
        return (new Date(b.expiresAt) - Date.now()) / 86_400_000 <= 3;
    }).length;

    const visible = bots.filter((b) => {
        const ms = b.name.toLowerCase().includes(search.toLowerCase()) ||
                   b.botID.toLowerCase().includes(search.toLowerCase()) ||
                   b.buyerID.toLowerCase().includes(search.toLowerCase());
        const mf = filter === "all" ||
                   (filter === "online" && b.live?.status === "online") ||
                   (filter === "stopped" && b.live?.status !== "online");
        return ms && mf;
    });

    const groupMap     = Object.fromEntries(groups.map((g) => [g._id, g]));
    const botsByGroup  = groups.map((g) => ({ group: g, bots: visible.filter((b) => b.groupId === g._id) })).filter((s) => s.bots.length > 0);
    const ungrouped    = visible.filter((b) => !b.groupId || !groupMap[b.groupId]);
    const isFiltering  = search.trim() !== "" || filter !== "all";

    return (
        <div className="p-6 space-y-8 max-w-7xl mx-auto">
            {/* Header */}
            <motion.div 
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
                <div>
                    <h1 className="text-2xl lg:text-3xl font-black text-slate-100 tracking-tight">Dashboard</h1>
                    <p className="text-xs lg:text-sm text-slate-500 mt-1 font-medium">Monitoring <span className="text-indigo-400">{bots.length}</span> active instances</p>
                </div>
                <div className="flex gap-2 lg:gap-3 flex-wrap sm:flex-nowrap">
                    <button className="btn-ghost text-xs lg:text-sm flex-1 sm:flex-none py-2" onClick={() => setShowGroups(true)}>🗂️ Groups</button>
                    <button className="btn-primary flex-1 sm:flex-none py-2" onClick={() => setShowCreate(true)}>➕ New Bot</button>
                </div>
            </motion.div>

            {/* Summary cards */}
            <motion.div 
                variants={containerVariants}
                initial="hidden"
                animate="show"
                className="grid grid-cols-2 sm:grid-cols-4 gap-3 lg:gap-4"
            >
                {[
                    { label: "Total Bots",    value: bots.length,   color: "text-indigo-400", glow: "shadow-indigo-500/10" },
                    { label: "Online",         value: online,        color: "text-emerald-400", glow: "shadow-emerald-500/10" },
                    { label: "Errored",        value: errored,       color: "text-rose-400", glow: "shadow-rose-500/10" },
                    { label: "Expiring Soon",  value: expiringSoon,  color: "text-amber-400", glow: "shadow-amber-500/10" },
                ].map(({ label, value, color, glow }) => (
                    <motion.div key={label} variants={itemVariants} className={`card border-slate-800 shadow-xl ${glow} !p-3 lg:!p-5`}>
                        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{label}</p>
                        <p className={`text-2xl lg:text-3xl font-black mt-2 ${color}`}>{value}</p>
                    </motion.div>
                ))}
            </motion.div>

            <motion.div
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
            >
                <StatsWidget />
            </motion.div>

            {/* Bot list */}
            <div className="space-y-6">
                <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex flex-col lg:flex-row lg:items-center gap-4 bg-slate-900/40 p-3 lg:p-4 rounded-xl border border-slate-800/50 backdrop-blur-sm"
                >
                    <div className="relative w-full lg:max-w-xs">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">🔍</span>
                        <input className="input pl-9" placeholder="Search by name, ID..." value={search} onChange={(e) => setSearch(e.target.value)} />
                    </div>
                    <div className="flex bg-slate-800/50 p-1 rounded-lg border border-slate-700/50 gap-1 overflow-x-auto no-scrollbar whitespace-nowrap">
                        {["all", "online", "stopped"].map((f) => (
                            <button key={f}
                                className={`relative px-4 py-1.5 rounded-md text-[10px] lg:text-xs font-bold uppercase tracking-wider transition-all duration-200 overflow-hidden ${
                                    filter === f ? "text-white" : "text-slate-500 hover:text-slate-300 hover:bg-white/5"
                                }`}
                                onClick={() => setFilter(f)}>
                                {filter === f && (
                                    <motion.div 
                                        layoutId="filterBackground"
                                        className="absolute inset-0 bg-indigo-600 rounded-md shadow-lg shadow-indigo-600/20"
                                        transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                                    />
                                )}
                                <span className="relative z-10">{f}</span>
                            </button>
                        ))}
                    </div>
                    <span className="text-[10px] font-mono text-slate-500 ml-auto hidden lg:inline">{visible.length} <span className="opacity-50">/</span> {bots.length} BOTS</span>
                </motion.div>

                {loading && bots.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-60 gap-4">
                        <div className="relative">
                            <div className="w-12 h-12 border-4 border-indigo-500/20 rounded-full" />
                            <div className="absolute top-0 left-0 w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                        </div>
                        <p className="text-slate-500 text-sm font-medium animate-pulse">Initializing Interface...</p>
                    </div>
                ) : visible.length === 0 ? (
                    <motion.div 
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="card text-center py-20 border-dashed border-slate-700 bg-transparent"
                    >
                        <div className="text-5xl mb-4 grayscale opacity-50">🤖</div>
                        <p className="text-slate-400 font-medium">{bots.length === 0 ? 'Start by creating your first bot instance.' : "No results match your current filters."}</p>
                        {bots.length === 0 && <button className="btn-primary mt-6" onClick={() => setShowCreate(true)}>Create Bot Now</button>}
                    </motion.div>
                ) : isFiltering ? (
                    <motion.div 
                        variants={containerVariants}
                        initial="hidden"
                        animate="show"
                        layout
                        className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4"
                    >
                        <AnimatePresence mode="popLayout">
                            {visible.map((bot) => (
                                <motion.div 
                                    key={bot._id} 
                                    variants={itemVariants}
                                    layout
                                    initial={{ opacity: 0, scale: 0.9 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.9 }}
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
