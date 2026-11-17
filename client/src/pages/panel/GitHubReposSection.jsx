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
                belong to retired projects, which nothing uses — with Archive and Delete — and makes new ones there with New repo. Personal repos
                stay on your own account and never show up. The panel only touches repos in this org; customer repos are named by the template
                below and renamed by the weekly name check when the names change.
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
            {data.configured && <RepoNaming />}
        </div>
    );
}

/**
 * The name template of the customer repos (server/services/customerRepoNames.js):
 * what New repo calls a repo and what the weekly check renames customer repos to.
 */
function RepoNaming() {
    const [data, setData] = useState(null);
    const [draft, setDraft] = useState(null); // the template while editing
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        api.get("/customer-projects/repo-naming").then((r) => setData(r.data)).catch((err) => setError(err.response?.data?.error || "Failed to load"));
    }, []);

    const save = async (template) => {
        setBusy(true);
        setError("");
        try {
            const { data: r } = await api.put("/customer-projects/repo-naming", { template });
            setData(r);
            setDraft(null);
            setSaved(true);
        } catch (err) {
            setError(err.response?.data?.error || "Save failed");
        } finally {
            setBusy(false);
        }
    };

    if (!data) return error ? <p style={{ fontSize: 12, color: "var(--danger)", margin: 0 }}>{error}</p> : null;

    return (
        <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Repo names</span>
                {draft === null && <span className="mono" style={{ fontSize: 13 }}>{data.template}</span>}
                {draft === null && (
                    <button className="btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={() => { setDraft(data.template); setSaved(false); }}>
                        <Icon name="pencil" size={14} /> Change
                    </button>
                )}
            </div>
            {draft !== null && (
                <>
                    <input className="input mono" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy} autoFocus />
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                        {draft !== data.defaultTemplate && (
                            <button className="btn-ghost btn-sm" style={{ marginRight: "auto" }} onClick={() => setDraft(data.defaultTemplate)} disabled={busy}>
                                Use the default ({data.defaultTemplate})
                            </button>
                        )}
                        <button className="btn-ghost btn-sm" onClick={() => setDraft(null)} disabled={busy}>Cancel</button>
                        <button className="btn-primary btn-sm" onClick={() => save(draft.trim())} disabled={busy || !draft.trim() || draft.trim() === data.template}>
                            {busy ? "Saving…" : "Save"}
                        </button>
                    </div>
                </>
            )}
            {error && <p style={{ fontSize: 12, color: "var(--danger)", margin: 0 }}>{error}</p>}
            {saved && <p style={{ fontSize: 12, color: "var(--success)", margin: 0 }}>Saved. Customer repos follow at the next name check — Bots → Repos shows each new name before it happens.</p>}
            <div style={{ ...DIM, display: "flex", flexDirection: "column", gap: 2 }}>
                {Object.entries(data.fields).map(([k, text]) => (
                    <span key={k}><span className="mono">{`{${k}}`}</span> — {text}{k === "botname" && " (no bot: the project's name)"}</span>
                ))}
                <span style={{ marginTop: 4 }}>
                    Names are lowercased, Vietnamese marks dropped and spaces turned into "-". Around the fields, use only letters, digits, ".", "_"
                    and "-". Checked every {data.schedule.day} at {data.schedule.at} (Vietnam time); a repo with a name of its own is never renamed.
                </span>
            </div>
        </div>
    );
}
