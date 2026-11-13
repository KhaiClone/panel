import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../../api/client";
import ConfirmModal from "../../components/ConfirmModal";
import TypeToConfirm from "../../components/TypeToConfirm";
import { EmptyState, Icon, Notice, StatusBadge } from "../../components/ui";

// Bots → Repos: the customers' GitHub org (server/services/customerRepos.js) —
// every repo with the project that uses it, or why nothing does. Archive is
// undone with Unarchive; Delete needs the name typed back and is refused while
// a project uses the repo. The panel never renames a repo.

const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const DIM = { fontSize: 12, color: "var(--text-dim)" };
const STATE = {
    "in-use": { tone: "success", label: "In use" },
    expired: { tone: "warning", label: "Project expired" },
    retired: { tone: "warning", label: "Retired project" },
    unused: { tone: "danger", label: "Not used" },
};
const FILTERS = [
    ["attention", "Needs a decision", (r) => !r.archived && (r.state === "unused" || r.state === "retired")],
    ["in-use", "In use", (r) => r.state === "in-use" || r.state === "expired"],
    ["archived", "Archived", (r) => r.archived],
    ["all", "All", () => true],
];
const projectPath = (p) => (p.projectType === "website" ? `/sites/${p._id}` : `/bots/${p._id}`);

export default function ReposPanel() {
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [filter, setFilter] = useState("attention");
    const [busy, setBusy] = useState(null);
    const [msg, setMsg] = useState(null);
    const [confirm, setConfirm] = useState(null); // archive / unarchive
    const [deleting, setDeleting] = useState(null); // repo being deleted

    const load = useCallback(async () => {
        setError("");
        try {
            const { data: r } = await api.get("/customer-projects/repos", { timeout: 120_000 });
            setData(r);
        } catch (err) {
            setError(err.response?.data?.error || "Failed to load the repos");
            setData((d) => d || { configured: true, repos: [], notInOrg: [] });
        }
    }, []);
    useEffect(() => {
        load();
    }, [load]);

    const counts = useMemo(() => Object.fromEntries(FILTERS.map(([id, , fn]) => [id, (data?.repos || []).filter(fn).length])), [data]);
    const shown = useMemo(() => (data?.repos || []).filter(FILTERS.find(([id]) => id === filter)[2]), [data, filter]);

    const act = async (name, call, okText) => {
        setBusy(name);
        setMsg(null);
        try {
            await call();
            setMsg({ tone: "success", text: okText });
            await load();
        } catch (err) {
            setMsg({ tone: "danger", text: err.response?.data?.error || "Something went wrong" });
        } finally {
            setBusy(null);
            setConfirm(null);
            setDeleting(null);
        }
    };

    if (!data) return <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>Loading the org's repos from GitHub…</p>;
    if (!data.configured) {
        return (
            <EmptyState
                icon="gitBranch"
                title="GitHub is not set up"
                description="Add the organization that holds the customers' repos, and a token for it, in Panel Settings → Integrations."
                action={<Link to="/panel-manage/integrations" className="btn-primary" style={{ textDecoration: "none" }}>Open Integrations</Link>}
            />
        );
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {confirm && (
                <ConfirmModal
                    title={confirm.archived ? `Archive ${confirm.repo.fullName}?` : `Unarchive ${confirm.repo.fullName}?`}
                    message={confirm.archived
                        ? "The repo becomes read-only on GitHub. It can still be cloned, and Unarchive undoes this."
                        : "The repo can be pushed to again."}
                    confirmText={confirm.archived ? "Archive" : "Unarchive"}
                    danger={false}
                    onConfirm={() => act(`archive-${confirm.repo.name}`, () => api.post(`/customer-projects/repos/${encodeURIComponent(confirm.repo.name)}/archive`, { archived: confirm.archived }),
                        `${confirm.archived ? "Archived" : "Unarchived"} ${confirm.repo.fullName}.`)}
                    onCancel={() => setConfirm(null)}
                />
            )}
            {deleting && (
                <TypeToConfirm
                    title={`Delete ${deleting.fullName}?`}
                    message={"The repo and everything in it are deleted from GitHub. GitHub usually lets an org owner restore a deleted repo for 90 days (Settings → Repositories → Deleted repositories); the panel cannot."}
                    word={deleting.name}
                    confirmText="Delete repo"
                    busy={busy === `delete-${deleting.name}`}
                    onConfirm={(typed) => act(`delete-${deleting.name}`, () => api.delete(`/customer-projects/repos/${encodeURIComponent(deleting.name)}`, { data: { confirm: typed } }), `Deleted ${deleting.fullName}.`)}
                    onCancel={() => setDeleting(null)}
                />
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {FILTERS.map(([id, label]) => (
                    <button key={id} type="button" className={`chip${filter === id ? " active" : ""}`} onClick={() => setFilter(id)}>
                        {label} <span style={{ color: "var(--text-dim)" }}>{counts[id]}</span>
                    </button>
                ))}
                <span style={{ ...DIM, marginLeft: "auto" }}>
                    <a href={`https://github.com/${data.org}`} target="_blank" rel="noreferrer" className="mono">{data.org}</a> · {data.repos.length} repos
                </span>
                <button type="button" className="btn-ghost btn-sm" onClick={load} disabled={!!busy}><Icon name="refresh" size={14} /> Refresh</button>
            </div>

            {error && <Notice tone="danger">{error}</Notice>}
            {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

            {data.notInOrg.length > 0 && (
                <div className="card">
                    <p style={{ fontSize: 13, fontWeight: 600, margin: "0 0 4px" }}>Customer projects whose repo URL is not in {data.org}</p>
                    <p style={{ ...DIM, margin: "0 0 8px" }}>
                        Transfer a customer's repo to the org on GitHub (Settings → Transfer ownership): the old URL keeps working, and Update repo URL points the project at the new one.
                    </p>
                    {data.notInOrg.map((p) => (
                        <div key={p._id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 0", borderTop: "1px solid var(--border-light)" }}>
                            <Link to={`/bots/${p._id}`} style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</Link>
                            <span className="mono" style={{ ...DIM, overflowWrap: "anywhere" }}>{p.repoUrl}</span>
                            {p.state === "moved" && <StatusBadge tone="warning">Moved to {p.movedTo}</StatusBadge>}
                            {p.state === "outside" && <StatusBadge tone="neutral">In another account</StatusBadge>}
                            {p.state === "unknown" && <StatusBadge tone="neutral">Not in the org yet</StatusBadge>}
                            {p.state === "moved" && (
                                <button type="button" className="btn-ghost btn-sm" style={{ marginLeft: "auto" }} disabled={!!busy}
                                    onClick={() => act(`url-${p._id}`, () => api.post(`/customer-projects/${p._id}/repo/update-url`), `"${p.name}" now points to ${p.movedTo}.`)}>
                                    Update repo URL
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {!shown.length ? (
                <EmptyState icon="gitBranch" title={filter === "attention" ? "Nothing to decide" : "No repos here"}
                    description={filter === "attention" ? "Every repo in the org is used by a project or archived." : "No repo of the org matches this filter."} />
            ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {shown.map((r) => {
                        const s = STATE[r.state];
                        const inUse = r.state === "in-use" || r.state === "expired";
                        return (
                            <div key={r.id} className="card" style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                                <div style={{ flex: "1 1 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                                    <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                        <a href={r.url} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 13, fontWeight: 600, overflowWrap: "anywhere" }}>{r.name}</a>
                                        <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
                                        {!r.private && <StatusBadge tone="neutral">Public</StatusBadge>}
                                        {r.archived && <StatusBadge tone="neutral">Archived</StatusBadge>}
                                    </span>
                                    <span style={DIM}>
                                        {r.projects.length > 0 && <>Used by {r.projects.map((p, i) => <span key={p._id}>{i > 0 && ", "}<Link to={projectPath(p)}>{p.name}</Link></span>)} · </>}
                                        {r.retired && <>Retired project "{r.retired.name}" ({fmtDate(r.retired.retiredAt)}) · </>}
                                        last push {fmtDate(r.pushedAt)}
                                        {r.description && <> · {r.description}</>}
                                    </span>
                                </div>
                                <div style={{ display: "flex", gap: 8 }}>
                                    <button type="button" className="btn-ghost btn-sm" disabled={!!busy} onClick={() => setConfirm({ repo: r, archived: !r.archived })}>
                                        <Icon name="archive" size={14} /> {r.archived ? "Unarchive" : "Archive"}
                                    </button>
                                    <button type="button" className="btn-danger btn-sm" disabled={!!busy || inUse} title={inUse ? "A project still uses this repo — delete the project first" : undefined}
                                        onClick={() => setDeleting(r)}>
                                        <Icon name="trash" size={14} /> Delete
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
