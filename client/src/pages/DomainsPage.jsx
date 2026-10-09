import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import api from "../api/client";
import { DataTable, EmptyState, Icon, PageHeader, StatusBadge } from "../components/ui";

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
        <div className="page fade-in" style={{ maxWidth: 900, display: "flex", flexDirection: "column", gap: 20 }}>
            <PageHeader title="Domains" description="All custom domains configured on your websites" />

            {loading ? (
                <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>
            ) : domains.length === 0 ? (
                <EmptyState
                    icon="globe"
                    title="No domains yet"
                    description="Create a website project and add a custom domain to see it here."
                    action={<button className="btn-primary" onClick={() => navigate("/sites")}>Go to Sites</button>}
                />
            ) : (
                <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                    <DataTable flush minWidth={640} columns={["Domain", "Project", "Port", "Mode", "SSL"]}>
                        {domains.map((d) => (
                            <tr key={d._id} className="row-click" onClick={() => navigate(`/sites/${d._id}`)}>
                                <td>
                                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                                        <Icon name="globe" style={{ color: "var(--text-dim)" }} />
                                        <span className="mono" style={{ fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                            {d.domain}
                                        </span>
                                    </div>
                                </td>
                                <td style={{ color: "var(--text-muted)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</td>
                                <td className="mono" style={{ color: "var(--text-dim)" }}>{d.port}</td>
                                <td className="nowrap" style={{ color: "var(--text-muted)" }}>{d.mode === "static" ? "Static" : "Full-stack"}</td>
                                <td>
                                    {d.sslEnabled
                                        ? <StatusBadge tone="success">Active</StatusBadge>
                                        : <StatusBadge tone="danger">None</StatusBadge>}
                                </td>
                            </tr>
                        ))}
                    </DataTable>
                </div>
            )}
        </div>
    );
}
