import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../api/client";
import { usePageAccess } from "../context/AuthContext";
import ConfirmModal from "../components/ConfirmModal";
import MessageEditor, { Fold, IconBtn } from "../components/messages/MessageEditor";
import ImageLinks from "../components/messages/ImageLinks";
import { MessagePreview } from "../components/messages/DiscordPreview";
import { LIMITS, emptyDraft, fromJson, isEmptyDraft, isImage, onlyLinkButtons, picturesOf, pingsOf, snippet, toApi, toEditor } from "../components/messages/format";
import { DataTable, EmptyState, Field, Icon, Modal, Notice, PageHeader, StatusBadge } from "../components/ui";

// ─────────────────────────────────────────────────────────────────────────────
//  Messages — write a message Discohook-style, pick a channel, and
//  ArnTo-assistant posts it as itself, pinging roles / @everyone if you let it.
//  Laid out like discohook.app: the editor on the left, the preview on the right.
//
//  The channel picker and role list come from the panel's server map, which
//  the panel loads from the bot once a day — or with Reload, at most once every
//  10 minutes for everyone — so opening the page never asks the bot. The panel
//  checks the message against Discord's limits and asks the bot to post it. Sent keeps what went out (edit / copy / delete
//  later); Saved keeps messages to reuse. Pictures are added by their link
//  (Attachments): the bot downloads them and posts them under the content,
//  once it has announced message.images. The logic is in
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
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const defaultOptions =() => ({ guildId: null, channelId: null, mentions: { everyone: true, roles: true, users: true }, silent: false, publish: false });

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
/** The same, as the editor holds buttons (for a message that stops being an edit). */
const editorLinkRows = (rows) => toEditor({ components: linkRowsOnly(rows) }).components;

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
        <select className="dh-input" value={guild?.channels?.some((c) => c.id === value) ? value : ""} disabled={disabled || !guild} onChange={(e) => onChange(e.target.value || null)}>
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

/** "Channels loaded 3 h ago · Reload" — Reload waits 10 minutes after the last load, whoever did it. */
function MapLine({ targets, loading, onReload, canReload }) {
    // Re-draw now and then so the countdown and "loaded … ago" move on.
    const [, setTick] = useState(0);
    useEffect(() => {
        const t = setInterval(() => setTick((n) => n + 1), 20_000);
        return () => clearInterval(t);
    }, []);
    const wait = targets?.reloadAt ? Math.ceil((targets.reloadAt - Date.now()) / 60_000) : 0;
    return (
        <div className="dh-meta">
            {targets?.loadedAt ? `Channels loaded ${ago(targets.loadedAt)}, reloaded daily` : "Channels not loaded yet"}
            {canReload && (
                <>
                    {" · "}
                    <button onClick={onReload} disabled={loading || wait > 0} title={wait > 0 ? "The list can be reloaded once every 10 minutes" : "Ask the bot for the servers, channels and roles now"}>
                        {loading ? "Loading…" : wait > 0 ? `Reload in ${wait} min` : "Reload"}
                    </button>
                </>
            )}
        </div>
    );
}

/** The top of the editor, Discohook-style: the tools, where to send, Send, the options. */
function SendBar({ status, targets, targetsError, loadingTargets, onReload, draft, options, setOptions, editing, onSend, onSaveEdit, onLink, onJson, onSave, savedRef, onClear, busy, result, canEdit }) {
    const guilds = targets?.guilds || [];
    const guildId = editing ? editing.guildId : options.guildId;
    const guild = guilds.find((g) => g.id === guildId) || null;
    const channelId = editing ? editing.channelId : options.channelId;
    const channel = guild?.channels?.find((c) => c.id === channelId) || null;
    const report = pingReport({ draft, options, guild, channel, editing: !!editing });
    const setMention = (k, v) => setOptions({ ...options, mentions: { ...options.mentions, [k]: v } });
    const empty = isEmptyDraft(draft) && !editing?.keep?.length;
    const pingSummary = [options.mentions.everyone && "@everyone", options.mentions.roles && "roles", options.mentions.users && "members"].filter(Boolean).join(", ") || "nobody";

    return (
        <div className="dh-pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="dh-row">
                <button className="dh-btn secondary" onClick={onLink} disabled={!status?.can?.fetch} title="Open a message by its link — to edit it or copy it">
                    Open by link
                </button>
                <button className="dh-btn secondary" onClick={onJson} title="Discord's own format, like Discohook's JSON editor">
                    JSON
                </button>
                {canEdit && (
                    <button className="dh-btn secondary" onClick={onSave} disabled={empty} title={savedRef ? `Saved as "${savedRef.name}"` : "Keep this message under Saved"}>
                        {savedRef ? "Save…" : "Save"}
                    </button>
                )}
                <button className="dh-btn secondary" onClick={onClear} title="Start a new, empty message">
                    Clear All
                </button>
            </div>

            {targetsError && <div className="dh-note danger">{targetsError}</div>}
            {targets?.viewer && !targets.viewer.found && <div className="dh-note danger">{targets.viewer.why || "You cannot post from here."}</div>}
            {targets && !targets.viewer && !targets.loadedAt && <div className="dh-note warn">The channel list has not been loaded yet — press Reload.</div>}

            {!editing && (
                <>
                    {guilds.length > 1 && (
                        <label className="dh-field">
                            <span className="dh-label">Server</span>
                            <select className="dh-input" value={options.guildId || ""} onChange={(e) => setOptions({ ...options, guildId: e.target.value || null, channelId: null })}>
                                {guilds.map((g) => (
                                    <option key={g.id} value={g.id}>
                                        {g.name}
                                        {g.bus ? " (the panel's bus server)" : ""}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}
                    <div className="dh-row" style={{ flexWrap: "nowrap", alignItems: "flex-end" }}>
                        <label className="dh-field" style={{ flex: 1 }}>
                            <span className="dh-label">{guilds.length === 1 ? `Channel in ${guilds[0].name}` : "Channel"}</span>
                            <ChannelSelect guild={guild} value={options.channelId} onChange={(id) => setOptions({ ...options, channelId: id, publish: false })} disabled={!canEdit} />
                        </label>
                        {canEdit && (
                            <button className="dh-btn primary" style={{ height: 36 }} disabled={!!busy || empty || !channel || !channel.perms?.send || !status?.can?.send} onClick={() => onSend(report, channel)}>
                                <Icon name="send" size={15} /> {busy === "send" ? "Sending…" : "Send"}
                            </button>
                        )}
                    </div>
                    {targets?.viewer?.found && <span className="dh-hint">Only the channels where your own Discord account can see and send messages. A channel you just got shows after the next load (daily, or Reload).</span>}
                </>
            )}
            {editing && canEdit && (
                <div className="dh-row">
                    <button className="dh-btn primary" disabled={!!busy || empty} onClick={onSaveEdit}>
                        <Icon name="check" size={15} /> {busy === "edit" ? "Saving…" : "Save changes"}
                    </button>
                </div>
            )}
            <MapLine targets={targets} loading={loadingTargets || targets?.loading} onReload={onReload} canReload={canEdit && !!status?.can?.targets} />

            {editing ? (
                <div className="dh-meta">Saving an edit pings nobody — Discord only notifies when a message is first posted. To ping again, send it as a new message (Unlink).</div>
            ) : (
                <Fold title="Options" summary={`pings: ${pingSummary}${options.silent ? " · silent" : ""}${options.publish ? " · publish" : ""}`}>
                    <span className="dh-label">Who may be pinged</span>
                    <label className="dh-check">
                        <input type="checkbox" checked={options.mentions.everyone} onChange={(e) => setMention("everyone", e.target.checked)} /> @everyone and @here
                    </label>
                    <label className="dh-check">
                        <input type="checkbox" checked={options.mentions.roles} onChange={(e) => setMention("roles", e.target.checked)} /> Roles
                    </label>
                    <label className="dh-check">
                        <input type="checkbox" checked={options.mentions.users} onChange={(e) => setMention("users", e.target.checked)} /> Members
                    </label>
                    <label className="dh-check" title="The message arrives without a notification sound or badge (Discord's @silent)">
                        <input type="checkbox" checked={options.silent} onChange={(e) => setOptions({ ...options, silent: e.target.checked })} /> Silent — no notifications
                    </label>
                    {channel?.type === "announcement" && (
                        <label className="dh-check" title="Also send it to the servers that follow this announcement channel">
                            <input type="checkbox" checked={options.publish} onChange={(e) => setOptions({ ...options, publish: e.target.checked })} /> Publish to following servers
                        </label>
                    )}
                </Fold>
            )}

            {report.chips.length > 0 && (
                <div className="dh-row dh-meta">
                    {editing ? "Mentions:" : options.silent ? "Mentions (silent):" : "Pings:"}
                    {report.chips.map((c) => (
                        <span key={c} className="dh-chip">{c}</span>
                    ))}
                </div>
            )}
            {report.warnings.map((w) => (
                <div key={w} className="dh-note warn">{w}</div>
            ))}
            {report.notes.map((n) => (
                <div key={n} className="dh-meta">{n}</div>
            ))}

            {result && (
                <div className={`dh-note ${result.tone === "success" ? "ok" : result.tone === "danger" ? "danger" : result.tone === "warning" ? "warn" : ""}`}>
                    {result.text}
                    {result.url && (
                        <>
                            {" "}
                            <a href={result.url} target="_blank" rel="noreferrer">
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
                        <div style={{ marginTop: 8 }}>
                            <button className="dh-btn secondary" onClick={result.onEdit}>
                                <Icon name="pencil" size={14} /> Edit it
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/** The message's files: the ones it has (an edit: keep or remove each) and pictures added by link. */
function AttachmentsFold({ draft, editing, botName, canImages, onImages, onToggleKeep }) {
    const own = editing?.attachments || [];
    const kept = own.filter((a) => editing.keep.includes(a.id));
    const images = draft.images || [];
    const count = kept.length + images.length;
    return (
        <Fold title={`Attachments (${count}/${LIMITS.files})`} summary={images.length ? `${images.length} by link` : ""} defaultOpen={count > 0}>
            {own.map((a) => {
                const on = editing.keep.includes(a.id);
                return (
                    <div key={a.id} className="dh-file" style={on ? undefined : { opacity: 0.5 }}>
                        <Icon name={isImage(a.filename, a.contentType) ? "eye" : "fileText"} size={15} />
                        <a href={a.url} target="_blank" rel="noreferrer" className="dh-file-name" style={on ? undefined : { textDecoration: "line-through" }}>
                            {a.filename}
                        </a>
                        <span className="dh-count">{a.size ? fmtSize(a.size) : ""}</span>
                        {on ? (
                            <IconBtn icon="x" title="Remove it from the message when saving" onClick={() => onToggleKeep(a.id)} />
                        ) : (
                            <button type="button" className="dh-btn secondary" style={{ height: 26, minWidth: 0, padding: "0 10px", fontSize: 13 }} onClick={() => onToggleKeep(a.id)}>
                                Keep
                            </button>
                        )}
                    </div>
                );
            })}
            <ImageLinks
                images={images}
                onChange={onImages}
                room={LIMITS.files - count}
                taken={own.map((a) => a.filename)}
                disabled={canImages ? "" : `${botName} cannot attach pictures yet — update it (Pull & Update) and restart it.`}
            />
            <span className="dh-hint">A picture added by its link shows under the content, with no embed needed. {botName} downloads it when the message is sent, so the link must open the picture itself (PNG, JPEG, GIF or WebP).</span>
        </Fold>
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
            {rows.length > 0 && <p style={{ color: "var(--text-muted)", fontSize: 12, margin: 0 }}>Kept for 3 days after a message was last sent, edited or deleted — it stays on Discord.</p>}
            {!rows.length ? (
                <EmptyState icon="send" title="Nothing sent yet" description="Messages sent from this page, and messages edited here by their link, are listed here for 3 days." />
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
    const [folded, setFolded] = useState(false); // the message strip, closed
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
            // Its files, to keep or remove — null from a bot too old to list them (they stay as they are).
            attachments: Array.isArray(res.attachments) ? res.attachments : null,
            keep: (res.attachments || []).map((a) => a.id),
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
            const { data } = await api.post(
                "/messages/edit",
                { channelId: editing.channelId, messageId: editing.messageId, ...body(), ...(editing.attachments ? { keepAttachments: editing.keep } : {}) },
                SLOW,
            );
            // The pictures added by link are files of the message now.
            if (Array.isArray(data.attachments)) setEditing((e) => e && { ...e, attachments: data.attachments, keep: data.attachments.map((a) => a.id) });
            setDraft((d) => ({ ...d, images: [] }));
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
    const previewFiles = useMemo(
        () => [
            ...(editing?.attachments || []).filter((a) => editing.keep.includes(a.id)).map((a) => ({ name: a.filename, url: a.url, image: isImage(a.filename, a.contentType), size: a.size })),
            ...(draft.images || []).map((x) => ({ name: x.name, url: x.url, image: true })),
        ],
        [draft, editing],
    );
    const toggleKeep = (id) => setEditing((e) => e && { ...e, keep: e.keep.includes(id) ? e.keep.filter((x) => x !== id) : [...e.keep, id] });

    const notReady = status && (!status.bot || !status.can.send);
    const compose = tab === "compose";
    const stopEditing = () => {
        setEditing(null);
        if (draft.components === null) setDraft({ ...draft, components: editorLinkRows(editing?.lockedComponents) });
        setResult(null);
    };
    const head = snippet(toApi(draft), 60);

    return (
        <div className={`fade-in page${compose ? " dh-page" : ""}`} style={compose ? undefined : { maxWidth: 1500, display: "flex", flexDirection: "column", gap: 16 }}>
            <PageHeader
                title="Messages"
                description={<>Write a message like on Discohook — content, embeds, pictures by link, link buttons — pick a channel, and {status?.botName || "ArnTo-assistant"} posts it, pinging roles or @everyone if you allow it.</>}
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
                {compose && savedRef && (
                    <span className="toolbar-count">
                        Saved message: <strong style={{ color: "var(--text-muted)" }}>{savedRef.name}</strong>
                    </span>
                )}
            </div>

            {compose && (
                <div className="dh dh-split">
                    <div className="dh-pane dh-editor">
                        <SendBar
                            status={status}
                            targets={targets}
                            targetsError={targetsError}
                            loadingTargets={loadingTargets}
                            onReload={reloadTargets}
                            draft={draft}
                            options={options}
                            setOptions={setOptions}
                            editing={editing}
                            onSend={onSend}
                            onSaveEdit={onSaveEdit}
                            onLink={() => setModal("link")}
                            onJson={() => setModal("json")}
                            onSave={() => setModal("save")}
                            savedRef={savedRef}
                            onClear={clearAll}
                            busy={busy}
                            result={result}
                            canEdit={canEdit}
                        />
                        <div className="dh-message">
                            <div className="dh-message-head" onClick={() => setFolded(!folded)}>
                                <Icon name={folded ? "chevronRight" : "chevronDown"} size={18} />
                                <span className="dh-message-title">
                                    Message{head && !isEmptyDraft(draft) ? ` - ${head}` : ""}
                                </span>
                                <span className="dh-fold-right" onClick={(e) => e.stopPropagation()}>
                                    {editing && <Icon name="pencil" size={15} style={{ color: "#949ba4", margin: "0 4px" }} />}
                                    <IconBtn icon="trash" danger title="Clear the message" onClick={clearAll} />
                                </span>
                            </div>
                            {!folded && (
                                <>
                                    {editing && (
                                        <div className="dh-note" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                            <span style={{ flex: 1, minWidth: 0 }}>
                                                Editing a message in #{editing.channelName || editing.channelId}
                                                {editing.guildName ? ` · ${editing.guildName}` : ""}
                                                {editing.url && (
                                                    <>
                                                        {" · "}
                                                        <a href={editing.url} target="_blank" rel="noreferrer">
                                                            open
                                                        </a>
                                                    </>
                                                )}
                                            </span>
                                            {canEdit && (
                                                <IconBtn
                                                    icon="trash"
                                                    danger
                                                    title="Delete this message on Discord"
                                                    onClick={() =>
                                                        deleteMessage(editing, () => {
                                                            setEditing(null);
                                                            setResult({ tone: "success", text: "Deleted on Discord. The text is still in the editor." });
                                                        })
                                                    }
                                                />
                                            )}
                                        </div>
                                    )}
                                    <MessageEditor
                                        key={editorKey}
                                        value={draft}
                                        onChange={setDraft}
                                        roles={guild?.roles || []}
                                        channels={guild?.channels || []}
                                        extra={
                                            <AttachmentsFold
                                                draft={draft}
                                                editing={editing}
                                                botName={status?.botName || "ArnTo-assistant"}
                                                canImages={!!status?.can?.images}
                                                onImages={(images) => setDraft((d) => ({ ...d, images }))}
                                                onToggleKeep={toggleKeep}
                                            />
                                        }
                                        footer={
                                            editing ? (
                                                <button type="button" className="dh-btn secondary" onClick={stopEditing} title="Keep the text as a new message">
                                                    Unlink
                                                </button>
                                            ) : (
                                                <button type="button" className="dh-btn secondary" onClick={() => setModal("link")} disabled={!status?.can?.fetch} title="Paste the link of one of the bot's messages to edit it">
                                                    Set Link
                                                </button>
                                            )
                                        }
                                    />
                                </>
                            )}
                        </div>
                    </div>
                    <div className="dh-pane dh-preview">
                        <MessagePreview msg={preview} bot={targets?.bot} roles={guild?.roles || []} channels={guild?.channels || []} edited={!!editing} files={previewFiles} />
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

            {modal === "link" && (
                <LinkModal
                    onClose={() => setModal(null)}
                    onEdit={startEditing}
                    // Its pictures come along by their Discord links (good for about a day).
                    onCopy={(res) => copyToEditor({ ...res.message, images: picturesOf(res.attachments).slice(0, LIMITS.files) }, { channelId: res.channelId, guildId: res.guildId })}
                    canEdit={canEdit}
                />
            )}
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
