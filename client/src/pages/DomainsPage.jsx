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
                    <button className="btn-primary" style={{ padding: "10px 24px" }} onClick={() => navigate("/sites")}>Go to Sites</button>
                </div>
            ) : (
                <div className="card scroll-x" style={{ padding: 0, overflow: "auto" }}>
                    {/* Table header */}
                    <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr auto", gap: 16, padding: "12px 20px", borderBottom: "1px solid var(--border-light)", background: "var(--bg-input)", minWidth: 640 }}>
                        {["Domain", "Project", "Port", "Mode", "SSL"].map(h => (
                            <span key={h} style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{h}</span>
                        ))}
                    </div>

                    {domains.map((d, i) => (
                        <div
                            key={d._id}
                            onClick={() => navigate(`/sites/${d._id}`)}
                            style={{
                                display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr auto",
                                gap: 16, padding: "14px 20px", alignItems: "center",
                                borderBottom: i < domains.length - 1 ? "1px solid var(--border-light)" : "none",
                                cursor: "pointer", transition: "background 0.15s",
                                minWidth: 640,
                            }}
                            onMouseEnter={e => e.currentTarget.style.background = "var(--bg-hover)"}
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
                                background: d.mode === "static" ? "var(--accent-dim)" : "var(--warning-bg)",
                                color: d.mode === "static" ? "var(--accent-hover)" : "var(--warning)",
                                border: `1px solid ${d.mode === "static" ? "var(--accent-border)" : "var(--warning-border)"}`,
                                fontWeight: 600 }}>
                                {d.mode === "static" ? "Static" : "Full-Stack"}
                            </span>
                            {d.sslEnabled
                                ? <span style={{ fontSize: 12, padding: "3px 10px", borderRadius: 99, background: "var(--success-bg)", color: "var(--success)", border: "1px solid var(--success-border)", fontWeight: 700, whiteSpace: "nowrap" }}>🔒 Active</span>
                                : <span style={{ fontSize: 12, padding: "3px 10px", borderRadius: 99, background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid var(--danger-border)", fontWeight: 700, whiteSpace: "nowrap" }}>⚠ None</span>
                            }
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
