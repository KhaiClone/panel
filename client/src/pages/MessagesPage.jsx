import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../api/client";
import { usePageAccess } from "../context/AuthContext";
import ConfirmModal from "../components/ConfirmModal";
import MessageEditor from "../components/messages/MessageEditor";
import { MessagePreview } from "../components/messages/DiscordPreview";
import { emptyDraft, fromJson, isEmptyDraft, onlyLinkButtons, pingsOf, snippet, toApi, toEditor } from "../components/messages/format";
import { DataTable, EmptyState, Field, Icon, Modal, Notice, PageHeader, StatusBadge } from "../components/ui";

// ─────────────────────────────────────────────────────────────────────────────
//  Messages — write a message Discohook-style, pick a channel, and
//  ArnTo-assistant posts it as itself, pinging roles / @everyone if you let it.
//
//  The channel picker and role list come from the panel's server map, which
//  the panel loads from the bot once a day — or with Reload, at most once every
//  10 minutes for everyone — so opening the page never asks the bot. The panel
//  checks the message against Discord's limits and asks the bot to post it. Sent keeps what went out (edit / copy / delete
//  later); Saved keeps messages to reuse. The logic is in
//  server/services/botMessages.js, the bot's side in ArnTo-assistant
//  functions/botMessage.js.
// ─────────────────────────────────────────────────────────────────────────────

const STORE = "messages.compose.v1";
const SLOW = { timeout: 45_000 }; // the bus answers within 30 s, or the server says so
const errMsg = (err, fallback) => err?.response?.data?.error || err?.message || fallback;
const ago = (ts) => {
    const min = Math.max(0, Math.round((Date.now() - ts) / 60_000));
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "—");
const defaultOptions = () => ({ guildId: null, channelId: null, mentions: { everyone: true, roles: true, users: true }, silent: false, publish: false });

const readStore = () => {
    try {
        return JSON.parse(localStorage.getItem(STORE) || "null");
    } catch {
        return null;
    }
};
const writeStore = (v) => {
    try {
        localStorage.setItem(STORE, JSON.stringify(v));
    } catch {
        /* private window, full storage — the draft just is not kept */
    }
};

const STATUS = {
    pending: { text: "Waiting for the bot", tone: "warning" },
    sent: { text: "Sent", tone: "success" },
    failed: { text: "Failed", tone: "danger" },
    deleted: { text: "Deleted", tone: "neutral" },
};

const byText = (a) => (a ? (a.kind === "staff" ? a.tag || a.id : "Owner") : "—");

/** Only the link buttons of a message's rows (the rest run the bot's own features). */
const linkRowsOnly = (rows) =>
    (rows || [])
        .map((r) => ({ type: 1, components: (r.components || []).filter((c) => c.type === 2 && c.style === 5 && c.url) }))
        .filter((r) => r.components.length);

// ── Send box ─────────────────────────────────────────────────────────────────

function ChannelSelect({ guild, value, onChange, disabled }) {
    const groups = useMemo(() => {
        const out = [];
        for (const c of guild?.channels || []) {
            const key = c.parentId || "";
            let g = out.find((x) => x.key === key);
            if (!g) out.push((g = { key, name: c.parent || "No category", list: [] }));
            g.list.push(c);
        }
        return out;
    }, [guild]);
    return (
        <select className="input" value={guild?.channels?.some((c) => c.id === value) ? value : ""} disabled={disabled || !guild} onChange={(e) => onChange(e.target.value || null)}>
            <option value="">Pick a channel…</option>
            {groups.map((g) => (
                <optgroup key={g.key} label={g.name}>
                    {g.list.map((c) => (
                        <option key={c.id} value={c.id} disabled={!c.perms?.send}>
                            {c.type === "announcement" ? "📢" : "#"} {c.name}
                            {!c.perms?.send ? " — the bot cannot post here" : ""}
                        </option>
                    ))}
                </optgroup>
            ))}
        </select>
    );
}

/** What the message pings and what will not work, for the chosen channel. */
function pingReport({ draft, options, guild, channel, editing }) {
    const p = pingsOf(draft.content);
    const roles = new Map((guild?.roles || []).map((r) => [r.id, r]));
    const canEveryone = !!channel?.perms?.mentionEveryone;
    const chips = [];
    const warnings = [];
    const notes = [];
    const m = options.mentions;
    for (const [hit, word] of [
        [p.everyone, "@everyone"],
        [p.here, "@here"],
    ]) {
        if (!hit) continue;
        if (!m.everyone) notes.push(`${word} is in the text but its ping is off — it shows as plain text.`);
        else if (channel && !canEveryone) warnings.push(`${word} will not ping: the bot lacks "Mention @everyone" in #${channel.name}.`);
        else chips.push(word);
    }
    for (const id of p.roles) {
        const r = roles.get(id);
        if (!r) {
            warnings.push(`<@&${id}> is not a role of ${guild?.name || "this server"}.`);
            continue;
        }
        if (!m.roles) notes.push(`@${r.name} is in the text but role pings are off.`);
        else if (channel && !r.mentionable && !canEveryone) warnings.push(`@${r.name} will not ping: it is not mentionable and the bot lacks "Mention @everyone" in #${channel.name}.`);
        else chips.push(`@${r.name}`);
    }
    if (p.users.length) {
        if (!m.users) notes.push("Member mentions are in the text but their pings are off.");
        else chips.push(`${p.users.length} member${p.users.length === 1 ? "" : "s"}`);
    }
    if (options.silent && chips.length) notes.push("Silent: the pings are still highlighted, but nobody gets a notification.");
    // An edit pings nobody, so what would or would not ping does not matter there.
    if (editing) warnings.length = notes.length = 0;
    if (channel && (draft.embeds || []).length && !channel.perms?.embed) warnings.push(`The bot lacks "Embed Links" in #${channel.name} — the bot will refuse to post the embeds.`);
    return { chips, warnings, notes, pingsSomeone: chips.length > 0 && !options.silent, loud: chips.some((c) => c === "@everyone" || c === "@here") && !options.silent };
}

/** "Loaded 3 h ago · Reload" — Reload waits 10 minutes after the last load, whoever did it. */
function MapLine({ targets, loading, onReload, canReload }) {
    // Re-draw now and then so the countdown and "loaded … ago" move on.
    const [, setTick] = useState(0);
    useEffect(() => {
        const t = setInterval(() => setTick((n) => n + 1), 20_000);
        return () => clearInterval(t);
    }, []);
    const wait = targets?.reloadAt ? Math.ceil((targets.reloadAt - Date.now()) / 60_000) : 0;
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-dim)" }}>
            <span style={{ flex: 1 }}>{targets?.loadedAt ? `Channels loaded ${ago(targets.loadedAt)} · reloaded daily` : "Channels not loaded yet"}</span>
            {canReload && (
                <button
                    className="btn-ghost btn-sm"
                    onClick={onReload}
                    disabled={loading || wait > 0}
                    title={wait > 0 ? "The list can be reloaded once every 10 minutes" : "Ask the bot for the servers, channels and roles now"}
                >
                    <Icon name="refresh" size={14} /> {loading ? "Loading…" : wait > 0 ? `Reload in ${wait} min` : "Reload"}
                </button>
            )}
        </div>
    );
}

function SendBox({ status, targets, targetsError, loadingTargets, onReload, draft, options, setOptions, editing, onStopEditing, onSend, onSaveEdit, onDeleteEditing, busy, result, canEdit }) {
    const guilds = targets?.guilds || [];
    const guildId = editing ? editing.guildId : options.guildId;
    const guild = guilds.find((g) => g.id === guildId) || null;
    const channelId = editing ? editing.channelId : options.channelId;
    const channel = guild?.channels?.find((c) => c.id === channelId) || null;
    const report = pingReport({ draft, options, guild, channel, editing: !!editing });
    const setMention = (k, v) => setOptions({ ...options, mentions: { ...options.mentions, [k]: v } });
    const empty = isEmptyDraft(draft);

    return (
        <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0, flex: 1 }}>{editing ? "Editing a sent message" : "Send to"}</h2>
            </div>
            <MapLine targets={targets} loading={loadingTargets || targets?.loading} onReload={onReload} canReload={canEdit && !!status?.can?.targets} />

            {targetsError && <Notice tone="danger">{targetsError}</Notice>}
            {targets?.viewer && !targets.viewer.found && <Notice tone="danger">{targets.viewer.why || "You cannot post from here."}</Notice>}
            {targets && !targets.viewer && !targets.loadedAt && <Notice>The channel list has not been loaded yet — press Reload.</Notice>}

            {editing ? (
                <div className="msg-editing">
                    <Icon name="pencil" size={14} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                        #{editing.channelName || editing.channelId}
                        {editing.guildName ? ` · ${editing.guildName}` : ""}
                        {editing.url && (
                            <>
                                {" · "}
                                <a href={editing.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent-hover)" }}>
                                    open ↗
                                </a>
                            </>
                        )}
                    </span>
                    <button className="btn-ghost btn-sm" onClick={onStopEditing}>Stop editing</button>
                </div>
            ) : (
                <>
                    {guilds.length > 1 && (
                        <Field label="Server">
                            <select className="input" value={options.guildId || ""} onChange={(e) => setOptions({ ...options, guildId: e.target.value || null, channelId: null })}>
                                {guilds.map((g) => (
                                    <option key={g.id} value={g.id}>
                                        {g.name}
                                        {g.bus ? " (the panel's bus server)" : ""}
                                    </option>
                                ))}
                            </select>
                        </Field>
                    )}
                    <Field
                        label={guilds.length === 1 ? `Channel in ${guilds[0].name}` : "Channel"}
                        hint={targets?.viewer?.found ? "Only the channels where your own Discord account can see and send messages. A channel you just got shows after the next load (daily, or Reload)." : undefined}
                    >
                        <ChannelSelect guild={guild} value={options.channelId} onChange={(id) => setOptions({ ...options, channelId: id, publish: false })} disabled={!canEdit} />
                    </Field>
                </>
            )}

            {editing ? (
                <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>
                    Saving an edit pings nobody — Discord only notifies when a message is first posted. To ping again, send it as a new message (Stop editing).
                </div>
            ) : (
                <div className="msg-pings">
                    <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>Who may be pinged</span>
                    <label>
                        <input type="checkbox" checked={options.mentions.everyone} onChange={(e) => setMention("everyone", e.target.checked)} /> @everyone and @here
                    </label>
                    <label>
                        <input type="checkbox" checked={options.mentions.roles} onChange={(e) => setMention("roles", e.target.checked)} /> Roles
                    </label>
                    <label>
                        <input type="checkbox" checked={options.mentions.users} onChange={(e) => setMention("users", e.target.checked)} /> Members
                    </label>
                    <label title="The message arrives without a notification sound or badge (Discord's @silent)">
                        <input type="checkbox" checked={options.silent} onChange={(e) => setOptions({ ...options, silent: e.target.checked })} /> Silent — no notifications
                    </label>
                    {channel?.type === "announcement" && (
                        <label title="Also send it to the servers that follow this announcement channel">
                            <input type="checkbox" checked={options.publish} onChange={(e) => setOptions({ ...options, publish: e.target.checked })} /> Publish to following servers
                        </label>
                    )}
                </div>
            )}

            {report.chips.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 12, color: "var(--text-muted)" }}>
                    {editing ? "Mentions:" : options.silent ? "Mentions (silent):" : "Pings:"}
                    {report.chips.map((c) => (
                        <span key={c} className="msg-ping-chip">{c}</span>
                    ))}
                </div>
            )}
            {report.warnings.map((w) => (
                <Notice key={w}>{w}</Notice>
            ))}
            {report.notes.map((n) => (
                <div key={n} style={{ fontSize: 12, color: "var(--text-dim)" }}>{n}</div>
            ))}

            {canEdit &&
                (editing ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button className="btn-primary" style={{ flex: 1 }} disabled={busy || empty} onClick={onSaveEdit}>
                            <Icon name="check" /> {busy === "edit" ? "Saving…" : "Save changes"}
                        </button>
                        <button className="btn-ghost is-danger" disabled={busy} onClick={onDeleteEditing} title="Delete this message on Discord">
                            <Icon name="trash" />
                        </button>
                    </div>
                ) : (
                    <button className="btn-primary" disabled={busy || empty || !channel || !channel.perms?.send || !status?.can?.send} onClick={() => onSend(report, channel)}>
                        <Icon name="send" /> {busy === "send" ? "Sending…" : channel ? `Send to #${channel.name}` : "Send"}
                    </button>
                ))}

            {result && (
                <Notice tone={result.tone}>
                    {result.text}
                    {result.url && (
                        <>
                            {" "}
                            <a href={result.url} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>
                                Open in Discord
                            </a>
                        </>
                    )}
                    {result.warnings?.length > 0 && (
                        <ul style={{ margin: "6px 0 0 16px", padding: 0, listStyle: "disc" }}>
                            {result.warnings.map((w) => (
                                <li key={w}>{w}</li>
                            ))}
                        </ul>
                    )}
                    {result.onEdit && (
                        <div style={{ marginTop: 6 }}>
                            <button className="btn-ghost btn-sm" onClick={result.onEdit}>
                                <Icon name="pencil" size={13} /> Edit it
                            </button>
                        </div>
                    )}
                </Notice>
            )}
        </div>
    );
}

// ── Modals ───────────────────────────────────────────────────────────────────

function LinkModal({ onClose, onEdit, onCopy, canEdit }) {
    const [link, setLink] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [res, setRes] = useState(null);
    const look = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        setRes(null);
        try {
            const { data } = await api.get("/messages/fetch", { params: { link }, ...SLOW });
            setRes(data);
        } catch (err) {
            setError(errMsg(err, "Could not read that message"));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Modal title="Open a message by its link" onClose={onClose} width={520}>
            <form onSubmit={look} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Field label="Message link" hint="On Discord: right-click the message (or ⋯) → Copy Message Link. The bot must be able to see that channel.">
                    <input className="input mono" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://discord.com/channels/…/…/…" autoFocus />
                </Field>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button type="submit" className="btn-primary" disabled={busy || !link.trim()}>
                        {busy ? "Reading…" : "Read message"}
                    </button>
                </div>
            </form>
            {error && <div style={{ marginTop: 12 }}><Notice tone="danger">{error}</Notice></div>}
            {res && (
                <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
                        In <strong>#{res.channelName}</strong> ({res.guildName}) by <strong>{res.author?.tag || "?"}</strong>, {fmtDate(res.createdAt)}
                        {res.sent && " · listed under Sent"}
                    </div>
                    {res.v2 ? (
                        <Notice tone="danger">This message uses Discord's newer layout (Components V2), which this editor cannot open.</Notice>
                    ) : (
                        <>
                            {!res.own && <Notice>It was not posted by the bot, so it can only be copied into the editor and sent as a new message.</Notice>}
                            {res.own && res.keepsComponents && <Notice>Its buttons or menus run the bot's own features: editing keeps them as they are. A copy leaves them out.</Notice>}
                            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                                <button className="btn-ghost" onClick={() => onCopy(res)}>
                                    <Icon name="copy" /> Copy into the editor
                                </button>
                                {res.own && canEdit && (
                                    <button className="btn-primary" onClick={() => onEdit(res)}>
                                        <Icon name="pencil" /> Edit this message
                                    </button>
                                )}
                            </div>
                        </>
                    )}
                </div>
            )}
        </Modal>
    );
}

function JsonModal({ draft, onClose, onApply }) {
    const [text, setText] = useState(() => JSON.stringify(toApi(draft), null, 2));
    const [error, setError] = useState("");
    const [copied, setCopied] = useState(false);
    const apply = () => {
        try {
            onApply(fromJson(text));
        } catch (err) {
            setError(err.message);
        }
    };
    return (
        <Modal title="Message JSON" onClose={onClose} width={680}>
            <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "0 0 10px", lineHeight: 1.5 }}>
                Discord's own format — the same as Discohook's JSON editor. Paste one here (a message, a Discohook backup or an embed) and press Apply, or copy this one out.
            </p>
            <textarea
                className="input mono"
                value={text}
                onChange={(e) => {
                    setText(e.target.value);
                    setError("");
                }}
                spellCheck={false}
                style={{ width: "100%", minHeight: 340, fontSize: 12, lineHeight: 1.5, resize: "vertical" }}
            />
            {error && <div style={{ marginTop: 10 }}><Notice tone="danger">{error}</Notice></div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                <button
                    className="btn-ghost"
                    onClick={() => {
                        navigator.clipboard?.writeText(text).then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                        });
                    }}
                >
                    <Icon name="copy" /> {copied ? "Copied" : "Copy"}
                </button>
                <button className="btn-primary" onClick={apply}>
                    Apply
                </button>
            </div>
        </Modal>
    );
}

function SaveModal({ current, onClose, onSave, busy }) {
    const [name, setName] = useState(current?.name || "");
    return (
        <Modal title={current ? "Save message" : "Save as a new message"} onClose={onClose} width={420}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    onSave(name.trim(), false);
                }}
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
                <Field label="Name" hint="The message, the channel and the ping settings are saved together.">
                    <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="Weekly announcement" autoFocus />
                </Field>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                    {current && (
                        <button type="button" className="btn-ghost" disabled={busy || !name.trim()} onClick={() => onSave(name.trim(), true)}>
                            Save as new
                        </button>
                    )}
                    <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
                        {busy ? "Saving…" : current ? `Update "${current.name}"` : "Save"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

// ── Sent / Saved ─────────────────────────────────────────────────────────────

function SentTab({ rows, loading, error, canEdit, busy, onEdit, onCopy, onDelete, onForget }) {
    if (loading) return <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>;
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {error && <Notice tone="danger">{error}</Notice>}
            {!rows.length ? (
                <EmptyState icon="send" title="Nothing sent yet" description="Messages sent from this page, and messages edited here by their link, are listed here." />
            ) : (
                <DataTable minWidth={860} columns={["Sent", "Where", "Message", "By", "Status", ""]}>
                    {rows.map((r) => {
                        const s = STATUS[r.status] || STATUS.sent;
                        return (
                            <tr key={r.id}>
                                <td className="nowrap top muted">
                                    {fmtDate(r.sentAt)}
                                    {r.editedAt && <div className="cell-sub">edited {fmtDate(r.editedAt)}</div>}
                                </td>
                                <td className="nowrap top">
                                    <div>#{r.channelName || r.channelId}</div>
                                    <div className="cell-sub">{r.guildName || ""}</div>
                                </td>
                                <td className="top" style={{ maxWidth: 340, fontSize: 12, wordBreak: "break-word" }}>{snippet(r.message, 120)}</td>
                                <td className="nowrap top">
                                    {byText(r.sentBy)}
                                    {r.editedBy && <div className="cell-sub">edit: {byText(r.editedBy)}</div>}
                                </td>
                                <td className="top">
                                    <StatusBadge tone={s.tone}>{s.text}</StatusBadge>
                                    {r.error && r.status === "failed" && <div className="cell-sub" style={{ maxWidth: 220, whiteSpace: "normal", color: "var(--danger)" }}>{r.error}</div>}
                                    {r.status === "deleted" && <div className="cell-sub">by {byText(r.deletedBy)}</div>}
                                </td>
                                <td className="actions top">
                                    <div className="row-actions">
                                        {r.url && r.status === "sent" && (
                                            <a className="btn-ghost btn-sm" href={r.url} target="_blank" rel="noreferrer" title="Open in Discord">
                                                <Icon name="externalLink" size={13} />
                                            </a>
                                        )}
                                        {canEdit && r.status === "sent" && r.url && (
                                            <button className="btn-ghost btn-sm" disabled={busy === r.id} onClick={() => onEdit(r)} title="Edit this message on Discord">
                                                <Icon name="pencil" size={13} /> Edit
                                            </button>
                                        )}
                                        <button className="btn-ghost btn-sm" onClick={() => onCopy(r)} title="Copy into the editor as a new message">
                                            <Icon name="copy" size={13} />
                                        </button>
                                        {canEdit && r.status === "sent" && r.url && (
                                            <button className="btn-ghost btn-sm is-danger" disabled={busy === r.id} onClick={() => onDelete(r)} title="Delete on Discord">
                                                <Icon name="trash" size={13} />
                                            </button>
                                        )}
                                        {canEdit && r.status !== "sent" && r.status !== "pending" && (
                                            <button className="btn-ghost btn-sm" onClick={() => onForget(r)} title="Remove from this list">
                                                <Icon name="x" size={13} />
                                            </button>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        );
                    })}
                </DataTable>
            )}
        </div>
    );
}

function SavedTab({ drafts, loading, error, canEdit, currentId, onLoad, onDelete }) {
    if (loading) return <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>;
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {error && <Notice tone="danger">{error}</Notice>}
            {!drafts.length ? (
                <EmptyState icon="archive" title="No saved messages" description="Save a message from the editor to reuse it later — an announcement you post every week, a rules post…" />
            ) : (
                <DataTable minWidth={720} columns={["Name", "Message", "Updated", ""]}>
                    {drafts.map((d) => (
                        <tr key={d.id}>
                            <td className="top" style={{ fontWeight: 500 }}>
                                {d.name}
                                {d.id === currentId && <div className="cell-sub">open in the editor</div>}
                            </td>
                            <td className="top" style={{ maxWidth: 380, fontSize: 12, wordBreak: "break-word" }}>{snippet(toApi(d.message || {}), 120)}</td>
                            <td className="nowrap top muted">
                                {fmtDate(d.updatedAt)}
                                <div className="cell-sub">{byText(d.updatedBy)}</div>
                            </td>
                            <td className="actions top">
                                <div className="row-actions">
                                    <button className="btn-ghost btn-sm" onClick={() => onLoad(d)}>
                                        Open
                                    </button>
                                    {canEdit && (
                                        <button className="btn-ghost btn-sm is-danger" onClick={() => onDelete(d)} title="Delete">
                                            <Icon name="trash" size={13} />
                                        </button>
                                    )}
                                </div>
                            </td>
                        </tr>
                    ))}
                </DataTable>
            )}
        </div>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function MessagesPage() {
    const { canEdit } = usePageAccess("messages");
    const stored = useMemo(readStore, []);
    const [tab, setTab] = useState("compose");
    const [status, setStatus] = useState(null);
    const [statusError, setStatusError] = useState("");
    const [targets, setTargets] = useState(null);
    const [targetsError, setTargetsError] = useState("");
    const [loadingTargets, setLoadingTargets] = useState(false);

    const [draft, setDraft] = useState(() => stored?.draft || emptyDraft());
    const [options, setOptions] = useState(() => ({ ...defaultOptions(), ...(stored?.options || {}) }));
    const [editing, setEditing] = useState(() => stored?.editing || null);
    const [savedRef, setSavedRef] = useState(() => stored?.savedRef || null); // { id, name } of the saved message in the editor
    const [editorKey, setEditorKey] = useState(0);
    const [busy, setBusy] = useState(null);
    const [result, setResult] = useState(null);

    const [sent, setSent] = useState([]);
    const [sentLoading, setSentLoading] = useState(true);
    const [sentError, setSentError] = useState("");
    const [drafts, setDrafts] = useState([]);
    const [draftsLoading, setDraftsLoading] = useState(true);
    const [draftsError, setDraftsError] = useState("");

    const [modal, setModal] = useState(null); // "link" | "json" | "save"
    const [confirm, setConfirm] = useState(null); // { title, message, confirmText, danger, run }

    useEffect(() => writeStore({ draft, options, editing, savedRef }), [draft, options, editing, savedRef]);

    // ── Loading ──
    const loadStatus = useCallback(async () => {
        try {
            const { data } = await api.get("/messages/status");
            setStatus(data);
            setStatusError("");
            return data;
        } catch (err) {
            setStatusError(errMsg(err, "Could not load the page"));
            return null;
        }
    }, []);

    // The panel's copy of the server map — no round trip to the bot.
    const loadTargets = useCallback(async () => {
        try {
            const { data } = await api.get("/messages/targets");
            setTargets(data);
            setTargetsError("");
        } catch (err) {
            setTargetsError(errMsg(err, "Could not read the channel list"));
        }
    }, []);

    /** Reload: the panel asks the bot now (refused within 10 minutes of the last load). */
    const reloadTargets = async () => {
        setLoadingTargets(true);
        try {
            const { data } = await api.post("/messages/targets/reload", null, SLOW);
            setTargets(data);
            setTargetsError("");
        } catch (err) {
            setTargetsError(errMsg(err, "Could not reload the channel list"));
            loadTargets();
        } finally {
            setLoadingTargets(false);
        }
    };

    const loadSent = useCallback(async () => {
        try {
            const { data } = await api.get("/messages/sent");
            setSent(data.sent || []);
            setSentError("");
        } catch (err) {
            setSentError(errMsg(err, "Could not load what was sent"));
        } finally {
            setSentLoading(false);
        }
    }, []);

    const loadDrafts = useCallback(async () => {
        try {
            const { data } = await api.get("/messages/drafts");
            setDrafts(data.drafts || []);
            setDraftsError("");
        } catch (err) {
            setDraftsError(errMsg(err, "Could not load the saved messages"));
        } finally {
            setDraftsLoading(false);
        }
    }, []);

    useEffect(() => {
        loadStatus();
        loadTargets();
        loadSent();
        loadDrafts();
    }, [loadStatus, loadTargets, loadSent, loadDrafts]);

    // A send still waiting for the bot settles on the server; look again while one is.
    useEffect(() => {
        if (!sent.some((r) => r.status === "pending")) return undefined;
        const t = setInterval(loadSent, 10_000);
        return () => clearInterval(t);
    }, [sent, loadSent]);

    // The server defaults to the first one that is not the panel's bus server.
    useEffect(() => {
        const guilds = targets?.guilds || [];
        if (!guilds.length || guilds.some((g) => g.id === options.guildId)) return;
        const pick = guilds.find((g) => !g.bus) || guilds[0];
        setOptions((o) => ({ ...o, guildId: pick.id, channelId: null }));
    }, [targets]); // eslint-disable-line react-hooks/exhaustive-deps

    const guild = (targets?.guilds || []).find((g) => g.id === (editing ? editing.guildId : options.guildId)) || null;

    // ── Editor content ──
    const replaceDraft = (next, { keepEditing = false } = {}) => {
        setDraft(next);
        if (!keepEditing) setEditing(null);
        setEditorKey((k) => k + 1);
        setResult(null);
        setTab("compose");
    };

    const clearAll = () => {
        replaceDraft(emptyDraft());
        setSavedRef(null);
    };

    /** A message read by its link (or a Sent row's) → edit it in place. */
    const startEditing = (res) => {
        replaceDraft(toEditor({ ...res.message, components: res.keepsComponents ? null : res.message.components }), { keepEditing: true });
        setEditing({
            guildId: res.guildId,
            guildName: res.guildName,
            channelId: res.channelId,
            channelName: res.channelName,
            messageId: res.messageId,
            url: res.url,
            lockedComponents: res.keepsComponents ? res.message.components : null,
        });
        if (res.sent?.options?.mentions) setOptions((o) => ({ ...o, mentions: res.sent.options.mentions }));
        setSavedRef(null);
        setModal(null);
    };

    /** Any message → the editor, as a new message (only its link buttons come along). */
    const copyToEditor = (msg, { channelId, guildId } = {}) => {
        const rows = msg.components === null ? [] : msg.components || [];
        replaceDraft(toEditor({ ...msg, components: onlyLinkButtons(rows) ? rows : linkRowsOnly(rows) }));
        if (channelId) setOptions((o) => ({ ...o, guildId: guildId || o.guildId, channelId }));
        setSavedRef(null);
        setModal(null);
    };

    // ── Actions ──
    const body = () => ({ message: toApi(draft), mentions: options.mentions });

    const doSend = async (channel) => {
        setBusy("send");
        setResult(null);
        try {
            const { data } = await api.post("/messages/send", { channelId: channel.id, ...body(), silent: options.silent, publish: options.publish }, SLOW);
            setResult({
                tone: data.warnings?.length ? "warning" : "success",
                text: `Sent to #${data.channelName || channel.name}${data.published ? " and published" : ""}.`,
                url: data.url,
                warnings: data.warnings,
                onEdit: canEdit && data.url ? () => startEditingRow(data) : null,
            });
        } catch (err) {
            setResult({ tone: err?.response?.status === 504 ? "warning" : "danger", text: errMsg(err, "Could not send") });
        } finally {
            setBusy(null);
            loadSent();
        }
    };

    const onSend = (report, channel) => {
        if (report.pingsSomeone) {
            setConfirm({
                title: report.loud ? `Ping ${report.chips.filter((c) => c === "@everyone" || c === "@here").join(" and ")} in #${channel.name}?` : `Send to #${channel.name}?`,
                message: `This message pings ${report.chips.join(", ")}${guild ? ` in ${guild.name}` : ""}.`,
                confirmText: "Send",
                danger: report.loud,
                run: () => doSend(channel),
            });
        } else {
            doSend(channel);
        }
    };

    const onSaveEdit = async () => {
        setBusy("edit");
        setResult(null);
        try {
            const { data } = await api.post("/messages/edit", { channelId: editing.channelId, messageId: editing.messageId, ...body() }, SLOW);
            setResult({ tone: data.warnings?.length ? "warning" : "success", text: "Saved — the message on Discord is updated.", url: data.url, warnings: data.warnings });
        } catch (err) {
            setResult({ tone: "danger", text: errMsg(err, "Could not save the changes") });
        } finally {
            setBusy(null);
            loadSent();
        }
    };

    const deleteMessage = (ref, after) =>
        setConfirm({
            title: "Delete this message on Discord?",
            message: `It is removed from #${ref.channelName || ref.channelId} for everyone. This cannot be undone.`,
            confirmText: "Delete",
            danger: true,
            run: async () => {
                setBusy(ref.id || "edit");
                try {
                    await api.post("/messages/delete", { channelId: ref.channelId, messageId: ref.messageId }, SLOW);
                    after?.();
                } catch (err) {
                    alert(errMsg(err, "Could not delete"));
                } finally {
                    setBusy(null);
                    loadSent();
                }
            },
        });

    /** A Sent row → read it fresh from Discord, then edit it. */
    const startEditingRow = async (row) => {
        setBusy(row.id);
        try {
            const { data } = await api.get("/messages/fetch", { params: { link: row.url }, ...SLOW });
            if (data.v2) throw new Error("This message uses Discord's newer layout (Components V2), which this editor cannot open.");
            if (!data.own) throw new Error("That message was not posted by the bot.");
            startEditing(data);
        } catch (err) {
            alert(errMsg(err, "Could not open the message"));
        } finally {
            setBusy(null);
        }
    };

    const saveDraft = async (name, asNew) => {
        setBusy("save");
        const payload = { name, message: draft, options: { guildId: options.guildId, channelId: options.channelId, mentions: options.mentions, silent: options.silent, publish: options.publish } };
        try {
            const { data } = savedRef && !asNew ? await api.put(`/messages/drafts/${savedRef.id}`, payload) : await api.post("/messages/drafts", payload);
            setSavedRef({ id: data.id, name: data.name });
            setModal(null);
            loadDrafts();
        } catch (err) {
            alert(errMsg(err, "Could not save"));
        } finally {
            setBusy(null);
        }
    };

    const openDraft = (d) => {
        replaceDraft(d.message || emptyDraft());
        setOptions({ ...defaultOptions(), ...d.options, guildId: d.options?.guildId || options.guildId, channelId: d.options?.channelId || null });
        setSavedRef({ id: d.id, name: d.name });
    };

    const removeDraft = (d) =>
        setConfirm({
            title: `Delete "${d.name}"?`,
            message: "Only the saved copy is deleted — nothing on Discord changes.",
            confirmText: "Delete",
            danger: true,
            run: async () => {
                try {
                    await api.delete(`/messages/drafts/${d.id}`);
                    if (savedRef?.id === d.id) setSavedRef(null);
                    loadDrafts();
                } catch (err) {
                    alert(errMsg(err, "Could not delete"));
                }
            },
        });

    const forget = async (r) => {
        try {
            await api.delete(`/messages/sent/${r.id}`);
            loadSent();
        } catch (err) {
            alert(errMsg(err, "Could not remove it"));
        }
    };

    // ── Preview ──
    const preview = useMemo(() => {
        const msg = toApi(draft);
        if (draft.components === null) msg.components = editing?.lockedComponents || [];
        return msg;
    }, [draft, editing]);

    const notReady = status && (!status.bot || !status.can.send);

    return (
        <div className="fade-in page" style={{ maxWidth: 1500, display: "flex", flexDirection: "column", gap: 16 }}>
            <PageHeader
                title="Messages"
                description={<>Write a message like on Discohook — content, embeds, link buttons — pick a channel, and {status?.botName || "ArnTo-assistant"} posts it, pinging roles or @everyone if you allow it.</>}
                actions={
                    <>
                        <button className="btn-ghost" onClick={() => setModal("link")} disabled={!status?.can?.fetch}>
                            <Icon name="externalLink" /> Open by link
                        </button>
                        <button className="btn-ghost" onClick={() => setModal("json")}>
                            <Icon name="fileText" /> JSON
                        </button>
                        {canEdit && (
                            <button className="btn-ghost" onClick={() => setModal("save")} disabled={isEmptyDraft(draft)}>
                                <Icon name="archive" /> {savedRef ? "Save…" : "Save"}
                            </button>
                        )}
                        <button className="btn-ghost" onClick={clearAll} title="Start a new, empty message">
                            <Icon name="plus" /> New
                        </button>
                    </>
                }
            />

            {statusError && <Notice tone="danger">{statusError}</Notice>}
            {notReady && (
                <Notice>
                    ArnTo-assistant has not announced <code className="mono">message.send</code> yet — update it (Pull &amp; Update) and restart it. Until then nothing can be sent from here.
                </Notice>
            )}
            {status && status.bot && !status.busReady && <Notice>The panel's Discord bus is not ready — sending waits until it is.</Notice>}

            <div className="toolbar">
                <div className="tab-bar">
                    {[
                        ["compose", editing ? "Compose · editing" : "Compose"],
                        ["sent", `Sent (${sent.length})`],
                        ["saved", `Saved (${drafts.length})`],
                    ].map(([id, label]) => (
                        <button key={id} className={`tab-item ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
                            {label}
                        </button>
                    ))}
                </div>
                {tab === "compose" && savedRef && (
                    <span className="toolbar-count">
                        Saved message: <strong style={{ color: "var(--text-muted)" }}>{savedRef.name}</strong>
                    </span>
                )}
            </div>

            {tab === "compose" && (
                <div className="msg-layout">
                    <div style={{ minWidth: 0 }}>
                        <MessageEditor key={editorKey} value={draft} onChange={setDraft} roles={guild?.roles || []} channels={guild?.channels || []} />
                    </div>
                    <div className="msg-side">
                        <SendBox
                            status={status}
                            targets={targets}
                            targetsError={targetsError}
                            loadingTargets={loadingTargets}
                            onReload={reloadTargets}
                            draft={draft}
                            options={options}
                            setOptions={setOptions}
                            editing={editing}
                            onStopEditing={() => {
                                setEditing(null);
                                if (draft.components === null) setDraft({ ...draft, components: [] });
                                setResult(null);
                            }}
                            onSend={onSend}
                            onSaveEdit={onSaveEdit}
                            onDeleteEditing={() =>
                                deleteMessage(editing, () => {
                                    setEditing(null);
                                    setResult({ tone: "success", text: "Deleted on Discord. The text is still in the editor." });
                                })
                            }
                            busy={busy}
                            result={result}
                            canEdit={canEdit}
                        />
                        <div>
                            <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)", margin: "0 0 6px 2px" }}>Preview</div>
                            <MessagePreview msg={preview} bot={targets?.bot} roles={guild?.roles || []} channels={guild?.channels || []} edited={!!editing} />
                        </div>
                    </div>
                </div>
            )}

            {tab === "sent" && (
                <SentTab
                    rows={sent}
                    loading={sentLoading}
                    error={sentError}
                    canEdit={canEdit}
                    busy={busy}
                    onEdit={startEditingRow}
                    onCopy={(r) => copyToEditor(r.message || {}, { channelId: r.channelId, guildId: r.guildId })}
                    onDelete={(r) => deleteMessage(r)}
                    onForget={forget}
                />
            )}

            {tab === "saved" && <SavedTab drafts={drafts} loading={draftsLoading} error={draftsError} canEdit={canEdit} currentId={savedRef?.id} onLoad={openDraft} onDelete={removeDraft} />}

            {modal === "link" && <LinkModal onClose={() => setModal(null)} onEdit={startEditing} onCopy={(res) => copyToEditor(res.message, { channelId: res.channelId, guildId: res.guildId })} canEdit={canEdit} />}
            {modal === "json" && (
                <JsonModal
                    draft={draft}
                    onClose={() => setModal(null)}
                    onApply={(msg) => {
                        // A message whose buttons run the bot's features keeps them, whatever the JSON says.
                        const keep = !!editing?.lockedComponents;
                        if (!keep && !onlyLinkButtons(msg.components || [])) throw new Error("Only link buttons can be sent from the panel — remove the other buttons and menus from the JSON.");
                        replaceDraft(toEditor(keep ? { ...msg, components: null } : msg), { keepEditing: true });
                        setModal(null);
                    }}
                />
            )}
            {modal === "save" && <SaveModal current={savedRef} busy={busy === "save"} onClose={() => setModal(null)} onSave={saveDraft} />}

            {confirm && (
                <ConfirmModal
                    title={confirm.title}
                    message={confirm.message}
                    confirmText={confirm.confirmText}
                    danger={confirm.danger}
                    onConfirm={() => {
                        const run = confirm.run;
                        setConfirm(null);
                        run();
                    }}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </div>
    );
}
