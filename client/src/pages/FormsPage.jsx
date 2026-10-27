import { useCallback, useEffect, useState } from "react";
import api from "../api/client";
import { useAuth, usePageAccess } from "../context/AuthContext";
import ConfirmModal from "../components/ConfirmModal";
import { Markdown, PreviewLookup } from "../components/messages/DiscordPreview";
import { emojiObject } from "../components/messages/format";
import { EmptyState, Field, Icon, Modal, Notice, PageHeader, Toggle } from "../components/ui";

// ─────────────────────────────────────────────────────────────────────────────
//  Forms — what /form on ArnTo-assistant posts in a ticket: a message with an
//  open button (and a reminder from the shop's own account), the Discord form
//  it opens, and the card only the viewer roles can open once it is sent. What
//  customers type stays in the bot. The logic lives in server/services/formService.js.
// ─────────────────────────────────────────────────────────────────────────────

const errMsg = (err, fallback) => err?.response?.data?.error || err?.message || fallback;
const bytes = (s) => new TextEncoder().encode(String(s || "").trim()).length;

/** The bot's variables, as the preview shows them. */
const fill = (text, vars) => String(text || "").replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));

const IconButton = ({ title, icon, onClick, disabled, danger }) => (
    <button type="button" className={`btn-ghost btn-icon btn-sm${danger ? " is-danger" : ""}`} title={title} aria-label={title} disabled={disabled} onClick={onClick} style={{ border: "none" }}>
        <Icon name={icon} size={14} />
    </button>
);

// ── Discord-like previews ────────────────────────────────────────────────────

function Emoji({ value, size = 18 }) {
    const e = emojiObject(value);
    if (!e) return null;
    if (e.id) return <img src={`https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? "gif" : "webp"}?size=48`} width={size} height={size} alt="" style={{ display: "inline" }} />;
    return <span style={{ fontSize: size - 2, lineHeight: 1 }}>{e.name}</span>;
}

const PreviewButton = ({ label, emoji }) => (
    <span className="dp-button dp-button-primary" style={{ flexShrink: 0 }}>
        <Emoji value={emoji} />
        {label && <span>{label}</span>}
    </span>
);

function Message({ bot, app = true, children }) {
    return (
        <div className="dp-message">
            <div className="dp-header">
                <img className="dp-avatar" src={bot?.avatar || "https://cdn.discordapp.com/embed/avatars/0.png"} alt="" />
                <span className="dp-name">{bot?.displayName || bot?.username || (app ? "ArnTo-assistant" : "Shop account")}</span>
                {app && <span className="dp-bot">APP</span>}
            </div>
            <div className="dp-body">{children}</div>
        </div>
    );
}

/** A Components V2 container: the bot's accent bar, text, a separator. */
const Container = ({ children }) => (
    <div style={{ maxWidth: 520, background: "#2b2d31", borderLeft: "4px solid #5865f2", borderRadius: 8, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
        {children}
    </div>
);
const Separator = () => <div style={{ borderTop: "1px solid #3f4147" }} />;

function TicketPreview({ form, settings, bot }) {
    const vars = { days: String(settings.retentionDays), form: form.name || "" };
    return (
        <div className="dp-root" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Message bot={bot}>
                <Container>
                    <div className="dp-content"><Markdown text={fill(form.message, vars)} /></div>
                    <Separator />
                    {form.note ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                            <div className="dp-content" style={{ flex: "1 1 180px", minWidth: 0 }}><Markdown text={fill(form.note, vars)} /></div>
                            <PreviewButton label={form.buttonLabel} emoji={form.buttonEmoji} />
                        </div>
                    ) : (
                        <div className="dp-row"><PreviewButton label={form.buttonLabel} emoji={form.buttonEmoji} /></div>
                    )}
                </Container>
            </Message>
            {form.selfbotText?.trim() && (
                <Message app={false}>
                    <div className="dp-content"><Markdown text={form.selfbotText} /></div>
                </Message>
            )}
        </div>
    );
}

function ModalPreview({ form }) {
    return (
        <div style={{ background: "#313338", borderRadius: 10, padding: 16, color: "#dbdee1", maxWidth: 440, display: "flex", flexDirection: "column", gap: 14, fontSize: 14 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#f2f3f5" }}>{form.modalTitle || "—"}</div>
            {(form.fields || []).map((f, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ fontWeight: 600, color: "#f2f3f5" }}>
                        {f.label || <span style={{ color: "#949ba4" }}>(no label)</span>}
                        {f.required && <span style={{ color: "#f23f43" }}> *</span>}
                    </div>
                    {f.description && <div style={{ fontSize: 12, color: "#b5bac1" }}>{f.description}</div>}
                    <div style={{ background: "#1e1f22", borderRadius: 6, padding: "8px 10px", color: "#6d6f78", minHeight: f.style === "paragraph" ? 76 : undefined }}>
                        {f.placeholder || " "}
                    </div>
                </div>
            ))}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <span className="dp-button dp-button-secondary">Cancel</span>
                <span className="dp-button dp-button-primary">Submit</span>
            </div>
        </div>
    );
}

function AfterPreview({ form, settings, bot }) {
    const vars = { days: String(settings.retentionDays), form: form.name || "", staff: "@Staff", user: "@Customer" };
    return (
        <div className="dp-root" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Message bot={bot}>
                <Container>
                    <div className="dp-content"><Markdown text={fill(settings.savedText, vars)} /></div>
                    <div className="dp-subtext">+ the answer's ID and who sent it</div>
                    <Separator />
                    <div className="dp-row"><PreviewButton label={settings.viewLabel} emoji={settings.viewEmoji} /></div>
                </Container>
            </Message>
            <Message bot={bot}>
                <div className="dp-content"><Markdown text={fill(settings.doneText, vars)} /></div>
            </Message>
        </div>
    );
}

// ── Editing ──────────────────────────────────────────────────────────────────

let seq = 0;
const withKeys = (fields) => (fields || []).map((f) => ({ ...f, _k: ++seq }));
const emptyField = () => ({ _k: ++seq, label: "", description: "", placeholder: "", style: "short", required: true });
const emptyForm = () => ({
    key: "",
    name: "",
    enabled: true,
    message: "",
    note: "",
    buttonLabel: "",
    buttonEmoji: "",
    modalTitle: "",
    selfbotText: "",
    fields: [emptyField()],
});

function FieldRows({ fields, max, onChange }) {
    const set = (i, k) => (e) => onChange(fields.map((f, j) => (j === i ? { ...f, [k]: e?.target ? (e.target.type === "checkbox" ? e.target.checked : e.target.value) : e } : f)));
    const move = (i, d) => {
        const next = [...fields];
        [next[i], next[i + d]] = [next[i + d], next[i]];
        onChange(next);
    };
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {fields.map((f, i) => (
                <div key={f._k} className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 12, color: "var(--text-dim)", flex: 1 }}>
                            Field {i + 1}
                            {f.id && <span className="mono"> · {f.id}</span>}
                        </span>
                        <IconButton title="Move up" icon="arrowUp" disabled={!i} onClick={() => move(i, -1)} />
                        <IconButton title="Move down" icon="arrowDown" disabled={i === fields.length - 1} onClick={() => move(i, 1)} />
                        <IconButton title="Remove" icon="x" danger disabled={fields.length <= 1} onClick={() => onChange(fields.filter((_, j) => j !== i))} />
                    </div>
                    <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        <input className="input" placeholder="Label (required)" value={f.label} onChange={set(i, "label")} maxLength={45} required />
                        <input className="input" placeholder="Placeholder" value={f.placeholder} onChange={set(i, "placeholder")} maxLength={100} />
                    </div>
                    <input className="input" placeholder="Description (under the label)" value={f.description} onChange={set(i, "description")} maxLength={100} />
                    <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
                        <select className="input" style={{ maxWidth: 200 }} value={f.style} onChange={set(i, "style")}>
                            <option value="short">One line</option>
                            <option value="paragraph">Several lines</option>
                        </select>
                        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <Toggle checked={f.required} onChange={set(i, "required")} /> Required
                        </label>
                    </div>
                </div>
            ))}
            {fields.length < max && (
                <div>
                    <button type="button" className="btn-ghost btn-sm" onClick={() => onChange([...fields, emptyField()])}>
                        <Icon name="plus" size={14} /> Add field
                    </button>
                </div>
            )}
        </div>
    );
}

function FormEditor({ initial, isNew, data, bot, onSave, saving }) {
    const [f, setF] = useState(() => ({ ...emptyForm(), ...initial, fields: initial.fields ? withKeys(initial.fields) : emptyForm().fields }));
    const [preview, setPreview] = useState("ticket");
    const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }));
    const used = bytes(f.selfbotText);
    const tooLong = used > data.limits.selfbotBytes;
    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                onSave({ ...f, fields: f.fields.map(({ _k, ...rest }) => rest) });
            }}
            className="grid-1-mobile"
            style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 420px)", gap: 20, alignItems: "start" }}
        >
            <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
                <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <Field label="Name" hint="What staff pick in /form's type">
                        <input className="input" value={f.name} onChange={set("name")} maxLength={100} placeholder="Google account" autoFocus={isNew} required />
                    </Field>
                    <Field label="Key" hint={isNew ? "a-z, 0-9, - and _ — cannot change later" : "Fixed"}>
                        <input className="input mono" value={f.key} onChange={set("key")} maxLength={32} placeholder="google" disabled={!isNew} required />
                    </Field>
                </div>

                <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>In the ticket</div>
                <Field label="Message" hint={<>Discord markdown. Variables: {data.vars.message.map((v) => <code key={v} className="mono" style={{ marginRight: 6 }}>{v}</code>)}</>}>
                    <textarea className="input mono" rows={6} value={f.message} onChange={set("message")} maxLength={2500} required />
                </Field>
                <Field label="Note beside the button" hint="Empty: the button sits alone under the message">
                    <textarea className="input" rows={3} value={f.note} onChange={set("note")} maxLength={1000} />
                </Field>
                <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <Field label="Button">
                        <input className="input" value={f.buttonLabel} onChange={set("buttonLabel")} maxLength={80} placeholder="Empty: the default label" />
                    </Field>
                    <Field label="Button emoji" hint="A Unicode emoji, or a server emoji: <:name:id>">
                        <input className="input mono" value={f.buttonEmoji} onChange={set("buttonEmoji")} placeholder="📝" />
                    </Field>
                </div>
                <Field
                    label="Reminder from the shop's account"
                    hint={
                        <span style={{ color: tooLong ? "var(--danger)" : undefined }}>
                            Sent by ArnTo-SelfBot right after the form. Empty: none. {used.toLocaleString("en-US")} / {data.limits.selfbotBytes.toLocaleString("en-US")} bytes
                        </span>
                    }
                >
                    <textarea className="input" rows={3} value={f.selfbotText} onChange={set("selfbotText")} />
                </Field>

                <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>The form</div>
                <Field label="Title" hint="At most 45 characters">
                    <input className="input" value={f.modalTitle} onChange={set("modalTitle")} maxLength={45} placeholder="Empty: the default title" />
                </Field>
                <FieldRows fields={f.fields} max={data.limits.fields} onChange={(fields) => setF((x) => ({ ...x, fields }))} />

                <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                    <Toggle checked={f.enabled} onChange={set("enabled")} /> Listed in /form
                </label>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button type="submit" className="btn-primary" disabled={saving || tooLong}>
                        {saving ? "Saving…" : isNew ? "Create form" : "Save"}
                    </button>
                </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, position: "sticky", top: 0, minWidth: 0 }}>
                <div className="tab-bar">
                    {[
                        ["ticket", "Ticket"],
                        ["modal", "Form"],
                    ].map(([id, label]) => (
                        <button key={id} type="button" className={`tab-item ${preview === id ? "active" : ""}`} onClick={() => setPreview(id)}>
                            {label}
                        </button>
                    ))}
                </div>
                {preview === "ticket" ? <TicketPreview form={f} settings={data.settings} bot={bot} /> : <ModalPreview form={f} />}
            </div>
        </form>
    );
}

function SettingsForm({ initial, forms, vars, roleName, onSave, saving }) {
    const [s, setS] = useState({ ...initial, viewerRoles: initial.viewerRoles.length ? initial.viewerRoles : [""] });
    const set = (k) => (e) => setS((x) => ({ ...x, [k]: e?.target ? e.target.value : e }));
    const setRole = (i) => (e) => setS((x) => ({ ...x, viewerRoles: x.viewerRoles.map((r, j) => (j === i ? e.target.value : r)) }));
    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                onSave({ ...s, viewerRoles: s.viewerRoles.map((r) => r.trim()).filter(Boolean), retentionDays: Number(s.retentionDays) });
            }}
            style={{ display: "flex", flexDirection: "column", gap: 14 }}
        >
            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="/form without a type" hint="The form staff get when they pick none">
                    <select className="input" value={s.defaultKey} onChange={set("defaultKey")}>
                        <option value="">— none: staff must pick one —</option>
                        {forms.map((f) => (
                            <option key={f.key} value={f.key}>
                                {f.name}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label="Delete answers after (days)" hint="The bot deletes what customers typed. Use {days} in a message to show it">
                    <input className="input" type="number" min={1} max={90} step={1} value={s.retentionDays} onChange={set("retentionDays")} required />
                </Field>
            </div>

            <Field label="Roles that can read the answers" hint="Members with any of these roles can open a sent form — it holds passwords and tokens">
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {s.viewerRoles.map((r, i) => (
                        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <input className="input mono" style={{ maxWidth: 240 }} placeholder="Role ID" value={r} onChange={setRole(i)} />
                            <span style={{ fontSize: 12, color: "var(--text-dim)", flex: 1 }}>{roleName(r.trim()) || ""}</span>
                            <IconButton title="Remove" icon="x" disabled={s.viewerRoles.length <= 1} onClick={() => setS((x) => ({ ...x, viewerRoles: x.viewerRoles.filter((_, j) => j !== i) }))} />
                        </div>
                    ))}
                    <div>
                        <button type="button" className="btn-ghost btn-sm" onClick={() => setS((x) => ({ ...x, viewerRoles: [...x.viewerRoles, ""] }))}>
                            <Icon name="plus" size={14} /> Add role
                        </button>
                    </div>
                </div>
            </Field>

            <div style={{ fontSize: 14, fontWeight: 600, borderTop: "1px solid var(--border)", paddingTop: 14 }}>After the customer sends a form</div>
            <Field label="Card text" hint="Replaces the form's message; the bot adds the answer's ID and who sent it">
                <textarea className="input mono" rows={2} value={s.savedText} onChange={set("savedText")} maxLength={1000} />
            </Field>
            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="View button">
                    <input className="input" value={s.viewLabel} onChange={set("viewLabel")} maxLength={80} />
                </Field>
                <Field label="View button emoji">
                    <input className="input mono" value={s.viewEmoji} onChange={set("viewEmoji")} />
                </Field>
            </div>
            <Field label="Ping in the ticket" hint={<>Variables: {vars.done.map((v) => <code key={v} className="mono" style={{ marginRight: 6 }}>{v}</code>)}— {"{staff}"} is who sent the form</>}>
                <textarea className="input" rows={2} value={s.doneText} onChange={set("doneText")} maxLength={1000} />
            </Field>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button type="submit" className="btn-primary" disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                </button>
            </div>
        </form>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function FormsPage() {
    const { canEdit } = usePageAccess("forms");
    const { isOwner } = useAuth();
    const [data, setData] = useState(null);
    const [server, setServer] = useState({ bot: null, roles: [], channels: [] });
    const [error, setError] = useState("");
    const [selected, setSelected] = useState(null);
    const [tab, setTab] = useState("ticket");
    const [modal, setModal] = useState(null); // { kind: "form" | "settings", item?, copy? }
    const [saving, setSaving] = useState(false);
    const [confirm, setConfirm] = useState(null);

    const load = useCallback(async () => {
        try {
            const { data } = await api.get("/forms");
            setData(data);
            setError("");
        } catch (err) {
            setError(errMsg(err, "Could not load the forms"));
        }
    }, []);

    useEffect(() => {
        load();
        const t = setInterval(load, 20_000);
        return () => clearInterval(t);
    }, [load]);

    // Names for <#channel> / <@&role> in the previews, from the Messages page's
    // server map — only for those who may open that page; without it, ids.
    useEffect(() => {
        api.get("/messages/targets")
            .then(({ data: t }) => setServer({ bot: t.bot, roles: (t.guilds || []).flatMap((g) => g.roles || []), channels: (t.guilds || []).flatMap((g) => g.channels || []) }))
            .catch(() => {});
    }, []);

    const forms = data?.forms || [];
    const settings = data?.settings;
    useEffect(() => {
        if (data && !forms.some((f) => f.key === selected)) setSelected(forms[0]?.key || null);
    }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
    const form = forms.find((f) => f.key === selected) || null;
    const roleName = (id) => server.roles.find((r) => r.id === id)?.name;

    const run = async (fn, { close = true } = {}) => {
        setSaving(true);
        try {
            await fn();
            await load();
            if (close) setModal(null);
        } catch (err) {
            alert(errMsg(err, "Could not save"));
        } finally {
            setSaving(false);
        }
    };

    const saveForm = (f) =>
        run(async () => {
            if (modal.item) await api.put(`/forms/items/${modal.item.key}`, f);
            else {
                const { data: made } = await api.post("/forms/items", f);
                setSelected(made.key);
            }
        });
    const moveForm = (f, position) => run(() => api.post(`/forms/items/${f.key}/move`, { position }), { close: false });
    const toggleForm = (f, enabled) => run(() => api.put(`/forms/items/${f.key}`, { enabled }), { close: false });

    return (
        <div className="fade-in page" style={{ maxWidth: 1400, display: "flex", flexDirection: "column", gap: 18 }}>
            <PageHeader
                title="Forms"
                description={<>What <code className="mono">/form</code> on ArnTo-assistant posts in a ticket. What customers type stays in the bot — only the viewer roles can read it.</>}
                actions={
                    <>
                        {isOwner && (
                            <button className="btn-ghost" disabled={!data} onClick={() => setModal({ kind: "settings" })}>
                                <Icon name="settings" /> Settings
                            </button>
                        )}
                        {canEdit && (
                            <button className="btn-primary" disabled={!data} onClick={() => setModal({ kind: "form" })}>
                                <Icon name="plus" /> New form
                            </button>
                        )}
                    </>
                }
            />

            {error && <Notice tone="danger">{error}</Notice>}
            {data && !data.imported && (
                <Notice>
                    ArnTo-assistant has not brought its current forms over yet — update the bot (Pull &amp; Update) and restart it; on start it copies its forms here.
                    Until then <code className="mono">/form</code> uses the bot's own forms.
                </Notice>
            )}
            {data?.imported && !settings.viewerRoles.length && <Notice tone="warning">No role can read the answers — set one in Settings.</Notice>}
            {data && (
                <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: -10, display: "flex", gap: 14, flexWrap: "wrap" }}>
                    {data.imported && <span>Used by {data.ownerName || data.owner}</span>}
                    <span>Answers are deleted after {settings.retentionDays} day{settings.retentionDays === 1 ? "" : "s"}</span>
                    {settings.viewerRoles.length > 0 && <span>Read by {settings.viewerRoles.map((r) => (roleName(r) ? `@${roleName(r)}` : r)).join(", ")}</span>}
                </div>
            )}

            {!data ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : !forms.length ? (
                <EmptyState
                    icon="clipboard"
                    title="No forms yet"
                    description="A form asks a customer for details only the viewer roles can read — account, password, backup codes, a bot token."
                    action={canEdit && <button className="btn-primary" onClick={() => setModal({ kind: "form" })}><Icon name="plus" /> New form</button>}
                />
            ) : (
                <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "minmax(240px, 300px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {forms.map((f, i) => (
                            <div key={f.key} className={`select-card${f.key === selected ? " active" : ""}${f.enabled ? "" : " off"}`} onClick={() => setSelected(f.key)}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <div style={{ minWidth: 0, flex: 1 }}>
                                        <div style={{ fontWeight: 500, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</div>
                                        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                                            <span className="mono">{f.key}</span> · {f.fields.length} field{f.fields.length === 1 ? "" : "s"}
                                            {settings.defaultKey === f.key && <span style={{ color: "var(--info)" }}> · default</span>}
                                        </div>
                                    </div>
                                    {canEdit && (
                                        <div style={{ display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
                                            <IconButton title="Move up" icon="chevronUp" disabled={!i} onClick={() => moveForm(f, i - 1)} />
                                            <IconButton title="Move down" icon="chevronDown" disabled={i === forms.length - 1} onClick={() => moveForm(f, i + 1)} />
                                        </div>
                                    )}
                                    <span onClick={(e) => e.stopPropagation()}>
                                        <Toggle checked={f.enabled} disabled={!canEdit} title={f.enabled ? "Listed in /form — turn off to hide it" : "Hidden from /form"} onChange={(v) => toggleForm(f, v)} />
                                    </span>
                                </div>
                            </div>
                        ))}
                        <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "0 4px" }}>
                            {forms.length} / {data.limits.forms} — the order /form lists them in
                        </div>
                    </div>

                    {form && (
                        <div className="card" style={{ padding: 18, minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0, flex: "1 1 220px", minWidth: 0 }}>{form.name}</h2>
                                {canEdit && (
                                    <>
                                        <button className="btn-ghost" onClick={() => setModal({ kind: "form", item: form })}>
                                            <Icon name="pencil" /> Edit
                                        </button>
                                        <button
                                            className="btn-ghost"
                                            disabled={forms.length >= data.limits.forms}
                                            onClick={() => setModal({ kind: "form", copy: { ...form, key: `${form.key}-copy`.slice(0, 32), name: `${form.name} (copy)`.slice(0, 100) } })}
                                        >
                                            <Icon name="copy" /> Duplicate
                                        </button>
                                        <button
                                            className="btn-danger"
                                            onClick={() =>
                                                setConfirm({
                                                    title: `Delete the form "${form.name}"?`,
                                                    message: "It leaves /form. Forms already posted in tickets stop opening; answers already sent stay readable until they are deleted.",
                                                    confirmText: "Delete",
                                                    run: () => api.delete(`/forms/items/${form.key}`),
                                                })
                                            }
                                        >
                                            Delete
                                        </button>
                                    </>
                                )}
                            </div>
                            <div style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", gap: 14, flexWrap: "wrap" }}>
                                <span>
                                    <code className="mono">/form type:{form.name}</code>
                                    {settings.defaultKey === form.key && " — also /form with no type"}
                                </span>
                                <span>{form.selfbotText ? "With a reminder from the shop's account" : "No reminder"}</span>
                                {!form.enabled && <span style={{ color: "var(--warning)" }}>Hidden from /form</span>}
                            </div>
                            <div className="tab-bar" style={{ alignSelf: "flex-start" }}>
                                {[
                                    ["ticket", "In the ticket"],
                                    ["modal", "Form"],
                                    ["after", "After sending"],
                                ].map(([id, label]) => (
                                    <button key={id} className={`tab-item ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
                                        {label}
                                    </button>
                                ))}
                            </div>
                            <PreviewLookup roles={server.roles} channels={server.channels}>
                                {tab === "ticket" && <TicketPreview form={form} settings={settings} bot={server.bot} />}
                                {tab === "modal" && <ModalPreview form={form} />}
                                {tab === "after" && <AfterPreview form={form} settings={settings} bot={server.bot} />}
                            </PreviewLookup>
                        </div>
                    )}
                </div>
            )}

            {modal?.kind === "form" && (
                <Modal title={modal.item ? `Edit "${modal.item.name}"` : modal.copy ? "Duplicate form" : "New form"} onClose={() => setModal(null)} width={1100}>
                    <PreviewLookup roles={server.roles} channels={server.channels}>
                        <FormEditor initial={modal.item || modal.copy || emptyForm()} isNew={!modal.item} data={data} bot={server.bot} onSave={saveForm} saving={saving} />
                    </PreviewLookup>
                </Modal>
            )}
            {modal?.kind === "settings" && (
                <Modal title="Form settings" onClose={() => setModal(null)} width={680}>
                    <SettingsForm initial={settings} forms={forms} vars={data.vars} roleName={roleName} onSave={(body) => run(() => api.put("/forms/settings", body))} saving={saving} />
                </Modal>
            )}

            {confirm && (
                <ConfirmModal
                    title={confirm.title}
                    message={confirm.message}
                    confirmText={confirm.confirmText}
                    onConfirm={() => {
                        const c = confirm;
                        setConfirm(null);
                        run(c.run, { close: false });
                    }}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </div>
    );
}
