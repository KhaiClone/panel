import { useCallback, useEffect, useState } from "react";
import api from "../../api/client";
import ConfirmModal from "../../components/ConfirmModal";
import TypeToConfirm from "../../components/TypeToConfirm";
import { EmptyState, Icon, Notice, StatusBadge } from "../../components/ui";

// Bots → Retired: what deleted / expired customer projects left behind
// (server/services/customerRetire.js). Webhooks and API keys went with the
// project; channels and the repo wait for the owner — the repo can be archived
// or deleted from here once the customers' GitHub org is set up
// (customerRepos.js). An entry leaves the list once every line is done.

const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const ROW = { display: "grid", gridTemplateColumns: "130px 1fr auto", gap: 12, alignItems: "center", padding: "10px 0", borderTop: "1px solid var(--border-light)" };
const KEY = { fontSize: 12, fontWeight: 500, color: "var(--text-muted)" };
const DIM = { fontSize: 12, color: "var(--text-dim)" };
const CHANNEL_LABEL = { log: "Log channel", backup: "Backup channel" };

function Row({ label, children, action }) {
    return (
        <div style={ROW}>
            <span style={KEY}>{label}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>{children}</span>
            {action || <span />}
        </div>
    );
}

function ChannelRow({ entry, kind, busy, onDelete }) {
    const ch = entry.channels[kind];
    if (!ch) return null;
    const link = ch.guildId && ch.channelId ? `https://discord.com/channels/${ch.guildId}/${ch.channelId}` : null;
    const due = kind === "backup" && entry.backupKeptUntil && Date.now() > entry.backupKeptUntil;
    const name = <span className="mono" style={{ overflowWrap: "anywhere" }}>#{ch.name || ch.channelId}</span>;
    return (
        <Row
            label={CHANNEL_LABEL[kind]}
            action={ch.status === "kept" && (
                <button type="button" className="btn-danger btn-sm" onClick={onDelete} disabled={busy}>
                    <Icon name="trash" size={14} /> Delete channel
                </button>
            )}
        >
            {ch.status === "kept" && link ? <a href={link} target="_blank" rel="noreferrer">{name}</a> : name}
            {ch.status === "kept" && <StatusBadge tone="warning">Kept</StatusBadge>}
            {ch.status === "deleted" && <StatusBadge tone="success">Deleted</StatusBadge>}
            {ch.status === "gone" && <StatusBadge tone="success">Deleted on Discord</StatusBadge>}
            {ch.status === "reused" && <StatusBadge tone="success">Reused by {ch.reusedBy || "a new project"}</StatusBadge>}
            {ch.status === "kept" && kind === "backup" && entry.backupKeptUntil && (
                <span style={{ fontSize: 12, color: due ? "var(--warning)" : "var(--text-dim)" }}>
                    {due ? `kept past ${fmtDate(entry.backupKeptUntil)} — time to decide` : `kept until ${fmtDate(entry.backupKeptUntil)}`}
                </span>
            )}
        </Row>
    );
}

export default function RetiredPanel({ onCount }) {
    const [list, setList] = useState(null);
    const [busy, setBusy] = useState(null); // `${entryId}:${action}`
    const [msg, setMsg] = useState(null);
    const [confirm, setConfirm] = useState(null); // { title, message, confirmText, danger, run }
    const [deleting, setDeleting] = useState(null); // the entry whose repo is being deleted
    const [github, setGithub] = useState(null); // { configured } — Archive / Delete the repo from here
    useEffect(() => {
        api.get("/customer-projects/github-settings").then((r) => setGithub(r.data)).catch(() => {});
    }, []);

    const load = useCallback(async () => {
        try {
            const { data } = await api.get("/customer-projects/retired");
            setList(data);
            onCount?.(data.length);
        } catch (err) {
            setMsg({ tone: "danger", text: err.response?.data?.error || "Failed to load the retired projects" });
            setList((l) => l || []);
        }
    }, [onCount]);
    useEffect(() => {
        load();
    }, [load]);

    const act = async (entry, action, call) => {
        setConfirm(null);
        setBusy(`${entry._id}:${action}`);
        setMsg(null);
        try {
            const { data } = await call();
            if (data?.finished) setMsg({ tone: "success", text: `Cleanup of "${entry.name}" is finished — it left the list.` });
            await load();
        } catch (err) {
            setMsg({ tone: "danger", text: err.response?.data?.error || "Something went wrong" });
        } finally {
            setBusy(null);
            setDeleting(null);
        }
    };
    const repoName = (url) => String(url || "").replace(/\.git\/?$/, "").split(/[/:]/).pop();

    const base = (e) => `/customer-projects/retired/${e._id}`;
    const deleteChannel = (e, kind) => {
        const ch = e.channels[kind];
        setConfirm({
            title: `Delete #${ch.name || ch.channelId}?`,
            message: kind === "backup"
                ? `The backup channel of "${e.name}" and every backup in it are deleted from Discord for good.`
                : `The log channel of "${e.name}" and its messages are deleted from Discord for good.`,
            confirmText: "Delete channel",
            danger: true,
            run: () => act(e, `channel-${kind}`, () => api.post(`${base(e)}/channels/${kind}/delete`)),
        });
    };
    const dismiss = (e) =>
        setConfirm({
            title: `Stop listing "${e.name}"?`,
            message: "Anything still listed — channels on Discord, the repo on GitHub — stays where it is. The panel just stops reminding you.",
            confirmText: "Stop listing",
            danger: false,
            run: () => act(e, "dismiss", () => api.delete(base(e))),
        });

    if (!list) return <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>Loading…</p>;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {confirm && (
                <ConfirmModal
                    title={confirm.title}
                    message={confirm.message}
                    confirmText={confirm.confirmText}
                    danger={confirm.danger}
                    onConfirm={confirm.run}
                    onCancel={() => setConfirm(null)}
                />
            )}
            {deleting && (
                <TypeToConfirm
                    title="Delete this repo?"
                    message={`${deleting.repo.url}, the repo of retired project "${deleting.name}", and everything in it are deleted from GitHub. GitHub usually lets an org owner restore it for 90 days; the panel cannot.`}
                    word={repoName(deleting.repo.url)}
                    confirmText="Delete repo"
                    busy={busy === `${deleting._id}:repo-delete`}
                    onConfirm={(typed) => act(deleting, "repo-delete", () => api.post(`${base(deleting)}/repo/delete`, { confirm: typed }))}
                    onCancel={() => setDeleting(null)}
                />
            )}
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                Customer projects that were deleted or removed after they expired. Their webhooks were deleted and their API keys revoked with them;
                channels and repos hold data, so they wait for you here. Personal and team projects are never listed.
            </p>
            {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

            {!list.length && (
                <EmptyState icon="archive" title="Nothing to clean up" description="When a customer project is deleted or expires, what it leaves behind shows up here." />
            )}

            {list.map((e) => {
                const isBusy = busy?.startsWith(`${e._id}:`);
                return (
                    <div key={e._id} className="card">
                        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
                            <span style={{ fontSize: 15, fontWeight: 600 }}>{e.name}</span>
                            <StatusBadge tone="neutral">{e.reason === "expired" ? "Expired" : "Deleted"}</StatusBadge>
                            <span style={DIM}>
                                {fmtDate(e.retiredAt)} · customer {e.buyerName ? `@${e.buyerName}` : ""} <span className="mono">{e.buyerID}</span>
                                {e.botUserId && <> · bot <span className="mono">{e.botUserId}</span></>}
                            </span>
                            <button type="button" className="btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={() => dismiss(e)} disabled={isBusy}>
                                Stop listing
                            </button>
                        </div>

                        <Row
                            label="Webhooks"
                            action={e.webhooks.status === "pending" && (
                                <button type="button" className="btn-ghost btn-sm" onClick={() => act(e, "webhooks", () => api.post(`${base(e)}/webhooks`))} disabled={isBusy}>
                                    <Icon name="refresh" size={14} /> Retry
                                </button>
                            )}
                        >
                            {e.webhooks.status === "deleted" && <StatusBadge tone="success">Deleted</StatusBadge>}
                            {e.webhooks.status === "none" && <span style={DIM}>None</span>}
                            {e.webhooks.status === "pending" && (
                                <>
                                    <StatusBadge tone="danger">Not deleted</StatusBadge>
                                    <span style={DIM}>{e.webhooks.error}</span>
                                </>
                            )}
                        </Row>

                        <Row
                            label="API keys"
                            action={e.apiKeys.status === "pending" && (
                                <button type="button" className="btn-ghost btn-sm" onClick={() => act(e, "keys", () => api.post(`${base(e)}/keys`))} disabled={isBusy}>
                                    <Icon name="refresh" size={14} /> Retry
                                </button>
                            )}
                        >
                            {e.apiKeys.status === "revoked" && <StatusBadge tone="success">Revoked ({e.apiKeys.count})</StatusBadge>}
                            {e.apiKeys.status === "none" && <span style={DIM}>None</span>}
                            {e.apiKeys.status === "pending" && (
                                <>
                                    <StatusBadge tone="danger">Not revoked</StatusBadge>
                                    <span style={DIM}>{e.apiKeys.error}</span>
                                </>
                            )}
                        </Row>

                        <ChannelRow entry={e} kind="log" busy={isBusy} onDelete={() => deleteChannel(e, "log")} />
                        <ChannelRow entry={e} kind="backup" busy={isBusy} onDelete={() => deleteChannel(e, "backup")} />

                        {e.repo.status !== "none" && (
                            <Row
                                label="Repository"
                                action={e.repo.status === "pending" && (
                                    <span style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                                        {github?.configured && (
                                            <>
                                                <button type="button" className="btn-ghost btn-sm" disabled={isBusy}
                                                    onClick={() => setConfirm({
                                                        title: "Archive this repo?",
                                                        message: `${e.repo.url} becomes read-only on GitHub (Unarchive undoes it on Bots → Repos).`,
                                                        confirmText: "Archive",
                                                        danger: false,
                                                        run: () => act(e, "repo-archive", () => api.post(`${base(e)}/repo/archive`)),
                                                    })}>
                                                    <Icon name="archive" size={14} /> Archive
                                                </button>
                                                <button type="button" className="btn-danger btn-sm" disabled={isBusy} onClick={() => setDeleting(e)}>
                                                    <Icon name="trash" size={14} /> Delete
                                                </button>
                                            </>
                                        )}
                                        <button type="button" className="btn-ghost btn-sm" onClick={() => act(e, "repo", () => api.post(`${base(e)}/repo`))} disabled={isBusy}>
                                            <Icon name="check" size={14} /> Mark as handled
                                        </button>
                                    </span>
                                )}
                            >
                                <span className="mono" style={{ fontSize: 12, overflowWrap: "anywhere" }}>{e.repo.url}</span>
                                {e.repo.status === "pending" && <StatusBadge tone="warning">To do</StatusBadge>}
                                {e.repo.status === "handled" && (
                                    <StatusBadge tone="success">{e.repo.result === "archived" ? "Archived" : e.repo.result === "deleted" ? "Deleted on GitHub" : "Handled"}</StatusBadge>
                                )}
                                {e.repo.status === "pending" && !github?.configured && <span style={DIM}>Archive or delete it on GitHub, then mark it handled.</span>}
                            </Row>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
