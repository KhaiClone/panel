// ─────────────────────────────────────────────────────────────────────────────
//  Panel Settings → Integrations → Customer repos (GitHub): the org that holds
//  the customers' repos and the token the panel uses for it
//  (server/services/customerRepos.js). The token never comes back here.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useState } from "react";
import api from "../../api/client";
import { Icon, StatusBadge } from "../../components/ui";

const DIM = { fontSize: 12, color: "var(--text-dim)" };

export default function GitHubReposSection() {
    const [data, setData] = useState(null);
    const [form, setForm] = useState(null); // { org, token } while editing
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(() => {
        api.get("/customer-projects/github-settings").then((r) => setData(r.data)).catch((err) => setError(err.response?.data?.error || "Failed to load"));
    }, []);
    useEffect(load, [load]);

    const save = async () => {
        setBusy(true);
        setError("");
        try {
            const { data: r } = await api.put("/customer-projects/github-settings", { org: form.org.trim(), token: form.token.trim() }, { timeout: 60_000 });
            setData(r);
            setForm(null);
        } catch (err) {
            setError(err.response?.data?.error || "Save failed");
        } finally {
            setBusy(false);
        }
    };

    if (!data) return <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>{error || "Loading…"}</p>;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                Keep the customers' repos in one GitHub organization and the panel lists them on Bots → Repos — which project uses each, which
                belong to retired projects, which nothing uses — with Archive and Delete. Personal repos stay on your own account and never show up.
                The panel only touches repos in this org and never renames one.
            </p>
            {error && <p style={{ fontSize: 12, color: "var(--danger)", margin: 0 }}>{error}</p>}

            {form ? (
                <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>Organization</span>
                        <input className="input mono" placeholder="my-org or https://github.com/my-org" value={form.org} onChange={(e) => setForm({ ...form, org: e.target.value })} disabled={busy} />
                        <span style={DIM}>
                            The name in the org's address — github.com/<b>name</b> — not the display name shown on its page (that one may have spaces).
                            Pasting the org's link works too.
                        </span>
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>Token {data.hasToken && "(leave empty to keep the current one)"}</span>
                        <input className="input mono" type="password" autoComplete="off" placeholder="github_pat_…" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} disabled={busy} />
                        <span style={DIM}>
                            A fine-grained personal access token with the organization as its resource owner, access to all its repositories,
                            and the repository permissions Metadata: read and Administration: read and write.{" "}
                            <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Create one on GitHub</a>.
                        </span>
                    </label>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                        <button className="btn-ghost btn-sm" onClick={() => setForm(null)} disabled={busy}>Cancel</button>
                        <button className="btn-primary btn-sm" onClick={save} disabled={busy || !form.org.trim() || (!data.hasToken && !form.token.trim())}>
                            {busy ? "Checking with GitHub…" : "Save"}
                        </button>
                    </div>
                </div>
            ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <StatusBadge tone={data.configured ? "success" : "neutral"}>{data.configured ? "Connected" : "Not set up"}</StatusBadge>
                    {data.org && <span className="mono" style={{ fontSize: 13 }}>{data.org}</span>}
                    {data.check?.at && <span style={DIM}>checked {new Date(data.check.at).toLocaleString("en-GB")}</span>}
                    <button className="btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={() => setForm({ org: data.org || "", token: "" })}>
                        <Icon name="pencil" size={14} /> {data.configured ? "Change" : "Set up"}
                    </button>
                </div>
            )}
        </div>
    );
}
