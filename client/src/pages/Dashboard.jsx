import { useState, useEffect, useCallback } from "react";
import api from "../api/client";
import StatsWidget from "../components/StatsWidget";
import BotCard from "../components/BotCard";
import CreateBotModal from "../components/CreateBotModal";
import GroupManager from "../components/GroupManager";

function GroupSection({ label, color, bots, onRefresh, defaultOpen = true }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className="space-y-3">
            <button
                onClick={() => setOpen((v) => !v)}
                className="flex items-center gap-2 w-full text-left group"
            >
                <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color || "#64748b" }} />
                <span className="text-sm font-semibold text-slate-300 group-hover:text-slate-100 transition-colors">
                    {label}
                </span>
                <span className="text-xs text-slate-600 ml-1">({bots.length})</span>
                <span className="ml-auto text-slate-600 text-xs" style={{ display: "inline-block", transform: open ? "rotate(0)" : "rotate(-90deg)", transition: "transform .2s" }}>▾</span>
            </button>
            {open && (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 pl-5 border-l-2" style={{ borderColor: color ? `${color}55` : "#334155" }}>
                    {bots.map((bot) => <BotCard key={bot._id} bot={bot} onRefresh={onRefresh} />)}
                </div>
            )}
        </div>
    );
}

export default function Dashboard() {
    const [bots, setBots] = useState([]);
    const [groups, setGroups] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showCreate, setShowCreate] = useState(false);
    const [showGroups, setShowGroups] = useState(false);
    const [search, setSearch] = useState("");
    const [filter, setFilter] = useState("all");

    const fetchAll = useCallback(async () => {
        try {
            const [botsRes, groupsRes] = await Promise.all([
                api.get("/bots"),
                api.get("/groups"),
            ]);
            setBots(botsRes.data);
            setGroups(groupsRes.data);
        } catch { /* axios interceptor handles 401 */ }
        finally { setLoading(false); }
    }, []);

    useEffect(() => {
        fetchAll();
        const interval = setInterval(fetchAll, 10_000);
        return () => clearInterval(interval);
    }, [fetchAll]);

    const online       = bots.filter((b) => b.live?.status === "online").length;
    const errored      = bots.filter((b) => b.live?.status === "errored").length;
    const expiringSoon = bots.filter((b) => {
        if (!b.expiresAt) return false;
        return (b.expiresAt - Date.now()) / 86_400_000 <= 3;
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
        <div className="p-6 space-y-6 max-w-7xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                    <h1 className="text-2xl font-bold text-slate-100">Dashboard</h1>
                    <p className="text-sm text-slate-500 mt-0.5">Manage all your hosted bots</p>
                </div>
                <div className="flex gap-2 flex-wrap">
                    <button className="btn-ghost text-sm" onClick={() => setShowGroups(true)}>🗂️ Groups</button>
                    <button className="btn-primary" onClick={() => setShowCreate(true)}>➕ New Bot</button>
                </div>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {[
                    { label: "Total Bots",    value: bots.length,   color: "text-indigo-400" },
                    { label: "Online",         value: online,        color: "text-emerald-400" },
                    { label: "Errored",        value: errored,       color: "text-orange-400" },
                    { label: "Expiring Soon",  value: expiringSoon,  color: "text-amber-400" },
                ].map(({ label, value, color }) => (
                    <div key={label} className="card">
                        <p className="text-xs text-slate-500 uppercase tracking-wider">{label}</p>
                        <p className={`text-3xl font-bold mt-1 ${color}`}>{value}</p>
                    </div>
                ))}
            </div>

            <StatsWidget />

            {/* Bot list */}
            <div>
                <div className="flex items-center gap-3 mb-4 flex-wrap">
                    <input className="input max-w-xs" placeholder="🔍 Search bots…" value={search} onChange={(e) => setSearch(e.target.value)} />
                    <div className="flex gap-2">
                        {["all", "online", "stopped"].map((f) => (
                            <button key={f}
                                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${filter === f ? "bg-indigo-600 text-white" : "bg-slate-700 text-slate-400 hover:text-slate-200"}`}
                                onClick={() => setFilter(f)}>
                                {f.charAt(0).toUpperCase() + f.slice(1)}
                            </button>
                        ))}
                    </div>
                    <span className="text-xs text-slate-500 ml-auto">{visible.length} / {bots.length} bots</span>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center h-40">
                        <div className="animate-spin h-8 w-8 border-4 border-indigo-500 border-t-transparent rounded-full" />
                    </div>
                ) : visible.length === 0 ? (
                    <div className="card text-center py-16 text-slate-500">
                        <div className="text-4xl mb-3">🤖</div>
                        <p className="font-medium">{bots.length === 0 ? 'No bots yet — click "New Bot" to get started.' : "No bots match your search."}</p>
                    </div>
                ) : isFiltering ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                        {visible.map((bot) => <BotCard key={bot._id} bot={bot} onRefresh={fetchAll} />)}
                    </div>
                ) : (
                    <div className="space-y-6">
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
