import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useData } from "../context/DataContext";
import { useAuth } from "../context/AuthContext";
import api from "../api/client";
import NodeFilter, { matchNode } from "../components/NodeFilter";

// ── Helpers ────────────────────────────────────────────────────────────────
const fmtBytes = (b) => {
    if (!b && b !== 0) return "—";
    if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(1)} GB`;
    if (b >= 1_048_576)     return `${(b / 1_048_576).toFixed(0)} MB`;
    if (b >= 1_024)         return `${(b / 1_024).toFixed(0)} KB`;
    return `${b} B/s`;
};
const clamp = (v) => Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 0), 100) : 0;

// ── Sub-components ─────────────────────────────────────────────────────────
function RingMeter({ percent, color, label, sub, size = 110 }) {
    const pct = clamp(percent);
    const r = (size / 2) - 10;
    const circ = 2 * Math.PI * r;
    const offset = circ - (pct / 100) * circ;

    return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <div style={{ position: "relative", width: size, height: size }}>
                <svg width={size} height={size} style={{ transform: "rotate(-90deg)", filter: `drop-shadow(0 0 8px ${color}40)` }}>
                    <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--bg-input)" strokeWidth="9" />
                    <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="9"
                        strokeLinecap="round"
                        style={{ strokeDasharray: circ, strokeDashoffset: offset, transition: "stroke-dashoffset 0.8s ease" }} />
                </svg>
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ fontSize: 22, fontWeight: 800, color: "var(--text)", lineHeight: 1 }}>{pct}<span style={{ fontSize: 12 }}>%</span></span>
                </div>
            </div>
            <div style={{ textAlign: "center" }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{label}</p>
                <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>{sub}</p>
            </div>
        </div>
    );
}

function StatCard({ icon, label, value, sub, color = "var(--accent)", onClick }) {
    return (
        <div className="card card-hover" onClick={onClick}
            style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 12, cursor: onClick ? "pointer" : "default", position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: -20, right: -10, width: 80, height: 80, background: color, opacity: 0.06, filter: "blur(20px)", borderRadius: "50%", pointerEvents: "none" }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</span>
                <span style={{ fontSize: 20, color }}>{icon}</span>
            </div>
            <p style={{ fontSize: 32, fontWeight: 800, color: "#fff", margin: 0, lineHeight: 1 }}>{value}</p>
            {sub && <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>{sub}</p>}
        </div>
    );
}

function DomainRow({ item }) {
    const navigate = useNavigate();
    return (
        <div
            onClick={() => navigate(`/bots/${item._id}`)}
            style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", borderBottom: "1px solid var(--border-light)", cursor: "pointer", transition: "background 0.15s" }}
            onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}
        >
            <span style={{ fontSize: 16 }}>🌐</span>
            <div style={{ flex: 1, minWidth: 0 }}>
                <p className="mono" style={{ margin: 0, fontSize: 13, color: "var(--text)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.domain}</p>
                <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)" }}>{item.name} · port {item.port}</p>
            </div>
            {item.sslEnabled
                ? <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: "rgba(34,197,94,0.12)", color: "#4ade80", border: "1px solid rgba(34,197,94,0.25)", fontWeight: 700 }}>🔒 SSL</span>
                : <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 99, background: "rgba(245,158,11,0.1)", color: "#fbbf24", border: "1px solid rgba(245,158,11,0.25)", fontWeight: 700 }}>HTTP</span>
            }
        </div>
    );
}

const TYPE_META = {
    discord: { icon: "🤖", label: "Discord Bot", color: "#5865F2" },
    website: { icon: "🌐", label: "Website",     color: "#22c55e" },
    service: { icon: "⚙️", label: "Service",     color: "#a78bfa" },
    default: { icon: "📦", label: "Instance",    color: "var(--accent)" },
};

// ── Page ───────────────────────────────────────────────────────────────────
export default function OverviewPage() {
    const { stats, bots: allBots } = useData();
    const { isAdmin } = useAuth();
    const [domains, setDomains] = useState([]);
    const [myInfo, setMyInfo] = useState(null); // slot + usage for regular users
    const [nodeFilter, setNodeFilter] = useState("all");
    const [nodes, setNodes] = useState([]); // admin: node list with live stats
    const navigate = useNavigate();

    // Node filter applies to every count/list on this page
    const bots = allBots.filter(b => matchNode(b, nodeFilter));

    useEffect(() => {
        api.get("/bots/domains").then(r => setDomains(r.data)).catch(() => {});
        if (!isAdmin) {
            api.get("/admin/users/me").then(r => setMyInfo(r.data)).catch(() => {});
        } else {
            const fetchNodes = () => api.get("/nodes").then(r => setNodes(r.data)).catch(() => {});
            fetchNodes();
            const int = setInterval(fetchNodes, 10_000);
            return () => clearInterval(int);
        }
    }, [isAdmin]);

    const online  = bots.filter(b => b.live?.status === "online").length;
    const stopped = bots.filter(b => b.live?.status !== "online").length;

    const byType = bots.reduce((acc, b) => {
        const t = b.projectType || "discord";
        acc[t] = (acc[t] || 0) + 1;
        return acc;
    }, {});

    // Resource rings follow the node filter: a specific remote node shows that
    // node's stats (from /api/nodes); "all"/"local" keep the panel VPS stats.
    const selectedNode = nodeFilter !== "all" && nodeFilter !== "local"
        ? nodes.find(n => n._id === nodeFilter)
        : null;
    const effStats = selectedNode ? selectedNode.stats : stats;

    const cpu  = effStats?.cpu;
    const mem  = effStats?.memory;
    const disk = effStats?.disk;
    const net  = effStats?.network;

    const cpuColor  = !cpu  ? "var(--accent)" : cpu.usagePercent  > 80 ? "var(--danger)" : cpu.usagePercent  > 50 ? "var(--warning)" : "var(--success)";
    const memColor  = !mem  ? "#60A5FA"       : mem.usedPercent   > 85 ? "var(--danger)" : mem.usedPercent   > 65 ? "var(--warning)" : "#60A5FA";
    const diskColor = !disk ? "#a78bfa"       : disk.usedPercent  > 90 ? "var(--danger)" : disk.usedPercent  > 75 ? "var(--warning)" : "#a78bfa";

    return (
        <div className="page fade-in" style={{ maxWidth: 1200 }}>

            {/* ── Page title ── */}
            <div className="mobile-wrap" style={{ marginBottom: 28, display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                <div>
                    <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--text)", margin: "0 0 4px", letterSpacing: "-0.02em" }}>Server Overview</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>Real-time health and resource summary of your VPS</p>
                </div>
                <NodeFilter bots={allBots} value={nodeFilter} onChange={setNodeFilter} />
            </div>

            {/* ── Slot info (regular users only) ── */}
            {!isAdmin && myInfo?.slot && (
                <div className="card" style={{ padding: "16px 20px", marginBottom: 20, borderLeft: "3px solid var(--accent)" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                        <div>
                            <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
                                Your Slot {myInfo.slot.label ? `— ${myInfo.slot.label}` : ""}
                            </p>
                            {myInfo.slot.expiresAt && (
                                <p style={{ margin: "3px 0 0", fontSize: 11, color: myInfo.slot.expiresAt < Date.now() ? "var(--danger)" : "var(--text-muted)" }}>
                                    {myInfo.slot.expiresAt < Date.now() ? "Expired" : `Expires ${new Date(myInfo.slot.expiresAt).toLocaleDateString()}`}
                                </p>
                            )}
                        </div>
                        <div className="mobile-wrap" style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                            {[
                                { label: "Bots", used: myInfo.usage?.bots || 0, max: myInfo.slot.maxBots },
                                { label: "Sites", used: myInfo.usage?.sites || 0, max: myInfo.slot.maxSites },
                            ].map(({ label, used, max }) => (
                                <div key={label} style={{ textAlign: "center" }}>
                                    <p style={{ margin: 0, fontSize: 18, fontWeight: 800, color: max !== null && used >= max ? "var(--danger)" : "var(--accent-hover)" }}>
                                        {used}<span style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 400 }}>/{max ?? "∞"}</span>
                                    </p>
                                    <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--text-dim)" }}>{label}</p>
                                </div>
                            ))}
                            {myInfo.slot.maxRamPerBot && (
                                <div style={{ textAlign: "center" }}>
                                    <p style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "var(--text)" }}>{myInfo.slot.maxRamPerBot}</p>
                                    <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--text-dim)" }}>RAM / bot</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
            {!isAdmin && !myInfo?.slot && myInfo && (
                <div className="card" style={{ padding: "12px 16px", marginBottom: 20, borderLeft: "3px solid var(--warning)" }}>
                    <p style={{ margin: 0, fontSize: 13, color: "var(--warning)" }}>No slot assigned to your account yet. Contact the administrator.</p>
                </div>
            )}

            {/* ── VPS Resource rings (admin only) ── */}
            {isAdmin && (
            <div className="card" style={{ padding: "28px 32px", marginBottom: 24 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
                    <h2 style={{ fontSize: 14, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", margin: 0 }}>
                        VPS Resources{selectedNode ? ` — ⬡ ${selectedNode.name}` : ""}
                    </h2>
                    {cpu?.model && <span style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "monospace" }}>{cpu.model}</span>}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 32, justifyItems: "center" }}>
                    <RingMeter percent={cpu?.usagePercent}  color={cpuColor}  label="CPU"  sub={cpu?.temperature ? `${cpu.temperature}°C` : "Usage"} />
                    <RingMeter percent={mem?.usedPercent}   color={memColor}  label="RAM"  sub={mem ? `${fmtBytes(mem.usedBytes)} / ${fmtBytes(mem.totalBytes)}` : "Memory"} />
                    <RingMeter percent={disk?.usedPercent}  color={diskColor} label="Disk" sub={disk ? `${fmtBytes(disk.usedBytes)} / ${fmtBytes(disk.totalBytes)}` : "Storage"} />

                    {/* Network card */}
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                        <div style={{ width: 110, height: 110, borderRadius: 16, background: "var(--bg-input)", border: "1px solid var(--border)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
                            <div style={{ textAlign: "center" }}>
                                <p style={{ margin: 0, fontSize: 11, color: "#34d399", fontWeight: 600 }}>↓ {net ? fmtBytes(net.rxBytesPerSec) + "/s" : "—"}</p>
                                <p style={{ margin: "4px 0 0", fontSize: 11, color: "#60a5fa", fontWeight: 600 }}>↑ {net ? fmtBytes(net.txBytesPerSec) + "/s" : "—"}</p>
                            </div>
                        </div>
                        <div style={{ textAlign: "center" }}>
                            <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Network</p>
                            <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>{net?.iface || "I/O"}</p>
                        </div>
                    </div>
                </div>
            </div>
            )}

            {/* ── Instance summary ── */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 24 }}>
                <StatCard icon="✅" label="Online"  value={online}       color="var(--success)" sub={`${stopped} stopped`} onClick={() => navigate("/bots")} />
                <StatCard icon="📦" label="Total"   value={bots.length}  color="var(--accent)"  sub="all projects"        onClick={() => navigate("/bots")} />
                <StatCard icon="🔗" label="Domains" value={domains.length} color="#a78bfa"      sub={`${domains.filter(d=>d.sslEnabled).length} with SSL`} onClick={() => navigate("/domains")} />
                {Object.entries(byType).map(([type, count]) => {
                    const m = TYPE_META[type] || TYPE_META.default;
                    return <StatCard key={type} icon={m.icon} label={m.label} value={count} color={m.color} sub="instances" onClick={() => navigate("/bots")} />;
                })}
            </div>

            {/* ── Bottom grid: recent projects + domains ── */}
            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>

                {/* Recent projects */}
                <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                    <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-light)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--text)" }}>Recent Projects</h3>
                        <button onClick={() => navigate("/bots")} className="btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }}>View all</button>
                    </div>
                    {bots.slice(0, 6).map(bot => {
                        const m = TYPE_META[bot.projectType || "discord"] || TYPE_META.default;
                        const isOnline = bot.live?.status === "online";
                        return (
                            <div key={bot._id} onClick={() => navigate(`/${bot.projectType === "website" ? "sites" : "bots"}/${bot._id}`)}
                                style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 20px", borderBottom: "1px solid var(--border-light)", cursor: "pointer", transition: "background 0.15s" }}
                                onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
                                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                            >
                                <span style={{ fontSize: 18 }}>{m.icon}</span>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bot.name}</p>
                                    <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)" }}>{bot.buyerID}</p>
                                </div>
                                <span style={{ width: 7, height: 7, borderRadius: "50%", background: isOnline ? "var(--success)" : "var(--danger)", flexShrink: 0 }} />
                            </div>
                        );
                    })}
                    {bots.length === 0 && (
                        <div style={{ padding: "32px 20px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>No projects yet</div>
                    )}
                </div>

                {/* Active domains */}
                <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                    <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-light)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--text)" }}>Active Domains</h3>
                        <button onClick={() => navigate("/domains")} className="btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }}>View all</button>
                    </div>
                    {domains.slice(0, 6).map(d => <DomainRow key={d._id} item={d} />)}
                    {domains.length === 0 && (
                        <div style={{ padding: "32px 20px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>No domains configured</div>
                    )}
                </div>
            </div>
        </div>
    );
}
