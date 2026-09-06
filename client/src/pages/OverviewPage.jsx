import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useData } from "../context/DataContext";
import { useAuth } from "../context/AuthContext";
import api from "../api/client";

// ── Helpers ────────────────────────────────────────────────────────────────
const TYPE_META = {
    discord: { icon: "🤖", label: "Discord Bot", color: "#5865F2" },
    website: { icon: "🌐", label: "Website",     color: "#22c55e" },
    service: { icon: "⚙️", label: "Service",     color: "#a78bfa" },
    default: { icon: "📦", label: "Instance",    color: "var(--accent)" },
};

// ── Page ───────────────────────────────────────────────────────────────────
export default function OverviewPage() {
    // Only regular users reach this page — admins are routed to /systems, which
    // covers machine health far better than a single ring ever did. What is left
    // here is what /systems cannot show: this user's own slot, quota and projects.
    const { bots } = useData();
    const { isAdmin } = useAuth();
    const [domains, setDomains] = useState([]);
    const [myInfo, setMyInfo] = useState(null); // slot + usage for regular users
    const navigate = useNavigate();

    useEffect(() => {
        api.get("/bots/domains").then(r => setDomains(r.data)).catch(() => {});
        if (!isAdmin) {
            api.get("/admin/users/me").then(r => setMyInfo(r.data)).catch(() => {});
        }
    }, [isAdmin]);

    const online  = bots.filter(b => b.live?.status === "online").length;
    const stopped = bots.filter(b => b.live?.status !== "online").length;

    const byType = bots.reduce((acc, b) => {
        const t = b.projectType || "discord";
        acc[t] = (acc[t] || 0) + 1;
        return acc;
    }, {});

    return (
        <div className="page fade-in" style={{ maxWidth: 1200 }}>

            {/* ── Page title ── */}
            <div className="mobile-wrap" style={{ marginBottom: 28, display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                <div>
                    <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--text)", margin: "0 0 4px", letterSpacing: "-0.02em" }}>Overview</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                        Your slot, your projects and their domains.
                    </p>
                </div>
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
