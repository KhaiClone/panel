import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "../api/client";
import { usePageAccess } from "../context/AuthContext";
import ConfirmModal from "../components/ConfirmModal";
import MessageEditor, { Fold, IconBtn } from "../components/messages/MessageEditor";
import ImageLinks from "../components/messages/ImageLinks";
import useFileDrop from "../components/messages/useFileDrop";
import { MessagePreview } from "../components/messages/DiscordPreview";
import { emptyDraft, fileName, fromJson, isEmptyDraft, isImage, onlyLinkButtons, picturesOf, pingsOf, snippet, toApi, toEditor } from "../components/messages/format";
import { DataTable, EmptyState, Field, Icon, Modal, Notice, PageHeader, SearchInput, StatusBadge } from "../components/ui";

// ─────────────────────────────────────────────────────────────────────────────
//  Webhooks — Discohook on the panel, laid out like discohook.app: the editor
//  on the left (every message a strip of its own), the preview on the right.
//  Write one or more messages, give them a name and a picture, attach files,
//  pick one of the shop server's webhooks (no URL to paste) and send. A
//  message's link is enough to edit it: the panel finds the webhook that sent it.
//
//  The webhook list comes from ArnTo-assistant once a day, or with Reload (at
//  most once every 10 minutes for everyone); ArnTo-selfbot makes new webhooks,
//  asked by ArnTo-assistant with a command in that channel (deleted right after).
//  The panel posts through Discord's webhook API itself and never hands a
//  token to this page. Logic: server/services/webhookMessages.js.
// ─────────────────────────────────────────────────────────────────────────────

const STORE = "webhooks.compose.v1";
const SLOW = { timeout: 45_000 };
const UPLOAD = { timeout: 120_000 };
const MAX_MESSAGES = 10;
const MAX_FILES = 10;
const MAX_BYTES = 25 * 1024 * 1024;
const SNOWFLAKE = /^\d{17,20}$/;

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
const byText = (a) => (a ? (a.kind === "staff" ? a.tag || a.id : "Owner") : "—");

let seq = 0;
const newKey = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;
const newMessage = (over = {}) => ({ key: newKey(), draft: emptyDraft(), username: "", avatarUrl: "", ref: null, ...over });
const defaultOptions = () => ({ mentions: { everyone: true, roles: true, users: true }, silent: false, suppressEmbeds: false });
const defaultDoc = () => ({ messages: [newMessage()], target: { webhookId: null, mode: "new", thread: "", threadName: "" }, options: defaultOptions() });

const readStore = () => {
    try {
        const v = JSON.parse(localStorage.getItem(STORE) || "null");
        return v?.messages?.length ? v : null;
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

/** A thread's link (…/channels/<server>/<thread>[/<message>]) or id → its id; "" → null; anything else → undefined. */
const threadIdOf = (s) => {
    const t = String(s || "").trim();
    if (!t) return null;
    const m = /channels\/\d{17,20}\/(\d{17,20})/.exec(t);
    if (m) return m[1];
    return SNOWFLAKE.test(t) ? t : undefined;
};

/** Only the link buttons of a message's rows (the rest belong to a bot). */
const linkRowsOnly = (rows) =>
    (rows || [])
        .map((r) => ({ type: 1, components: (r.components || []).filter((c) => c.type === 2 && c.style === 5 && c.url) }))
        .filter((r) => r.components.length);
/** The same, as the editor holds buttons (for a message that stops being an edit). */
const editorLinkRows = (rows) => toEditor({ components: linkRowsOnly(rows) }).components;

const emptyMessage = (m, files) => isEmptyDraft(m.draft) && !(files[m.key] || []).length && !(m.ref?.keep || []).length;

/** A message opened by link / from Sent → what an edit needs to know about it. */
const refOf = (res) => ({
    webhookId: res.webhook?.id || res.webhookId,
    webhookName: res.webhook?.name || res.webhookName || null,
    channelId: res.channelId,
    channelName: res.channelName || null,
    threadId: res.threadId || null,
    threadName: res.threadName || null,
    messageId: res.messageId,
    url: res.url,
    attachments: res.attachments || [],
    keep: (res.attachments || []).map((a) => a.id),
    lockedComponents: res.keepsComponents ? res.message?.components || [] : null,
    author: res.author || null,
});

const AVATAR = "https://cdn.discordapp.com/embed/avatars/0.png";

function Avatar({ src, size = 28 }) {
    return <img src={src || AVATAR} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
}

const channelLabel = (c) => `${c.type === "forum" || c.type === "media" ? "💬" : c.type === "announcement" ? "📢" : c.type === "voice" || c.type === "stage" ? "🔊" : "#"} ${c.name}`;

// ── The top of the editor: what to send with, how, and Send ─────────────────

/** "Webhooks loaded 3 h ago · Reload" — Reload waits 10 minutes after the last load, whoever did it. */
function ScanLine({ targets, loading, onReload, canReload }) {
    const [, setTick] = useState(0);
    useEffect(() => {
        const t = setInterval(() => setTick((n) => n + 1), 20_000);
        return () => clearInterval(t);
    }, []);
    const wait = targets?.reloadAt ? Math.ceil((targets.reloadAt - Date.now()) / 60_000) : 0;
    return (
        <div className="dh-meta">
            {targets?.loadedAt ? `Webhooks loaded ${ago(targets.loadedAt)}, reloaded daily` : "Webhooks not loaded yet"}
            {canReload && (
                <>
                    {" · "}
                    <button onClick={onReload} disabled={loading || wait > 0} title={wait > 0 ? "The list can be reloaded once every 10 minutes" : "Ask the bot for the server's webhooks now"}>
                        {loading ? "Loading…" : wait > 0 ? `Reload in ${wait} min` : "Reload"}
                    </button>
                </>
            )}
        </div>
    );
}

/** Discohook's "Add Webhook": the shop server's webhooks to pick from. */
function WebhookPicker({ channels, current, onPick, onClose, canCreate, onNew }) {
    const [q, setQ] = useState("");
    const groups = channels
        .map((c) => ({ ...c, webhooks: c.webhooks.filter((w) => !q.trim() || `${w.name} ${c.name}`.toLowerCase().includes(q.trim().toLowerCase())) }))
        .filter((c) => c.webhooks.length);
    return (
        <Modal title="Pick a webhook" onClose={onClose} width={520}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                        <SearchInput value={q} onChange={setQ} placeholder="Search webhooks or channels" />
                    </div>
                    {canCreate && (
                        <button className="btn-ghost" onClick={onNew}>
                            <Icon name="plus" /> New webhook
                        </button>
                    )}
                </div>
                {!groups.length && <div style={{ fontSize: 13, color: "var(--text-dim)", padding: "12px 0" }}>{q ? "Nothing matches." : "This server has no webhooks yet."}</div>}
                <div style={{ display: "flex", flexDirection: "column", gap: 14, maxHeight: "60vh", overflowY: "auto" }}>
                    {groups.map((c) => (
                        <div key={c.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4 }}>
                                {c.parent ? `${c.parent} › ` : ""}
                                {channelLabel(c)}
                            </div>
                            {c.webhooks.map((w) => (
                                <button key={w.id} className="wh-pick" disabled={!w.usable} onClick={() => onPick(w.id)} title={w.why || undefined}>
                                    <Avatar src={w.avatar} size={32} />
                                    <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                                        <span style={{ display: "block", fontWeight: 500, color: "var(--text)" }}>{w.name}</span>
                                        <span style={{ display: "block", fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                            {w.usable ? (w.creator?.tag ? `made by ${w.creator.tag}` : "usable") : w.why}
                                        </span>
                                    </span>
                                    {current === w.id && <StatusBadge tone="success">In use</StatusBadge>}
                                </button>
                            ))}
                        </div>
                    ))}
                </div>
            </div>
        </Modal>
    );
}

function TopBar({ status, targets, targetsError, loadingTargets, onReload, doc, setTarget, setOptions, files, onSend, onPickWebhook, onNewWebhook, onLink, onJson, onSave, savedRef, onClear, busy, results, onEditSent, canEdit }) {
    const channels = targets?.channels || [];
    const { target, options, messages } = doc;
    const channel = channels.find((c) => c.webhooks.some((w) => w.id === target.webhookId)) || null;
    const webhook = channel?.webhooks.find((w) => w.id === target.webhookId) || null;
    const posts = channel && (channel.type === "forum" || channel.type === "media");
    const setMention = (k, v) => setOptions({ ...options, mentions: { ...options.mentions, [k]: v } });

    const live = messages.filter((m) => !emptyMessage(m, files));
    const edits = live.filter((m) => m.ref).length;
    const fresh = live.length - edits;
    const pings = live
        .filter((m) => !m.ref)
        .map((m) => pingsOf(m.draft.content))
        .reduce((a, p) => ({ everyone: a.everyone || p.everyone, here: a.here || p.here, roles: a.roles + p.roles.length, users: a.users + p.users.length }), { everyone: false, here: false, roles: 0, users: 0 });
    const chips = [
        ...(pings.everyone && options.mentions.everyone ? ["@everyone"] : []),
        ...(pings.here && options.mentions.everyone ? ["@here"] : []),
        ...(pings.roles && options.mentions.roles ? [`${pings.roles} role${pings.roles === 1 ? "" : "s"}`] : []),
        ...(pings.users && options.mentions.users ? [`${pings.users} member${pings.users === 1 ? "" : "s"}`] : []),
    ];
    const threadBad = !posts && threadIdOf(target.thread) === undefined;
    const postBad = posts && (target.mode === "existing" ? !threadIdOf(target.thread) : !target.threadName.trim());
    const ready = live.length > 0 && (fresh === 0 || (webhook?.usable && !threadBad && !postBad));
    const label = !live.length ? "Send" : fresh && edits ? `Send ${fresh} · Save ${edits}` : edits ? `Save ${edits === 1 ? "edit" : `${edits} edits`}` : fresh === 1 ? "Send" : `Send ${fresh}`;
    const pingSummary = [options.mentions.everyone && "@everyone", options.mentions.roles && "roles", options.mentions.users && "members"].filter(Boolean).join(", ") || "nobody";

    return (
        <div className="dh-pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="dh-row">
                <button className="dh-btn secondary" onClick={onLink} disabled={!status?.can?.fetch} title="Open a message by its link — to edit it or copy it">
                    Open by link
                </button>
                <button className="dh-btn secondary" onClick={onJson} title="Discohook's backup format">
                    JSON
                </button>
                {canEdit && (
                    <button className="dh-btn secondary" onClick={onSave} disabled={messages.every((m) => isEmptyDraft(m.draft))} title={savedRef ? `Saved as "${savedRef.name}"` : "Keep these messages under Saved"}>
                        {savedRef ? "Save…" : "Save"}
                    </button>
                )}
                <button className="dh-btn secondary" onClick={onClear} title="Start over with one empty message">
                    Clear All
                </button>
            </div>

            {canEdit && (
                <div className="dh-row">
                    <button className="dh-btn primary" onClick={onPickWebhook} disabled={!channels.length}>
                        {webhook ? "Change Webhook" : "Add Webhook"}
                    </button>
                    <button className="dh-btn primary" disabled={!!busy || !ready} onClick={onSend}>
                        <Icon name="send" size={15} /> {busy === "send" ? "Sending…" : label}
                    </button>
                    {status?.can?.create && (
                        <button className="dh-btn secondary" onClick={onNewWebhook} disabled={!channels.length} title="ArnTo-selfbot makes a new webhook in a channel">
                            New Webhook
                        </button>
                    )}
                </div>
            )}
            <ScanLine targets={targets} loading={loadingTargets || targets?.loading} onReload={onReload} canReload={canEdit && !!status?.can?.list} />

            {targetsError && <div className="dh-note danger">{targetsError}</div>}
            {targets?.viewer && !targets.viewer.found && <div className="dh-note danger">{targets.viewer.why || "You cannot use webhooks here."}</div>}
            {targets && !targets.viewer && !targets.loadedAt && <div className="dh-note warn">The webhook list has not been loaded yet — press Reload.</div>}

            {webhook && (
                <div className="dh-target">
                    <img src={webhook.avatar || AVATAR} alt="" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="dh-target-name">{webhook.name}</div>
                        <div className="dh-meta">
                            {channelLabel(channel)}
                            {webhook.creator?.tag ? ` · made by ${webhook.creator.tag}` : ""}
                        </div>
                    </div>
                    {canEdit && <IconBtn icon="x" title="Remove the webhook" onClick={() => setTarget({ ...target, webhookId: null })} />}
                </div>
            )}
            {!webhook && fresh > 0 && targets?.loadedAt && <div className="dh-meta">Pick a webhook to send new messages with — Add Webhook.</div>}

            {channel && (
                <Fold
                    title="Thread"
                    summary={posts ? (target.mode === "existing" ? "reply in a post" : target.threadName || "new post") : target.thread ? "inside a thread" : "the channel itself"}
                    defaultOpen={!!posts || !!target.thread}
                >
                    {posts ? (
                        <>
                            <div className="dh-row">
                                {[
                                    ["new", "New post"],
                                    ["existing", "Reply in a post"],
                                ].map(([id, text]) => (
                                    <button key={id} className={`dh-btn ${target.mode === id ? "primary" : "secondary"}`} onClick={() => setTarget({ ...target, mode: id })}>
                                        {text}
                                    </button>
                                ))}
                            </div>
                            {target.mode === "existing" ? (
                                <label className="dh-field">
                                    <span className="dh-label">Post</span>
                                    <input className="dh-input mono" value={target.thread} onChange={(e) => setTarget({ ...target, thread: e.target.value })} placeholder="https://discord.com/channels/…/…" />
                                    <span className="dh-hint">The post's link (right-click it → Copy Link) or its id.</span>
                                </label>
                            ) : (
                                <label className="dh-field">
                                    <span className="dh-label">Post title</span>
                                    <input className="dh-input" value={target.threadName} maxLength={100} onChange={(e) => setTarget({ ...target, threadName: e.target.value })} placeholder="Weekly sale" />
                                    <span className="dh-hint">Every new message of this send goes into the one new post.</span>
                                </label>
                            )}
                        </>
                    ) : (
                        <label className="dh-field">
                            <span className="dh-label">Thread (optional)</span>
                            <input className="dh-input mono" value={target.thread} onChange={(e) => setTarget({ ...target, thread: e.target.value })} placeholder="https://discord.com/channels/…/…" />
                            <span className="dh-hint" style={threadBad ? { color: "#f0b232" } : undefined}>
                                {threadBad ? "That is not a thread's link or id." : "A thread of this channel — its link or id. Empty: the channel itself."}
                            </span>
                        </label>
                    )}
                </Fold>
            )}

            <Fold title="Options" summary={`pings: ${pingSummary}${options.silent ? " · silent" : ""}${options.suppressEmbeds ? " · no link previews" : ""}`}>
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
                <label className="dh-check" title="The messages arrive without a notification sound or badge (Discord's @silent)">
                    <input type="checkbox" checked={options.silent} onChange={(e) => setOptions({ ...options, silent: e.target.checked })} /> Silent — no notifications
                </label>
                <label className="dh-check" title="Links in the text get no preview card">
                    <input type="checkbox" checked={options.suppressEmbeds} onChange={(e) => setOptions({ ...options, suppressEmbeds: e.target.checked })} /> No link previews
                </label>
            </Fold>

            {chips.length > 0 && (
                <div className="dh-row dh-meta">
                    {options.silent ? "Mentions (silent):" : "Pings:"}
                    {chips.map((c) => (
                        <span key={c} className="dh-chip">{c}</span>
                    ))}
                </div>
            )}
            {edits > 0 && <div className="dh-meta">Edits go through the webhook that sent each message, keep its name and picture, and ping nobody.</div>}

            {results && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {results.map((r) => (
                        <div key={r.n} className={`dh-note ${r.tone === "success" ? "ok" : r.tone === "danger" ? "danger" : ""}`}>
                            <strong>Message {r.n}</strong> — {r.text}
                            {r.url && (
                                <>
                                    {" "}
                                    <a href={r.url} target="_blank" rel="noreferrer">
                                        Open in Discord
                                    </a>
                                </>
                            )}
                        </div>
                    ))}
                    {canEdit && results.some((r) => r.row) && (
                        <div>
                            <button className="dh-btn secondary" onClick={onEditSent}>
                                <Icon name="pencil" size={14} /> Edit what was sent
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ── A message strip ──────────────────────────────────────────────────────────

function ProfileFold({ m, webhook, onChange }) {
    if (m.ref) {
        return (
            <Fold title="Profile" summary={m.ref.author?.username || m.ref.webhookName || ""}>
                <div className="dh-row">
                    <Avatar src={m.ref.author?.avatar} size={32} />
                    <span className="dh-meta">
                        Posted as <strong style={{ color: "#f2f3f5" }}>{m.ref.author?.username || m.ref.webhookName || "the webhook"}</strong> — Discord keeps the name and picture a message was sent with.
                    </span>
                </div>
            </Fold>
        );
    }
    return (
        <Fold title="Profile" summary={m.username || m.avatarUrl ? [m.username, m.avatarUrl && "avatar"].filter(Boolean).join(" · ") : "the webhook's own"} defaultOpen={!!(m.username || m.avatarUrl)}>
            <label className="dh-field">
                <span className="dh-label">
                    Name <span className="dh-count">{m.username.length}/80</span>
                </span>
                <input className="dh-input" value={m.username} maxLength={80} placeholder={webhook?.name || "Webhook's name"} onChange={(e) => onChange({ username: e.target.value })} />
            </label>
            <label className="dh-field">
                <span className="dh-label">Avatar URL</span>
                <div className="dh-row" style={{ flexWrap: "nowrap" }}>
                    <input className="dh-input" value={m.avatarUrl} placeholder="https://…/picture.png" onChange={(e) => onChange({ avatarUrl: e.target.value })} />
                    <Avatar src={m.avatarUrl.trim() || webhook?.avatar} size={34} />
                </div>
            </label>
        </Fold>
    );
}

function FilesFold({ m, own, onAdd, onRemove, onToggleKeep, onImages }) {
    const input = useRef(null);
    const kept = (m.ref?.attachments || []).filter((a) => m.ref.keep.includes(a.id));
    const images = m.draft.images || [];
    const count = kept.length + own.length + images.length;
    const bytes = own.reduce((n, f) => n + f.size, 0);
    const copy = (name) => navigator.clipboard?.writeText(`attachment://${name}`);
    const summary = [bytes ? fmtSize(bytes) : "", images.length ? `${images.length} by link` : ""].filter(Boolean).join(" · ");
    return (
        <Fold title={`Attachments (${count}/${MAX_FILES})`} summary={summary} defaultOpen={count > 0}>
            {(m.ref?.attachments || []).map((a) => {
                const on = m.ref.keep.includes(a.id);
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
            {own.map((f) => (
                <div key={f.id} className="dh-file">
                    {f.image ? <img src={f.url} alt="" style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 4 }} /> : <Icon name="fileText" size={15} />}
                    <span className="dh-file-name" title={f.file.name}>
                        {f.name}
                    </span>
                    <span className="dh-count">{fmtSize(f.size)}</span>
                    {f.image && <IconBtn icon="copy" title={`Copy attachment://${f.name} — paste it as an embed's image to show the file inside the embed`} onClick={() => copy(f.name)} />}
                    <IconBtn icon="trash" danger title="Remove" onClick={() => onRemove(f.id)} />
                </div>
            ))}
            <ImageLinks
                images={images}
                onChange={onImages}
                room={MAX_FILES - kept.length - own.length - images.length}
                taken={[...own.map((f) => f.name), ...(m.ref?.attachments || []).map((a) => a.filename)]}
                copyable
            />
            <input
                ref={input}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                    onAdd([...e.target.files]);
                    e.target.value = "";
                }}
            />
            <div>
                <button type="button" className="dh-btn primary" disabled={count >= MAX_FILES} onClick={() => input.current?.click()}>
                    Add File
                </button>
            </div>
            <span className="dh-hint">
                Up to {MAX_FILES} files, {MAX_BYTES / 1048576} MB together (Discord itself takes 10 MB on a server without boosts). Paste a picture (Ctrl+V) or drop files anywhere on the message to add them. A picture added by its link shows under the content with no embed needed; the panel downloads it when the message is sent. A picture can also go inside an embed: copy its attachment:// name into the embed's image. Uploaded files are not kept when the page reloads; pictures by link are.
            </span>
        </Fold>
    );
}

function MessageStrip({ m, i, count, open, onToggle, files, webhook, roles, channels, editorKey, canEdit, onPatch, onMove, onDuplicate, onRemove, onSetLink, onUnlink, onDeleteOnDiscord, onAddFiles, onRemoveFile, onToggleKeep }) {
    const head = snippet(toApi(m.draft), 60);
    const drop = useFileDrop(onAddFiles);
    return (
        <div className={`dh-message${drop.over ? " dh-drop" : ""}`} {...drop.props}>
            <div className="dh-message-head" onClick={() => onToggle(!open)}>
                <Icon name={open ? "chevronDown" : "chevronRight"} size={18} />
                <span className="dh-message-title">
                    Message {i + 1}
                    {!emptyMessage(m, files) && head ? ` - ${head}` : ""}
                </span>
                <span className="dh-fold-right" onClick={(e) => e.stopPropagation()}>
                    {m.ref && <Icon name="pencil" size={15} style={{ color: "#949ba4", margin: "0 4px" }} />}
                    <IconBtn icon="chevronUp" title="Move up" onClick={() => onMove(-1)} disabled={i === 0} />
                    <IconBtn icon="chevronDown" title="Move down" onClick={() => onMove(1)} disabled={i === count - 1} />
                    <IconBtn icon="copy" title="Duplicate" onClick={onDuplicate} disabled={count >= MAX_MESSAGES} />
                    <IconBtn icon="trash" danger title={count === 1 ? "Clear this message" : "Remove this message"} onClick={onRemove} />
                </span>
            </div>
            {open && (
                <>
                    {m.ref && (
                        <div className="dh-note" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                            <span style={{ flex: 1, minWidth: 0 }}>
                                Editing a message of <strong>{m.ref.webhookName || "a webhook"}</strong> in #{m.ref.channelName || m.ref.channelId}
                                {m.ref.threadName ? ` › ${m.ref.threadName}` : ""}
                                {m.ref.url && (
                                    <>
                                        {" · "}
                                        <a href={m.ref.url} target="_blank" rel="noreferrer">
                                            open
                                        </a>
                                    </>
                                )}
                            </span>
                            {canEdit && <IconBtn icon="trash" danger title="Delete this message on Discord" onClick={onDeleteOnDiscord} />}
                        </div>
                    )}
                    <MessageEditor
                        key={`${m.key}:${editorKey}`}
                        value={m.draft}
                        onChange={(draft) => onPatch({ draft })}
                        roles={roles}
                        channels={channels}
                        extra={
                            <>
                                <ProfileFold m={m} webhook={webhook} onChange={onPatch} />
                                <FilesFold m={m} own={files[m.key] || []} onAdd={onAddFiles} onRemove={onRemoveFile} onToggleKeep={onToggleKeep} onImages={(images) => onPatch({ draft: { ...m.draft, images } })} />
                            </>
                        }
                        footer={
                            m.ref ? (
                                <button type="button" className="dh-btn secondary" onClick={onUnlink} title="Keep the text as a new message">
                                    Unlink
                                </button>
                            ) : (
                                <button type="button" className="dh-btn secondary" onClick={onSetLink} title="Paste the link of a message to edit it with this text">
                                    Set Link
                                </button>
                            )
                        }
                    />
                </>
            )}
        </div>
    );
}

// ── Modals ───────────────────────────────────────────────────────────────────

const KIND = { webhook: "a webhook", gone: "a deleted webhook", hidden: "a webhook", interaction: "a bot command", bot: "a bot", user: "a member" };

function LinkModal({ forMessage, onClose, onEdit, onCopy, onUseWebhook, canEdit }) {
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
            const { data } = await api.get("/webhooks/fetch", { params: { link }, ...SLOW });
            setRes(data);
        } catch (err) {
            setError(errMsg(err, "Could not read that message"));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Modal title={forMessage ? `Set the link of message ${forMessage}` : "Open a message by its link"} onClose={onClose} width={540}>
            <form onSubmit={look} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Field label="Message link" hint="On Discord: right-click the message (or ⋯) → Copy Message Link. The panel finds the webhook that sent it — nothing to pick.">
                    <input className="input mono" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://discord.com/channels/…/…/…" autoFocus />
                </Field>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button type="submit" className="btn-primary" disabled={busy || !link.trim()}>
                        {busy ? "Reading…" : "Read message"}
                    </button>
                </div>
            </form>
            {error && (
                <div style={{ marginTop: 12 }}>
                    <Notice tone="danger">{error}</Notice>
                </div>
            )}
            {res && (
                <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
                        <Avatar src={res.author?.avatar} size={32} />
                        <span>
                            <strong style={{ color: "var(--text)" }}>{res.author?.username || "?"}</strong> in {res.threadName ? <strong>{res.threadName}</strong> : <strong>#{res.channelName}</strong>}
                            {res.threadName && ` (#${res.channelName})`}, {fmtDate(res.createdAt)}
                            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                                Sent by {KIND[res.kind] || res.kind}
                                {res.webhook && (
                                    <>
                                        {" "}
                                        — webhook <strong>{res.webhook.name}</strong>
                                    </>
                                )}
                                {res.sent && " · listed under Sent"}
                            </div>
                        </span>
                    </div>
                    {res.why && <Notice tone={res.v2 ? "danger" : undefined}>{res.why}</Notice>}
                    {res.editable && res.keepsComponents && <Notice>Its buttons or menus belong to a bot: editing keeps them as they are. A copy leaves them out.</Notice>}
                    {!res.v2 && (
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                            {res.webhook?.usable && canEdit && !forMessage && (
                                <button className="btn-ghost" onClick={() => onUseWebhook(res)} title="Send new messages with this webhook">
                                    <Icon name="webhook" /> Use this webhook
                                </button>
                            )}
                            <button className="btn-ghost" onClick={() => onCopy(res)}>
                                <Icon name="copy" /> Copy into the editor
                            </button>
                            {res.editable && canEdit && (
                                <button className="btn-primary" onClick={() => onEdit(res)}>
                                    <Icon name="pencil" /> Edit this message
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}
        </Modal>
    );
}

/** Discohook's backup: { messages: [{ data: { content, embeds, components, username, avatar_url }, reference }] }. */
const toBackup = (messages) => ({
    messages: messages.map((m) => {
        const data = toApi(m.draft);
        if (data.components === null) delete data.components;
        if (m.username) data.username = m.username;
        if (m.avatarUrl) data.avatar_url = m.avatarUrl;
        return { data, ...(m.ref?.url ? { reference: m.ref.url } : {}) };
    }),
});

/** Pasted JSON → [{ msg, username, avatarUrl, reference }]: a backup, Discohook's share data, or one message. */
const fromBackup = (text) => {
    const v = JSON.parse(text);
    const list = Array.isArray(v?.messages) ? v.messages : v?.data?.messages || null;
    if (!list) {
        const one = fromJson(text);
        const raw = v?.data || v;
        return [{ msg: one, username: raw?.username || "", avatarUrl: raw?.avatar_url || "", reference: null }];
    }
    if (!list.length) throw new Error("The backup has no messages");
    if (list.length > MAX_MESSAGES) throw new Error(`${list.length} messages — at most ${MAX_MESSAGES}`);
    return list.map((x) => {
        const d = x?.data || x || {};
        return { msg: { content: d.content || "", embeds: d.embeds || [], components: d.components || [], images: d.images || [] }, username: d.username || "", avatarUrl: d.avatar_url || "", reference: typeof x?.reference === "string" ? x.reference : null };
    });
};

function JsonModal({ messages, onClose, onApply }) {
    const [text, setText] = useState(() => JSON.stringify(toBackup(messages), null, 2));
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const apply = async () => {
        setBusy(true);
        try {
            await onApply(fromBackup(text));
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };
    return (
        <Modal title="Messages JSON" onClose={onClose} width={700}>
            <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "0 0 10px", lineHeight: 1.5 }}>
                Discohook's backup format — every message with its name, avatar and (for an edit) its link. Paste one here (a backup, a single message or an embed) and press Apply, or copy this one out. A message's link (reference) opens it for editing.
            </p>
            <textarea
                className="input mono"
                value={text}
                onChange={(e) => {
                    setText(e.target.value);
                    setError("");
                }}
                spellCheck={false}
                style={{ width: "100%", minHeight: 360, fontSize: 12, lineHeight: 1.5, resize: "vertical" }}
            />
            {error && (
                <div style={{ marginTop: 10 }}>
                    <Notice tone="danger">{error}</Notice>
                </div>
            )}
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
                <button className="btn-primary" onClick={apply} disabled={busy}>
                    {busy ? "Opening links…" : "Apply"}
                </button>
            </div>
        </Modal>
    );
}

function SaveModal({ current, onClose, onSave, busy }) {
    const [name, setName] = useState(current?.name || "");
    return (
        <Modal title={current ? "Save messages" : "Save as new"} onClose={onClose} width={420}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    onSave(name.trim(), false);
                }}
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
                <Field label="Name" hint="The messages, the webhook, the options and pictures added by link are saved together. Uploaded files are not, and messages being edited are saved as new ones.">
                    <input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="Weekly sale" autoFocus />
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

function CreateWebhookModal({ channels, onClose, onCreated }) {
    const [channelId, setChannelId] = useState("");
    const [name, setName] = useState("");
    const [avatarUrl, setAvatarUrl] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const groups = useMemo(() => {
        const out = [];
        for (const c of channels.filter((x) => x.type !== "voice" && x.type !== "stage")) {
            const key = c.parentId || "";
            let g = out.find((x) => x.key === key);
            if (!g) out.push((g = { key, name: c.parent || "No category", list: [] }));
            g.list.push(c);
        }
        return out;
    }, [channels]);
    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            // The bus, then up to 20 s for the selfbot: the server gives up after 45 s.
            const { data } = await api.post("/webhooks/webhooks", { channelId, name, avatarUrl }, { timeout: 60_000 });
            onCreated(data);
        } catch (err) {
            setError(errMsg(err, "Could not make the webhook"));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Modal title="New webhook" onClose={onClose} width={460}>
            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0, lineHeight: 1.5 }}>
                    ArnTo-selfbot makes it with its own account, so it is an ordinary webhook (Server Settings → Integrations shows it) and is ready to use here at once. ArnTo-assistant asks it with a silent command in that channel and deletes the command right after (in a forum: a short-lived post). It can take up to 20 seconds.
                </p>
                <Field label="Channel">
                    <select className="input" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                        <option value="">Pick a channel…</option>
                        {groups.map((g) => (
                            <optgroup key={g.key} label={g.name}>
                                {g.list.map((c) => (
                                    <option key={c.id} value={c.id}>
                                        {channelLabel(c)}
                                        {c.webhooks.length ? ` (${c.webhooks.length} webhook${c.webhooks.length === 1 ? "" : "s"})` : ""}
                                    </option>
                                ))}
                            </optgroup>
                        ))}
                    </select>
                </Field>
                <Field label="Name" hint="Its default name — each message can still use another.">
                    <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="ArnTo Shop" />
                </Field>
                <Field label="Avatar link (optional)">
                    <input className="input" value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://…/logo.png" />
                </Field>
                {error && <Notice tone="danger">{error}</Notice>}
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button type="submit" className="btn-primary" disabled={busy || !channelId || !name.trim()}>
                        {busy ? "Making…" : "Make webhook"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

// ── Sent / Saved / Webhooks ──────────────────────────────────────────────────

const STATUS = { sent: { text: "Sent", tone: "success" }, deleted: { text: "Deleted", tone: "neutral" } };

function SentTab({ rows, loading, error, canEdit, busy, onEdit, onCopy, onDelete, onForget }) {
    if (loading) return <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>;
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {error && <Notice tone="danger">{error}</Notice>}
            {rows.length > 0 && <p style={{ color: "var(--text-muted)", fontSize: 12, margin: 0 }}>Kept for 3 days after a message was last sent, edited or deleted — it stays on Discord.</p>}
            {!rows.length ? (
                <EmptyState icon="send" title="Nothing sent yet" description="Messages sent from this page, and messages edited here by their link, are listed here for 3 days." />
            ) : (
                <DataTable minWidth={900} columns={["Sent", "Where", "Message", "As", "By", "Status", ""]}>
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
                                    {r.threadName && <div className="cell-sub">› {r.threadName}</div>}
                                </td>
                                <td className="top" style={{ maxWidth: 320, fontSize: 12, wordBreak: "break-word" }}>
                                    {snippet(r.message, 120)}
                                    {r.attachments?.length > 0 && <div className="cell-sub">{r.attachments.length} file{r.attachments.length === 1 ? "" : "s"}</div>}
                                </td>
                                <td className="nowrap top">
                                    {r.username || r.webhookName}
                                    {r.username && <div className="cell-sub">{r.webhookName}</div>}
                                </td>
                                <td className="nowrap top">
                                    {byText(r.sentBy)}
                                    {r.editedBy && <div className="cell-sub">edit: {byText(r.editedBy)}</div>}
                                </td>
                                <td className="top">
                                    <StatusBadge tone={s.tone}>{s.text}</StatusBadge>
                                    {r.status === "deleted" && <div className="cell-sub">by {byText(r.deletedBy)}</div>}
                                </td>
                                <td className="actions top">
                                    <div className="row-actions">
                                        {r.url && r.status === "sent" && (
                                            <a className="btn-ghost btn-sm" href={r.url} target="_blank" rel="noreferrer" title="Open in Discord">
                                                <Icon name="externalLink" size={13} />
                                            </a>
                                        )}
                                        {canEdit && r.status === "sent" && (
                                            <button className="btn-ghost btn-sm" disabled={busy === r.id} onClick={() => onEdit(r)} title="Edit this message on Discord">
                                                <Icon name="pencil" size={13} /> Edit
                                            </button>
                                        )}
                                        <button className="btn-ghost btn-sm" onClick={() => onCopy(r)} title="Copy into the editor as a new message">
                                            <Icon name="copy" size={13} />
                                        </button>
                                        {canEdit && r.status === "sent" && (
                                            <button className="btn-ghost btn-sm is-danger" disabled={busy === r.id} onClick={() => onDelete(r)} title="Delete on Discord">
                                                <Icon name="trash" size={13} />
                                            </button>
                                        )}
                                        {canEdit && r.status !== "sent" && (
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
                <EmptyState icon="archive" title="No saved messages" description="Save the messages in the editor to reuse them later — a weekly announcement, a price list…" />
            ) : (
                <DataTable minWidth={720} columns={["Name", "Messages", "Updated", ""]}>
                    {drafts.map((d) => (
                        <tr key={d.id}>
                            <td className="top" style={{ fontWeight: 500 }}>
                                {d.name}
                                {d.id === currentId && <div className="cell-sub">open in the editor</div>}
                            </td>
                            <td className="top" style={{ maxWidth: 380, fontSize: 12, wordBreak: "break-word" }}>
                                {snippet(toApi(d.messages?.[0]?.draft || {}), 110)}
                                {d.messages?.length > 1 && <div className="cell-sub">{d.messages.length} messages</div>}
                            </td>
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

function WebhooksTab({ targets, current, canEdit, canCreate, onUse, onNew }) {
    const channels = (targets?.channels || []).filter((c) => c.webhooks.length);
    const total = channels.reduce((n, c) => n + c.webhooks.length, 0);
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <p style={{ color: "var(--text-muted)", fontSize: 12, margin: 0, flex: 1 }}>
                    {total} webhook{total === 1 ? "" : "s"} in {targets?.guild?.name || "the shop's server"}
                    {targets?.loadedAt ? ` · loaded ${ago(targets.loadedAt)}` : ""}. One made by another app (another bot, Discohook's bot) cannot be used: Discord does not give its token to the bot.
                </p>
                {canEdit && canCreate && (
                    <button className="btn-ghost btn-sm" onClick={onNew}>
                        <Icon name="plus" size={13} /> New webhook
                    </button>
                )}
            </div>
            {!total ? (
                <EmptyState icon="webhook" title="No webhooks" description={targets?.loadedAt ? "This server has no webhooks yet — make one." : "The list has not been loaded yet — press Reload on the Compose tab."} />
            ) : (
                <DataTable minWidth={780} columns={["Webhook", "Channel", "Made by", "Use", ""]}>
                    {channels.flatMap((c) =>
                        c.webhooks.map((w) => (
                            <tr key={w.id}>
                                <td className="top">
                                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                        <Avatar src={w.avatar} />
                                        <div style={{ minWidth: 0 }}>
                                            <div style={{ fontWeight: 500 }}>{w.name}</div>
                                            <div className="cell-sub mono">{w.id}</div>
                                        </div>
                                    </div>
                                </td>
                                <td className="nowrap top">
                                    {channelLabel(c)}
                                    {c.parent && <div className="cell-sub">{c.parent}</div>}
                                </td>
                                <td className="nowrap top">
                                    {w.creator?.tag || "—"}
                                    {w.createdAt && <div className="cell-sub">{fmtDate(w.createdAt)}</div>}
                                </td>
                                <td className="top" style={{ maxWidth: 260, whiteSpace: "normal" }}>
                                    {w.usable ? <StatusBadge tone="success">Usable</StatusBadge> : <StatusBadge tone="neutral">Cannot be used</StatusBadge>}
                                    {w.why && <div className="cell-sub" style={{ whiteSpace: "normal" }}>{w.why}</div>}
                                </td>
                                <td className="actions top">
                                    {canEdit && w.usable && (
                                        <button className="btn-ghost btn-sm" disabled={current === w.id} onClick={() => onUse(w.id)}>
                                            {current === w.id ? "In use" : "Use"}
                                        </button>
                                    )}
                                </td>
                            </tr>
                        )),
                    )}
                </DataTable>
            )}
        </div>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function WebhooksPage() {
    const { canEdit } = usePageAccess("webhooks");
    const stored = useMemo(readStore, []);
    const [tab, setTab] = useState("compose");
    const [status, setStatus] = useState(null);
    const [statusError, setStatusError] = useState("");
    const [targets, setTargets] = useState(null);
    const [targetsError, setTargetsError] = useState("");
    const [loadingTargets, setLoadingTargets] = useState(false);

    const [doc, setDoc] = useState(() => (stored ? { ...defaultDoc(), ...stored, options: { ...defaultOptions(), ...stored.options } } : defaultDoc()));
    const [active, setActive] = useState(0);
    const [closed, setClosed] = useState({}); // message key → folded
    const [files, setFiles] = useState({}); // message key → [{ id, file, name, url, image, size }] — never stored
    const [savedRef, setSavedRef] = useState(() => stored?.savedRef || null);
    const [editorKey, setEditorKey] = useState(0);
    const [busy, setBusy] = useState(null);
    const [results, setResults] = useState(null);

    const [sent, setSent] = useState([]);
    const [sentLoading, setSentLoading] = useState(true);
    const [sentError, setSentError] = useState("");
    const [drafts, setDrafts] = useState([]);
    const [draftsLoading, setDraftsLoading] = useState(true);
    const [draftsError, setDraftsError] = useState("");

    const [modal, setModal] = useState(null); // "link" | "json" | "save" | "create" | "pick"
    const [linkFor, setLinkFor] = useState(null); // the message key a "Set Link" is for
    const [confirm, setConfirm] = useState(null);

    const index = Math.min(active, doc.messages.length - 1);

    useEffect(() => writeStore({ ...doc, savedRef }), [doc, savedRef]);

    // Picture previews live as object URLs: let them go with the page.
    const filesRef = useRef(files);
    filesRef.current = files;
    useEffect(() => () => Object.values(filesRef.current).flat().forEach((f) => URL.revokeObjectURL(f.url)), []);

    // ── Loading ──
    const loadStatus = useCallback(async () => {
        try {
            const { data } = await api.get("/webhooks/status");
            setStatus(data);
            setStatusError("");
        } catch (err) {
            setStatusError(errMsg(err, "Could not load the page"));
        }
    }, []);

    const loadTargets = useCallback(async () => {
        try {
            const { data } = await api.get("/webhooks/targets");
            setTargets(data);
            setTargetsError("");
        } catch (err) {
            setTargetsError(errMsg(err, "Could not read the webhook list"));
        }
    }, []);

    const reloadTargets = async () => {
        setLoadingTargets(true);
        try {
            const { data } = await api.post("/webhooks/targets/reload", null, SLOW);
            setTargets(data);
            setTargetsError("");
        } catch (err) {
            setTargetsError(errMsg(err, "Could not reload the webhook list"));
            loadTargets();
        } finally {
            setLoadingTargets(false);
        }
    };

    const loadSent = useCallback(async () => {
        try {
            const { data } = await api.get("/webhooks/sent");
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
            const { data } = await api.get("/webhooks/drafts");
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

    const channels = targets?.channels || [];
    const webhookOf = (id) => {
        for (const c of channels) {
            const w = c.webhooks.find((x) => x.id === id);
            if (w) return w;
        }
        return null;
    };
    const targetWebhook = webhookOf(doc.target.webhookId);

    // ── Editing the document ──
    const setMessages = (fn) => setDoc((d) => ({ ...d, messages: fn(d.messages) }));
    const patchMessage = (key, patch) => setMessages((list) => list.map((m) => (m.key === key ? { ...m, ...patch } : m)));
    const setTarget = (target) => setDoc((d) => ({ ...d, target }));
    const setOptions = (options) => setDoc((d) => ({ ...d, options }));

    const dropFiles = (key) =>
        setFiles((f) => {
            (f[key] || []).forEach((x) => URL.revokeObjectURL(x.url));
            const { [key]: _gone, ...rest } = f;
            return rest;
        });

    const replaceMessages = (list, { pick = 0 } = {}) => {
        doc.messages.forEach((m) => dropFiles(m.key));
        setMessages(() => list);
        setActive(pick);
        setClosed({});
        setEditorKey((k) => k + 1);
        setResults(null);
        setTab("compose");
    };

    /** Put a message in the editor: in place of `key` (Set Link), in the open one when it is empty, else as a new one. */
    const placeMessage = (m, key = null) => {
        const at = key ? doc.messages.findIndex((x) => x.key === key) : -1;
        const cur = at >= 0 ? doc.messages[at] : doc.messages[index];
        if (at >= 0 || (cur && emptyMessage(cur, files) && !cur.ref)) {
            dropFiles(cur.key);
            setMessages((list) => list.map((x) => (x.key === cur.key ? m : x)));
            setActive(at >= 0 ? at : index);
        } else if (doc.messages.length >= MAX_MESSAGES) {
            throw new Error(`At most ${MAX_MESSAGES} messages — remove one first`);
        } else {
            setMessages((list) => [...list, m]);
            setActive(doc.messages.length);
        }
        setEditorKey((k) => k + 1);
        setResults(null);
        setTab("compose");
    };

    const addFiles = (key, list) => {
        const m = doc.messages.find((x) => x.key === key);
        const own = files[key] || [];
        const kept = m?.ref ? m.ref.keep.length : 0;
        const linked = m?.draft.images || [];
        const room = MAX_FILES - kept - own.length - linked.length;
        if (list.length > room) alert(`At most ${MAX_FILES} files per message — ${list.length - Math.max(room, 0)} left out.`);
        const taken = new Set([...own.map((f) => f.name), ...(m?.ref?.attachments || []).map((a) => a.filename), ...linked.map((x) => x.name)]);
        const add = [];
        let bytes = own.reduce((n, f) => n + f.size, 0);
        for (const file of list.slice(0, Math.max(room, 0))) {
            if (bytes + file.size > MAX_BYTES) {
                alert(`${file.name} does not fit — at most ${MAX_BYTES / 1048576} MB of files per message.`);
                continue;
            }
            let name = fileName(file.name, own.length + add.length);
            for (let n = 2; taken.has(name); n++) name = fileName(file.name, 0).replace(/(\.[^.]*)?$/, `-${n}$1`);
            taken.add(name);
            bytes += file.size;
            add.push({ id: newKey(), file, name, url: URL.createObjectURL(file), image: isImage(name, file.type), size: file.size });
        }
        if (add.length) setFiles((f) => ({ ...f, [key]: [...(f[key] || []), ...add] }));
    };

    const removeFile = (key, id) =>
        setFiles((f) => {
            const gone = (f[key] || []).find((x) => x.id === id);
            if (gone) URL.revokeObjectURL(gone.url);
            return { ...f, [key]: (f[key] || []).filter((x) => x.id !== id) };
        });

    // ── Messages ──
    const addMessage = () => {
        setMessages((list) => [...list, newMessage()]);
        setActive(doc.messages.length);
    };
    const duplicateMessage = (i) => {
        const m = doc.messages[i];
        const copy = newMessage({ draft: JSON.parse(JSON.stringify(m.draft)), username: m.username, avatarUrl: m.avatarUrl });
        if (copy.draft.components === null) copy.draft.components = editorLinkRows(m.ref?.lockedComponents);
        setMessages((list) => [...list.slice(0, i + 1), copy, ...list.slice(i + 1)]);
        setActive(i + 1);
    };
    const moveMessage = (i, d) => {
        const j = i + d;
        if (j < 0 || j >= doc.messages.length) return;
        setMessages((list) => {
            const next = [...list];
            [next[i], next[j]] = [next[j], next[i]];
            return next;
        });
        setActive(j);
    };
    const removeMessage = (i) => {
        const m = doc.messages[i];
        dropFiles(m.key);
        if (doc.messages.length === 1) {
            setMessages(() => [newMessage()]);
            setEditorKey((k) => k + 1);
            return;
        }
        setMessages((list) => list.filter((x) => x.key !== m.key));
        setActive(Math.max(0, i - 1));
    };
    const unlink = (m) =>
        patchMessage(m.key, {
            ref: null,
            draft: m.draft.components === null ? { ...m.draft, components: editorLinkRows(m.ref.lockedComponents) } : m.draft,
        });

    const clearAll = () => {
        replaceMessages([newMessage()]);
        setSavedRef(null);
    };

    // ── Opening messages ──
    const editMessageFrom = (res, key = null) => {
        const m = newMessage({ draft: toEditor({ ...res.message, components: res.keepsComponents ? null : res.message.components }), ref: refOf(res) });
        placeMessage(m, key);
        setModal(null);
        setLinkFor(null);
    };

    const copyMessageFrom = (msg, { username = "", avatarUrl = "", webhookId, key = null } = {}) => {
        const rows = msg.components === null ? [] : msg.components || [];
        placeMessage(newMessage({ draft: toEditor({ ...msg, components: onlyLinkButtons(rows) ? rows : linkRowsOnly(rows) }), username, avatarUrl }), key);
        if (webhookId && webhookOf(webhookId)?.usable) setTarget({ ...doc.target, webhookId });
        setModal(null);
        setLinkFor(null);
    };

    const editSentRow = async (row) => {
        setBusy(row.id);
        try {
            const { data } = await api.get("/webhooks/message", { params: { webhookId: row.webhookId, messageId: row.messageId, threadId: row.threadId || undefined }, ...SLOW });
            if (!data.editable) throw new Error(data.why || "It cannot be edited here");
            editMessageFrom(data);
        } catch (err) {
            alert(errMsg(err, "Could not open the message"));
        } finally {
            setBusy(null);
        }
    };

    const applyJson = async (list) => {
        const out = [];
        const failed = [];
        for (const x of list) {
            if (!x.reference) {
                if (!onlyLinkButtons(x.msg.components || [])) throw new Error("Only link buttons can be sent through a webhook — remove the other buttons and menus from the JSON.");
                out.push(newMessage({ draft: toEditor(x.msg), username: x.username, avatarUrl: x.avatarUrl }));
                continue;
            }
            try {
                const { data } = await api.get("/webhooks/fetch", { params: { link: x.reference }, ...SLOW });
                if (!data.editable) throw new Error(data.why);
                const ref = refOf(data);
                out.push(newMessage({ draft: toEditor({ ...x.msg, components: data.keepsComponents ? null : x.msg.components }), ref }));
            } catch (err) {
                failed.push(`${x.reference}: ${errMsg(err, "cannot be opened")}`);
                out.push(newMessage({ draft: toEditor({ ...x.msg, components: linkRowsOnly(x.msg.components) }), username: x.username, avatarUrl: x.avatarUrl }));
            }
        }
        replaceMessages(out);
        setModal(null);
        if (failed.length) alert(`These links were not opened for editing — their messages are in the editor as new ones:\n\n${failed.join("\n")}`);
    };

    // ── Sending ──
    const doSend = async () => {
        setBusy("send");
        setResults(null);
        const { target, options } = doc;
        const channel = channels.find((c) => c.webhooks.some((w) => w.id === target.webhookId));
        const posts = channel && (channel.type === "forum" || channel.type === "media");
        let threadId = posts ? (target.mode === "existing" ? threadIdOf(target.thread) : null) : threadIdOf(target.thread);
        let threadName = posts && target.mode !== "existing" ? target.threadName.trim() : null;
        const out = [];
        const updates = {};
        let stopped = false;
        for (let i = 0; i < doc.messages.length; i++) {
            const m = doc.messages[i];
            const n = i + 1;
            if (stopped) {
                out.push({ n, tone: "neutral", text: "not sent (an earlier message failed)" });
                continue;
            }
            if (emptyMessage(m, files)) {
                out.push({ n, tone: "neutral", text: "empty — skipped" });
                continue;
            }
            const own = files[m.key] || [];
            const form = new FormData();
            own.forEach((f) => form.append("files", f.file, f.name));
            try {
                if (m.ref) {
                    form.append(
                        "payload",
                        JSON.stringify({
                            webhookId: m.ref.webhookId,
                            messageId: m.ref.messageId,
                            threadId: m.ref.threadId,
                            threadLabel: m.ref.threadName,
                            message: toApi(m.draft),
                            mentions: options.mentions,
                            keepAttachments: m.ref.keep,
                            files: own.map((f) => ({ name: f.name })),
                        }),
                    );
                    const { data } = await api.post("/webhooks/edit", form, UPLOAD);
                    // Its pictures by link are files of the message now, listed with the kept ones.
                    updates[m.key] = { ref: { ...m.ref, attachments: data.attachments || [], keep: (data.attachments || []).map((a) => a.id) } };
                    out.push({ n, tone: "success", text: "saved.", url: data.url });
                } else {
                    form.append(
                        "payload",
                        JSON.stringify({
                            webhookId: target.webhookId,
                            threadId,
                            threadName,
                            message: toApi(m.draft),
                            username: m.username,
                            avatarUrl: m.avatarUrl,
                            mentions: options.mentions,
                            silent: options.silent,
                            suppressEmbeds: options.suppressEmbeds,
                            files: own.map((f) => ({ name: f.name })),
                        }),
                    );
                    const { data } = await api.post("/webhooks/send", form, UPLOAD);
                    // The rest of this send goes into the post the first message opened.
                    if (threadName && data.threadId) {
                        threadId = data.threadId;
                        threadName = null;
                    }
                    out.push({ n, tone: "success", text: `sent${data.threadName ? ` in ${data.threadName}` : ""}.`, url: data.url, row: data, key: m.key });
                }
            } catch (err) {
                out.push({ n, tone: "danger", text: errMsg(err, "failed") });
                stopped = true;
            }
        }
        setMessages((list) => list.map((m) => (updates[m.key] ? { ...m, ref: updates[m.key].ref, draft: { ...m.draft, images: [] } } : m)));
        Object.keys(updates).forEach(dropFiles);
        setResults(out);
        setBusy(null);
        loadSent();
    };

    const onSend = () => {
        const pinged = doc.messages
            .filter((m) => !m.ref && !emptyMessage(m, files))
            .some((m) => {
                const p = pingsOf(m.draft.content);
                return (doc.options.mentions.everyone && (p.everyone || p.here)) || (doc.options.mentions.roles && p.roles.length);
            });
        if (pinged && !doc.options.silent) {
            setConfirm({
                title: "Send and ping?",
                message: `These messages ping @everyone, @here or roles${targets?.guild ? ` in ${targets.guild.name}` : ""}.`,
                confirmText: "Send",
                danger: true,
                run: doSend,
            });
        } else doSend();
    };

    /** After a send: the messages it posted become edits of themselves. */
    const editWhatWasSent = () => {
        const rows = new Map((results || []).filter((r) => r.row).map((r) => [r.key, r.row]));
        setMessages((list) =>
            list.map((m) => {
                const row = rows.get(m.key);
                if (!row) return m;
                const w = webhookOf(row.webhookId);
                return {
                    ...m,
                    ref: refOf({ ...row, webhook: { id: row.webhookId, name: row.webhookName }, author: { username: row.username || row.webhookName, avatar: row.avatarUrl || w?.avatar || null } }),
                    draft: { ...m.draft, images: [] }, // they are files of the message now
                };
            }),
        );
        rows.forEach((_, key) => dropFiles(key));
        setResults(null);
    };

    const deleteSent = (row) =>
        setConfirm({
            title: "Delete this message on Discord?",
            message: `It is removed from #${row.channelName || row.channelId}${row.threadName ? ` › ${row.threadName}` : ""} for everyone. This cannot be undone.`,
            confirmText: "Delete",
            danger: true,
            run: async () => {
                setBusy(row.id);
                try {
                    await api.post("/webhooks/delete", { webhookId: row.webhookId, messageId: row.messageId, threadId: row.threadId }, SLOW);
                    setMessages((list) => list.map((m) => (m.ref?.messageId === row.messageId ? { ...m, ref: null } : m)));
                } catch (err) {
                    alert(errMsg(err, "Could not delete"));
                } finally {
                    setBusy(null);
                    loadSent();
                }
            },
        });

    const forget = async (r) => {
        try {
            await api.delete(`/webhooks/sent/${r.id}`);
            loadSent();
        } catch (err) {
            alert(errMsg(err, "Could not remove it"));
        }
    };

    // ── Saved ──
    const saveDraft = async (name, asNew) => {
        setBusy("save");
        const payload = {
            name,
            messages: doc.messages.map((m) => ({ draft: m.draft.components === null ? { ...m.draft, components: editorLinkRows(m.ref?.lockedComponents) } : m.draft, username: m.username, avatarUrl: m.avatarUrl })),
            target: { webhookId: doc.target.webhookId, threadId: doc.target.thread || null, threadName: doc.target.threadName || null },
            options: doc.options,
        };
        try {
            const { data } = savedRef && !asNew ? await api.put(`/webhooks/drafts/${savedRef.id}`, payload) : await api.post("/webhooks/drafts", payload);
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
        replaceMessages((d.messages || []).map((m) => newMessage({ draft: m.draft || emptyDraft(), username: m.username || "", avatarUrl: m.avatarUrl || "" })));
        const t = d.target || {};
        setDoc((x) => ({
            ...x,
            target: { webhookId: t.webhookId || x.target.webhookId, mode: t.threadName ? "new" : t.threadId ? "existing" : x.target.mode, thread: t.threadId || "", threadName: t.threadName || "" },
            options: { ...defaultOptions(), ...d.options },
        }));
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
                    await api.delete(`/webhooks/drafts/${d.id}`);
                    if (savedRef?.id === d.id) setSavedRef(null);
                    loadDrafts();
                } catch (err) {
                    alert(errMsg(err, "Could not delete"));
                }
            },
        });

    // ── Preview ──
    const previews = useMemo(
        () =>
            doc.messages.map((m) => {
                const msg = toApi(m.draft);
                if (m.draft.components === null) msg.components = m.ref?.lockedComponents || [];
                const list = [
                    ...(m.ref?.attachments || []).filter((a) => m.ref.keep.includes(a.id)).map((a) => ({ name: a.filename, url: a.url, image: isImage(a.filename, a.contentType), size: a.size })),
                    ...(files[m.key] || []).map((f) => ({ name: f.name, url: f.url, image: f.image, size: f.size })),
                    ...(m.draft.images || []).map((x) => ({ name: x.name, url: x.url, image: true })),
                ];
                const byName = new Map(list.map((f) => [f.name, f.url]));
                const used = new Set();
                const fix = (u) => {
                    if (typeof u !== "string" || !u.startsWith("attachment://")) return u;
                    const name = u.slice(13);
                    used.add(name);
                    return byName.get(name) || u;
                };
                msg.embeds = (msg.embeds || []).map((e) => ({
                    ...e,
                    ...(e.image ? { image: { url: fix(e.image.url) } } : {}),
                    ...(e.thumbnail ? { thumbnail: { url: fix(e.thumbnail.url) } } : {}),
                    ...(e.author ? { author: { ...e.author, icon_url: fix(e.author.icon_url) } } : {}),
                    ...(e.footer ? { footer: { ...e.footer, icon_url: fix(e.footer.icon_url) } } : {}),
                }));
                const bot = m.ref
                    ? { username: m.ref.author?.username || m.ref.webhookName || "Webhook", avatar: m.ref.author?.avatar || null }
                    : { username: m.username.trim() || targetWebhook?.name || "Webhook", avatar: m.avatarUrl.trim() || targetWebhook?.avatar || null };
                return { key: m.key, msg, bot, files: list.filter((f) => !used.has(f.name)), edited: !!m.ref };
            }),
        [doc.messages, files, targetWebhook],
    );

    const notReady = status && !status.can?.list;
    const guildRoles = targets?.guild?.roles || [];
    const compose = tab === "compose";

    return (
        <div className={`fade-in page${compose ? " dh-page" : ""}`} style={compose ? undefined : { maxWidth: 1500, display: "flex", flexDirection: "column", gap: 16 }}>
            <PageHeader
                title="Webhooks"
                description="Like Discohook — messages with any name and picture, embeds, link buttons and files — sent through the shop server's webhooks. No URL to paste: pick a webhook, or paste a message's link to edit it."
            />

            {statusError && <Notice tone="danger">{statusError}</Notice>}
            {notReady && (
                <Notice>
                    ArnTo-assistant has not announced <code className="mono">webhook.list</code> yet — update it (Pull &amp; Update) and restart it. Until then the webhook list cannot load.
                </Notice>
            )}
            {status && status.can?.list && !status.busReady && <Notice>The panel's Discord bus is not ready — the list and links wait until it is. Sending still works.</Notice>}

            <div className="toolbar">
                <div className="tab-bar">
                    {[
                        ["compose", "Compose"],
                        ["sent", `Sent (${sent.length})`],
                        ["saved", `Saved (${drafts.length})`],
                        ["webhooks", `Webhooks (${channels.reduce((n, c) => n + c.webhooks.length, 0)})`],
                    ].map(([id, label]) => (
                        <button key={id} className={`tab-item ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
                            {label}
                        </button>
                    ))}
                </div>
                {compose && savedRef && (
                    <span className="toolbar-count">
                        Saved: <strong style={{ color: "var(--text-muted)" }}>{savedRef.name}</strong>
                    </span>
                )}
            </div>

            {compose && (
                <div className="dh dh-split">
                    <div className="dh-pane dh-editor">
                        <TopBar
                            status={status}
                            targets={targets}
                            targetsError={targetsError}
                            loadingTargets={loadingTargets}
                            onReload={reloadTargets}
                            doc={doc}
                            setTarget={setTarget}
                            setOptions={setOptions}
                            files={files}
                            onSend={onSend}
                            onPickWebhook={() => setModal("pick")}
                            onNewWebhook={() => setModal("create")}
                            onLink={() => {
                                setLinkFor(null);
                                setModal("link");
                            }}
                            onJson={() => setModal("json")}
                            onSave={() => setModal("save")}
                            savedRef={savedRef}
                            onClear={clearAll}
                            busy={busy}
                            results={results}
                            onEditSent={editWhatWasSent}
                            canEdit={canEdit}
                        />
                        {doc.messages.map((m, i) => (
                            <MessageStrip
                                key={m.key}
                                m={m}
                                i={i}
                                count={doc.messages.length}
                                open={!closed[m.key]}
                                onToggle={(o) => {
                                    setClosed((c) => ({ ...c, [m.key]: !o }));
                                    if (o) setActive(i);
                                }}
                                files={files}
                                webhook={targetWebhook}
                                roles={guildRoles}
                                channels={channels}
                                editorKey={editorKey}
                                canEdit={canEdit}
                                onPatch={(patch) => patchMessage(m.key, patch)}
                                onMove={(d) => moveMessage(i, d)}
                                onDuplicate={() => duplicateMessage(i)}
                                onRemove={() => removeMessage(i)}
                                onSetLink={() => {
                                    setLinkFor(m.key);
                                    setModal("link");
                                }}
                                onUnlink={() => unlink(m)}
                                onDeleteOnDiscord={() => deleteSent({ ...m.ref, id: m.key })}
                                onAddFiles={(list) => addFiles(m.key, list)}
                                onRemoveFile={(id) => removeFile(m.key, id)}
                                onToggleKeep={(id) => patchMessage(m.key, { ref: { ...m.ref, keep: m.ref.keep.includes(id) ? m.ref.keep.filter((x) => x !== id) : [...m.ref.keep, id] } })}
                            />
                        ))}
                        <div className="dh-pad">
                            <button className="dh-btn primary block" onClick={addMessage} disabled={doc.messages.length >= MAX_MESSAGES} title={`Up to ${MAX_MESSAGES} messages, sent in this order`}>
                                <Icon name="message" size={16} /> Add Message
                            </button>
                        </div>
                    </div>
                    <div className="dh-pane dh-preview">
                        {previews.map((p, i) => (
                            <div key={p.key} className={`dh-preview-item${i === index && previews.length > 1 ? " active" : ""}`} onClick={() => setActive(i)}>
                                <MessagePreview msg={p.msg} bot={p.bot} files={p.files} roles={guildRoles} channels={channels} edited={p.edited} />
                            </div>
                        ))}
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
                    onEdit={editSentRow}
                    onCopy={(r) => {
                        try {
                            copyMessageFrom(r.message || {}, { username: r.username || "", avatarUrl: r.avatarUrl || "", webhookId: r.webhookId });
                        } catch (err) {
                            alert(err.message);
                        }
                    }}
                    onDelete={deleteSent}
                    onForget={forget}
                />
            )}

            {tab === "saved" && <SavedTab drafts={drafts} loading={draftsLoading} error={draftsError} canEdit={canEdit} currentId={savedRef?.id} onLoad={openDraft} onDelete={removeDraft} />}

            {tab === "webhooks" && (
                <WebhooksTab
                    targets={targets}
                    current={doc.target.webhookId}
                    canEdit={canEdit}
                    canCreate={!!status?.can?.create}
                    onUse={(id) => {
                        setTarget({ ...doc.target, webhookId: id });
                        setTab("compose");
                    }}
                    onNew={() => setModal("create")}
                />
            )}

            {modal === "pick" && (
                <WebhookPicker
                    channels={channels}
                    current={doc.target.webhookId}
                    canCreate={canEdit && !!status?.can?.create}
                    onNew={() => setModal("create")}
                    onClose={() => setModal(null)}
                    onPick={(id) => {
                        setTarget({ ...doc.target, webhookId: id });
                        setModal(null);
                    }}
                />
            )}
            {modal === "link" && (
                <LinkModal
                    forMessage={linkFor ? doc.messages.findIndex((m) => m.key === linkFor) + 1 || null : null}
                    onClose={() => {
                        setModal(null);
                        setLinkFor(null);
                    }}
                    canEdit={canEdit}
                    onEdit={(res) => {
                        try {
                            editMessageFrom(res, linkFor);
                        } catch (err) {
                            alert(err.message);
                        }
                    }}
                    onCopy={(res) => {
                        try {
                            // Its pictures come along by their Discord links (good for about a day).
                            copyMessageFrom(
                                { ...res.message, images: picturesOf(res.attachments).slice(0, MAX_FILES) },
                                { ...(res.kind === "webhook" || res.kind === "gone" ? { username: res.author?.username || "", avatarUrl: res.author?.avatar || "" } : {}), key: linkFor },
                            );
                        } catch (err) {
                            alert(err.message);
                        }
                    }}
                    onUseWebhook={(res) => {
                        setTarget({ ...doc.target, webhookId: res.webhook.id });
                        loadTargets();
                        setModal(null);
                    }}
                />
            )}
            {modal === "json" && <JsonModal messages={doc.messages} onClose={() => setModal(null)} onApply={applyJson} />}
            {modal === "save" && <SaveModal current={savedRef} busy={busy === "save"} onClose={() => setModal(null)} onSave={saveDraft} />}
            {modal === "create" && (
                <CreateWebhookModal
                    channels={channels}
                    onClose={() => setModal(null)}
                    onCreated={(w) => {
                        setModal(null);
                        setTarget({ ...doc.target, webhookId: w.id });
                        loadTargets();
                    }}
                />
            )}

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
