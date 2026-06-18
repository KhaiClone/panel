import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import api from "../api/client";

export default function DomainsPage() {
    const [domains, setDomains] = useState([]);
    const [loading, setLoading] = useState(true);
    const navigate = useNavigate();

    const fetch = () => {
        api.get("/bots/domains")
            .then(r => setDomains(r.data))
            .catch(() => {})
            .finally(() => setLoading(false));
    };

    useEffect(() => { fetch(); }, []);

    return (
        <div className="page fade-in" style={{ maxWidth: 900 }}>
            <div style={{ marginBottom: 28 }}>
                <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--text)", margin: "0 0 4px", letterSpacing: "-0.02em" }}>Domains</h1>
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>All custom domains configured on your websites</p>
            </div>

            {loading ? (
                <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>
            ) : domains.length === 0 ? (
                <div className="card" style={{ padding: 48, textAlign: "center" }}>
                    <p style={{ fontSize: 32, marginBottom: 12 }}>🌐</p>
                    <p style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>No domains yet</p>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 20 }}>Create a website project and add a custom domain to see it here.</p>
                    <button className="btn-primary" style={{ padding: "10px 24px" }} onClick={() => navigate("/dashboard")}>Go to Projects</button>
                </div>
            ) : (
                <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                    {/* Table header */}
                    <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr auto", gap: 16, padding: "12px 20px", borderBottom: "1px solid var(--border-light)", background: "var(--bg-input)" }}>
                        {["Domain", "Project", "Port", "Mode", "SSL"].map(h => (
                            <span key={h} style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{h}</span>
                        ))}
                    </div>

                    {domains.map((d, i) => (
                        <div
                            key={d._id}
                            onClick={() => navigate(`/bots/${d._id}`)}
                            style={{
                                display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr auto",
                                gap: 16, padding: "14px 20px", alignItems: "center",
                                borderBottom: i < domains.length - 1 ? "1px solid var(--border-light)" : "none",
                                cursor: "pointer", transition: "background 0.15s",
                            }}
                            onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
                            onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                        >
                            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                                <span style={{ fontSize: 15 }}>🌐</span>
                                <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {d.domain}
                                </span>
                            </div>
                            <span style={{ fontSize: 13, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
                            <span className="mono" style={{ fontSize: 13, color: "var(--text-dim)" }}>{d.port}</span>
                            <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 99, width: "fit-content",
                                background: d.mode === "static" ? "rgba(99,102,241,0.12)" : "rgba(245,158,11,0.1)",
                                color: d.mode === "static" ? "var(--accent-hover)" : "#fbbf24",
                                border: `1px solid ${d.mode === "static" ? "rgba(99,102,241,0.3)" : "rgba(245,158,11,0.25)"}`,
                                fontWeight: 600 }}>
                                {d.mode === "static" ? "Static" : "Full-Stack"}
                            </span>
                            {d.sslEnabled
                                ? <span style={{ fontSize: 12, padding: "3px 10px", borderRadius: 99, background: "rgba(34,197,94,0.12)", color: "#4ade80", border: "1px solid rgba(34,197,94,0.25)", fontWeight: 700, whiteSpace: "nowrap" }}>🔒 Active</span>
                                : <span style={{ fontSize: 12, padding: "3px 10px", borderRadius: 99, background: "rgba(239,68,68,0.1)", color: "var(--danger)", border: "1px solid rgba(239,68,68,0.2)", fontWeight: 700, whiteSpace: "nowrap" }}>⚠ None</span>
                            }
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
