import { useCallback, useEffect, useState } from "react";
import api from "../api/client";
import { usePageAccess } from "../context/AuthContext";
import ConfirmModal from "../components/ConfirmModal";
import { Embed, Markdown, PreviewLookup } from "../components/messages/DiscordPreview";
import { emojiObject } from "../components/messages/format";
import { EmptyState, Field, Icon, Modal, Notice, PageHeader, Toggle } from "../components/ui";

// ─────────────────────────────────────────────────────────────────────────────
//  Deliveries — what /giaotay on ArnTo-assistant sends when staff hand goods
//  over by hand: per delivery type, the confirmation DM with its rules, the DM
//  carrying the goods, the notices in the ticket, the blocked-DMs notice with
//  its retry button and the expired text. The deliveries themselves stay in the
//  bot. The logic lives in server/services/deliveryService.js; the previews
//  follow ArnTo-assistant's functions/handDelivery.js.
// ─────────────────────────────────────────────────────────────────────────────

const errMsg = (err, fallback) => err?.response?.data?.error || err?.message || fallback;
const EMBED_COLOR = 0x5865f2;

/** The bot's variables, as the preview shows them. */
const fill = (text, vars) => String(text || "").replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));

const IconButton = ({ title, icon, onClick, disabled, danger }) => (
    <button type="button" className={`btn-ghost btn-icon btn-sm${danger ? " is-danger" : ""}`} title={title} aria-label={title} disabled={disabled} onClick={onClick} style={{ border: "none" }}>
        <Icon name={icon} size={14} />
    </button>
);

const Vars = ({ list }) => (
    <>
        Variables:{" "}
        {list.map((v) => (
            <code key={v} className="mono" style={{ marginRight: 6 }}>
                {v}
            </code>
        ))}
    </>
);

// ── What the bot writes (same rules as functions/handDelivery.js) ────────────

const rulesText = (type, rules) =>
    (type.rules || [])
        .map((id) => rules.find((r) => r.id === id)?.text)
        .filter(Boolean)
        .join("\n");

const pledgeWith = (text, rules) => {
    const t = String(text || "");
    if (!rules) return t.replace(/\{rules\}/g, "").trim();
    return t.includes("{rules}") ? t.replace(/\{rules\}/g, rules) : `${t}\n\n${rules}`;
};

const fieldList = (type) => (Array.isArray(type.fields) ? type.fields : String(type.fields || "").split("|")).map((f) => f.trim()).filter(Boolean);

const sampleVars = (type) => {
    const until = Math.floor(Date.now() / 1000) + (Number(type.keepDays) || 7) * 86400;
    return {
        user: "@Customer",
        staff: "@Staff",
        product: type.name || "Product",
        expires: `<t:${until}:F>`,
        expiresIn: `<t:${until}:R>`,
        time: `<t:${Math.floor(Date.now() / 1000)}:F>`,
    };
};

/** The goods DM for sample goods: named fields, or the whole text ({item}, else under the message). */
const goodsEmbed = (type) => {
    const vars = sampleVars(type);
    const names = fieldList(type);
    const code = type.codeBlock !== false;
    const whole = names.length ? names.map((n) => n.toLowerCase().replace(/\s+/g, "")).join(type.separator || ":") : "https://example.com/your-goods";
    const item = code ? `\`\`\`\n${whole}\n\`\`\`` : whole;
    let description = fill(type.goodsText, vars);
    const inText = description.includes("{item}");
    description = description.replace(/\{item\}/g, item);
    if (!inText && !names.length) description = description ? `${description}\n\n${item}` : item;
    return {
        color: EMBED_COLOR,
        title: fill(type.goodsTitle, vars),
        description,
        fields: names.map((n) => {
            const v = n.toLowerCase().replace(/\s+/g, "");
            return { name: `${n}:`, value: code ? `\`${v}\`` : v, inline: true };
        }),
        image: type.goodsImage ? { url: type.goodsImage } : undefined,
        footer: type.goodsFooter ? { text: fill(type.goodsFooter, vars) } : undefined,
    };
};

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

function Message({ bot, where, children }) {
    return (
        <div>
            <div style={{ fontSize: 11, color: "#949ba4", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4 }}>{where}</div>
            <div className="dp-message">
                <div className="dp-header">
                    <img className="dp-avatar" src={bot?.avatar || "https://cdn.discordapp.com/embed/avatars/0.png"} alt="" />
                    <span className="dp-name">{bot?.displayName || bot?.username || "ArnTo-assistant"}</span>
                    <span className="dp-bot">APP</span>
                </div>
                <div className="dp-body">{children}</div>
            </div>
        </div>
    );
}

const Text = ({ text }) => (text ? <div className="dp-content"><Markdown text={text} /></div> : <div className="dp-empty">(nothing is posted)</div>);

function Preview({ view, type, rules, bot }) {
    const vars = sampleVars(type);
    const root = { display: "flex", flexDirection: "column", gap: 16 };
    if (view === "pledge") {
        if (!type.confirm) {
            return <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>This type needs no confirmation — the goods are sent right away.</p>;
        }
        return (
            <div className="dp-root" style={root}>
                <Message bot={bot} where="DM — before the goods">
                    <Embed e={{ color: EMBED_COLOR, description: fill(pledgeWith(type.pledgeText, rulesText(type, rules)), vars) }} />
                    <div className="dp-row"><PreviewButton label={type.pledgeButton} emoji={type.pledgeEmoji} /></div>
                </Message>
                <Message bot={bot} where="DM — the same message once confirmed">
                    <Embed e={{ color: EMBED_COLOR, description: fill(type.confirmedText, vars) }} />
                </Message>
            </div>
        );
    }
    if (view === "goods") {
        return (
            <div className="dp-root" style={root}>
                <Message bot={bot} where="DM — the goods (sample)">
                    <Embed e={goodsEmbed(type)} />
                </Message>
            </div>
        );
    }
    if (view === "ticket") {
        return (
            <div className="dp-root" style={root}>
                <Message bot={bot} where="Ticket — once the DM got through">
                    <Text text={fill(type.ticketNotice, vars)} />
                </Message>
                {type.confirm && (
                    <Message bot={bot} where="Ticket — once the customer confirmed">
                        <Text text={fill(type.ticketDone, vars)} />
                    </Message>
                )}
            </div>
        );
    }
    if (view === "blocked") {
        return (
            <div className="dp-root" style={root}>
                <Message bot={bot} where="Ticket — the customer's DMs are closed">
                    <div className="dp-content"><Markdown text={vars.user} /></div>
                    <Embed e={{ color: 0xff0000, description: fill(type.blockedText, vars), image: type.blockedImage ? { url: type.blockedImage } : undefined }} />
                    <div className="dp-row"><PreviewButton label={type.retryButton} emoji={type.retryEmoji} /></div>
                </Message>
            </div>
        );
    }
    return (
        <div className="dp-root" style={root}>
            <Message bot={bot} where="Replaces the confirmation DM / the blocked notice">
                <Embed e={{ color: 0x80848e, description: fill(type.expiredText, vars) }} />
            </Message>
        </div>
    );
}

const VIEWS = [
    ["pledge", "Confirmation"],
    ["goods", "Goods"],
    ["ticket", "Ticket"],
    ["blocked", "DMs closed"],
    ["expired", "Expired"],
];

const ViewTabs = ({ view, onChange }) => (
    <div className="tab-bar" style={{ alignSelf: "flex-start", flexWrap: "wrap" }}>
        {VIEWS.map(([id, label]) => (
            <button key={id} type="button" className={`tab-item ${view === id ? "active" : ""}`} onClick={() => onChange(id)}>
                {label}
            </button>
        ))}
    </div>
);

// ── Editing ──────────────────────────────────────────────────────────────────

const Section = ({ children }) => <div style={{ fontSize: 14, fontWeight: 600, borderTop: "1px solid var(--border)", paddingTop: 14, marginTop: 4 }}>{children}</div>;
const two = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 };

function RulePicker({ picked, rules, max, onChange }) {
    const left = rules.filter((r) => !picked.includes(r.id));
    const move = (i, d) => {
        const next = [...picked];
        [next[i], next[i + d]] = [next[i + d], next[i]];
        onChange(next);
    };
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {picked.map((id, i) => {
                const r = rules.find((x) => x.id === id);
                return (
                    <div key={id} className="card" style={{ padding: "6px 10px", display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 12, color: "var(--text-dim)", width: 18 }}>{i + 1}</span>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r?.text}>
                            {r?.name || id}
                        </span>
                        <IconButton title="Move up" icon="arrowUp" disabled={!i} onClick={() => move(i, -1)} />
                        <IconButton title="Move down" icon="arrowDown" disabled={i === picked.length - 1} onClick={() => move(i, 1)} />
                        <IconButton title="Remove" icon="x" danger onClick={() => onChange(picked.filter((x) => x !== id))} />
                    </div>
                );
            })}
            {!rules.length ? (
                <span style={{ fontSize: 12, color: "var(--text-dim)" }}>No rules yet — write them in the Rules tab.</span>
            ) : (
                left.length > 0 &&
                picked.length < max && (
                    <select className="input" style={{ maxWidth: 360 }} value="" onChange={(e) => e.target.value && onChange([...picked, e.target.value])}>
                        <option value="">+ Add a rule…</option>
                        {left.map((r) => (
                            <option key={r.id} value={r.id}>
                                {r.name}
                            </option>
                        ))}
                    </select>
                )
            )}
        </div>
    );
}

function TypeEditor({ initial, isNew, data, bot, onSave, saving }) {
    const [t, setT] = useState(() => ({ ...data.defaults, key: "", name: "", enabled: true, rules: [], ...initial, fields: fieldList(initial).join("|") }));
    const [view, setView] = useState("pledge");
    const set = (k) => (e) => setT((x) => ({ ...x, [k]: e?.target ? e.target.value : e }));
    const L = data.limits;
    const pledgeLength = pledgeWith(t.pledgeText, rulesText(t, data.rules)).length;
    const tooLong = t.confirm && pledgeLength > L.embedText;
    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                onSave({ ...t, keepDays: Number(t.keepDays) });
            }}
            className="grid-1-mobile"
            style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 440px)", gap: 20, alignItems: "start" }}
        >
            <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
                <div className="grid-1-mobile" style={two}>
                    <Field label="Name" hint="What staff pick in /giaotay — also {product}">
                        <input className="input" value={t.name} onChange={set("name")} maxLength={100} placeholder="Nitro Boost 2 months" autoFocus={isNew} required />
                    </Field>
                    <Field label="Key" hint={isNew ? "a-z, 0-9, - and _ — cannot change later" : "Fixed"}>
                        <input className="input mono" value={t.key} onChange={set("key")} maxLength={32} placeholder="nb2m" disabled={!isNew} required />
                    </Field>
                </div>
                <div className="grid-1-mobile" style={two}>
                    <Field label="Keep a delivery for (days)" hint="From the moment staff run the command. After that the bot deletes it; one not received yet expires">
                        <input className="input" type="number" min={1} max={90} step={1} value={t.keepDays} onChange={set("keepDays")} required />
                    </Field>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, justifyContent: "center", fontSize: 13 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <Toggle checked={t.confirm} onChange={set("confirm")} /> The customer must confirm before receiving
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <Toggle checked={t.enabled} onChange={set("enabled")} /> Listed in /giaotay
                        </label>
                    </div>
                </div>

                <Section>The goods staff type</Section>
                <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
                    <Field label="Fields" hint="Names split by | — the goods are cut into them. Empty: the goods are shown whole">
                        <input className="input" value={t.fields} onChange={set("fields")} placeholder="Gmail|Password|Hash" />
                    </Field>
                    <Field label="Separator" hint="Between the values staff type">
                        <input className="input mono" value={t.separator} onChange={set("separator")} maxLength={5} placeholder=":" />
                    </Field>
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                    <Toggle checked={t.codeBlock} onChange={set("codeBlock")} /> Show the goods as code (easy to copy) — turn off for links the customer should click
                </label>

                {t.confirm && (
                    <>
                        <Section>Confirmation — a DM before the goods</Section>
                        <Field
                            label="Message"
                            hint={
                                <span style={{ color: tooLong ? "var(--danger)" : undefined }}>
                                    <Vars list={data.vars.pledge} />— {pledgeLength.toLocaleString("en-US")} / {L.embedText.toLocaleString("en-US")} with the rules. Without {"{rules}"} the rules go under the message
                                </span>
                            }
                        >
                            <textarea className="input mono" rows={7} value={t.pledgeText} onChange={set("pledgeText")} required />
                        </Field>
                        <Field label="Rules" hint="In this order, one per line">
                            <RulePicker picked={t.rules} rules={data.rules} max={L.typeRules} onChange={set("rules")} />
                        </Field>
                        <div className="grid-1-mobile" style={two}>
                            <Field label="Confirm button">
                                <input className="input" value={t.pledgeButton} onChange={set("pledgeButton")} maxLength={80} />
                            </Field>
                            <Field label="Button emoji" hint="A Unicode emoji, or a server emoji: <:name:id>">
                                <input className="input mono" value={t.pledgeEmoji} onChange={set("pledgeEmoji")} />
                            </Field>
                        </div>
                        <Field label="Once confirmed" hint={<><Vars list={data.vars.confirmed} />— replaces the message above</>}>
                            <textarea className="input mono" rows={3} value={t.confirmedText} onChange={set("confirmedText")} maxLength={L.embedText} />
                        </Field>
                    </>
                )}

                <Section>Goods — the DM that carries them</Section>
                <Field label="Title" hint="Empty: no title">
                    <input className="input" value={t.goodsTitle} onChange={set("goodsTitle")} maxLength={200} />
                </Field>
                <Field label="Message" hint={<><Vars list={data.vars.goods} />— {"{item}"} is the goods as typed; without it and without fields they go under the message</>}>
                    <textarea className="input mono" rows={6} value={t.goodsText} onChange={set("goodsText")} maxLength={L.goodsText} />
                </Field>
                <div className="grid-1-mobile" style={two}>
                    <Field label="Image / GIF URL" hint="A guide shown under the goods. Empty: none">
                        <input className="input" value={t.goodsImage} onChange={set("goodsImage")} placeholder="https://…" />
                    </Field>
                    <Field label="Footer" hint="Empty: none">
                        <input className="input" value={t.goodsFooter} onChange={set("goodsFooter")} maxLength={500} />
                    </Field>
                </div>

                <Section>In the ticket — where staff ran the command</Section>
                <Field label="Once the DM got through" hint={<><Vars list={data.vars.ticket} />— empty: nothing is posted</>}>
                    <textarea className="input mono" rows={3} value={t.ticketNotice} onChange={set("ticketNotice")} maxLength={L.ticketText} />
                </Field>
                {t.confirm && (
                    <Field label="Once the customer confirmed" hint="Empty: nothing is posted">
                        <textarea className="input mono" rows={2} value={t.ticketDone} onChange={set("ticketDone")} maxLength={L.ticketText} />
                    </Field>
                )}

                <Section>DMs closed — a notice in the ticket with a retry button</Section>
                <Field label="Message" hint={<><Vars list={data.vars.blocked} />— the goods never appear in the ticket</>}>
                    <textarea className="input mono" rows={4} value={t.blockedText} onChange={set("blockedText")} maxLength={L.embedText} />
                </Field>
                <Field label="Image / GIF URL" hint="How to open DMs. Empty: none">
                    <input className="input" value={t.blockedImage} onChange={set("blockedImage")} placeholder="https://…" />
                </Field>
                <div className="grid-1-mobile" style={two}>
                    <Field label="Retry button">
                        <input className="input" value={t.retryButton} onChange={set("retryButton")} maxLength={80} />
                    </Field>
                    <Field label="Button emoji">
                        <input className="input mono" value={t.retryEmoji} onChange={set("retryEmoji")} />
                    </Field>
                </div>

                <Section>Expired — not received in time</Section>
                <Field label="Message" hint={<><Vars list={data.vars.expired} />— replaces the confirmation DM or the DMs-closed notice</>}>
                    <textarea className="input mono" rows={3} value={t.expiredText} onChange={set("expiredText")} maxLength={L.embedText} />
                </Field>

                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button type="submit" className="btn-primary" disabled={saving || tooLong}>
                        {saving ? "Saving…" : isNew ? "Create type" : "Save"}
                    </button>
                </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, position: "sticky", top: 0, minWidth: 0 }}>
                <ViewTabs view={view} onChange={setView} />
                <Preview view={view} type={t} rules={data.rules} bot={bot} />
            </div>
        </form>
    );
}

function RuleEditor({ initial, onSave, saving }) {
    const [r, setR] = useState({ name: "", text: "", ...initial });
    const set = (k) => (e) => setR((x) => ({ ...x, [k]: e.target.value }));
    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                onSave(r);
            }}
            style={{ display: "flex", flexDirection: "column", gap: 14 }}
        >
            <Field label="Name" hint="Only shown on this page, to pick the rule. Empty: the start of its text">
                <input className="input" value={r.name} onChange={set("name")} maxLength={100} placeholder="No refund after receiving" autoFocus />
            </Field>
            <Field label="Text" hint="What the customer reads, exactly as written — Discord markdown, your own bullet or emoji">
                <textarea className="input mono" rows={4} value={r.text} onChange={set("text")} maxLength={1000} required />
            </Field>
            {r.text && (
                <div className="dp-root">
                    <div className="dp-content"><Markdown text={r.text} /></div>
                </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button type="submit" className="btn-primary" disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                </button>
            </div>
        </form>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DeliveriesPage() {
    const { canEdit } = usePageAccess("deliveries");
    const [data, setData] = useState(null);
    const [server, setServer] = useState({ bot: null, roles: [], channels: [] });
    const [error, setError] = useState("");
    const [tab, setTab] = useState("types");
    const [selected, setSelected] = useState(null);
    const [view, setView] = useState("pledge");
    const [modal, setModal] = useState(null); // { kind: "type" | "rule", item?, copy? }
    const [saving, setSaving] = useState(false);
    const [confirm, setConfirm] = useState(null);

    const load = useCallback(async () => {
        try {
            const { data } = await api.get("/deliveries");
            setData(data);
            setError("");
        } catch (err) {
            setError(errMsg(err, "Could not load the delivery types"));
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

    const types = data?.types || [];
    const rules = data?.rules || [];
    useEffect(() => {
        if (data && !types.some((t) => t.key === selected)) setSelected(types[0]?.key || null);
    }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
    const type = types.find((t) => t.key === selected) || null;
    const usedBy = (rule) => types.filter((t) => t.rules.includes(rule.id));

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

    const saveType = (t) =>
        run(async () => {
            if (modal.item) await api.put(`/deliveries/types/${modal.item.key}`, t);
            else {
                const { data: made } = await api.post("/deliveries/types", t);
                setSelected(made.key);
            }
        });
    const saveRule = (r) => run(() => (modal.item ? api.put(`/deliveries/rules/${modal.item.id}`, r) : api.post("/deliveries/rules", r)));
    const newItem = () => setModal({ kind: tab === "rules" ? "rule" : "type" });

    return (
        <div className="fade-in page" style={{ maxWidth: 1400, display: "flex", flexDirection: "column", gap: 18 }}>
            <PageHeader
                title="Deliveries"
                description={<>What <code className="mono">/giaotay</code> on ArnTo-assistant sends when staff hand goods over by hand. The goods stay in the bot and are deleted after each type's keep time.</>}
                actions={
                    canEdit && (
                        <button className="btn-primary" disabled={!data} onClick={newItem}>
                            <Icon name="plus" /> {tab === "rules" ? "New rule" : "New type"}
                        </button>
                    )
                }
            />

            {error && <Notice tone="danger">{error}</Notice>}
            {data && !data.owner && (
                <Notice>
                    ArnTo-assistant has not read the delivery types yet — update the bot (Pull &amp; Update) and restart it. Until then <code className="mono">/giaotay</code> does not exist.
                </Notice>
            )}
            {data?.owner && <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: -10 }}>Used by {data.ownerName || data.owner}</div>}

            <div className="tab-bar" style={{ alignSelf: "flex-start" }}>
                {[
                    ["types", `Types${data ? ` (${types.length})` : ""}`],
                    ["rules", `Rules${data ? ` (${rules.length})` : ""}`],
                ].map(([id, label]) => (
                    <button key={id} className={`tab-item ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
                        {label}
                    </button>
                ))}
            </div>

            {!data ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : tab === "rules" ? (
                !rules.length ? (
                    <EmptyState
                        icon="clipboard"
                        title="No rules yet"
                        description="A rule is one line the customer agrees to before receiving. Write each once here, then tick the ones each delivery type needs."
                        action={canEdit && <button className="btn-primary" onClick={newItem}><Icon name="plus" /> New rule</button>}
                    />
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 900 }}>
                        {rules.map((r, i) => {
                            const used = usedBy(r);
                            return (
                                <div key={r.id} className="card" style={{ padding: 14, display: "flex", gap: 10, alignItems: "flex-start" }}>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontWeight: 500, fontSize: 14 }}>{r.name}</div>
                                        <div className="dp-root" style={{ marginTop: 6 }}>
                                            <div className="dp-content"><Markdown text={r.text} /></div>
                                        </div>
                                        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>{used.length ? `Used by ${used.map((t) => t.name).join(", ")}` : "Not used by any type"}</div>
                                    </div>
                                    {canEdit && (
                                        <div style={{ display: "flex", gap: 2 }}>
                                            <IconButton title="Move up" icon="arrowUp" disabled={!i} onClick={() => run(() => api.post(`/deliveries/rules/${r.id}/move`, { position: i - 1 }), { close: false })} />
                                            <IconButton title="Move down" icon="arrowDown" disabled={i === rules.length - 1} onClick={() => run(() => api.post(`/deliveries/rules/${r.id}/move`, { position: i + 1 }), { close: false })} />
                                            <IconButton title="Edit" icon="pencil" onClick={() => setModal({ kind: "rule", item: r })} />
                                            <IconButton
                                                title="Delete"
                                                icon="x"
                                                danger
                                                onClick={() =>
                                                    setConfirm({
                                                        title: `Delete the rule "${r.name}"?`,
                                                        message: used.length ? `It leaves ${used.map((t) => t.name).join(", ")}. Deliveries already sent keep the rules they were sent with.` : "No delivery type uses it.",
                                                        confirmText: "Delete",
                                                        run: () => api.delete(`/deliveries/rules/${r.id}`),
                                                    })
                                                }
                                            />
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "0 4px" }}>
                            {rules.length} / {data.limits.rules}
                        </div>
                    </div>
                )
            ) : !types.length ? (
                <EmptyState
                    icon="truck"
                    title="No delivery types yet"
                    description="A delivery type is one kind of goods staff hand over by hand — a mail, a promo link, a gift — with every message the bot sends for it."
                    action={canEdit && <button className="btn-primary" onClick={newItem}><Icon name="plus" /> New type</button>}
                />
            ) : (
                <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "minmax(240px, 300px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {types.map((t, i) => (
                            <div key={t.key} className={`select-card${t.key === selected ? " active" : ""}${t.enabled ? "" : " off"}`} onClick={() => setSelected(t.key)}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <div style={{ minWidth: 0, flex: 1 }}>
                                        <div style={{ fontWeight: 500, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</div>
                                        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                                            <span className="mono">{t.key}</span> · {t.confirm ? "confirmation" : "no confirmation"} · {t.keepDays} day{t.keepDays === 1 ? "" : "s"}
                                        </div>
                                    </div>
                                    {canEdit && (
                                        <div style={{ display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
                                            <IconButton title="Move up" icon="chevronUp" disabled={!i} onClick={() => run(() => api.post(`/deliveries/types/${t.key}/move`, { position: i - 1 }), { close: false })} />
                                            <IconButton title="Move down" icon="chevronDown" disabled={i === types.length - 1} onClick={() => run(() => api.post(`/deliveries/types/${t.key}/move`, { position: i + 1 }), { close: false })} />
                                        </div>
                                    )}
                                    <span onClick={(e) => e.stopPropagation()}>
                                        <Toggle
                                            checked={t.enabled}
                                            disabled={!canEdit}
                                            title={t.enabled ? "Listed in /giaotay — turn off to hide it" : "Hidden from /giaotay"}
                                            onChange={(v) => run(() => api.put(`/deliveries/types/${t.key}`, { enabled: v }), { close: false })}
                                        />
                                    </span>
                                </div>
                            </div>
                        ))}
                        <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "0 4px" }}>
                            {types.length} / {data.limits.types} — the order /giaotay lists them in
                        </div>
                    </div>

                    {type && (
                        <div className="card" style={{ padding: 18, minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0, flex: "1 1 220px", minWidth: 0 }}>{type.name}</h2>
                                {canEdit && (
                                    <>
                                        <button className="btn-ghost" onClick={() => setModal({ kind: "type", item: type })}>
                                            <Icon name="pencil" /> Edit
                                        </button>
                                        <button
                                            className="btn-ghost"
                                            disabled={types.length >= data.limits.types}
                                            onClick={() => setModal({ kind: "type", copy: { ...type, key: `${type.key}-copy`.slice(0, 32), name: `${type.name} (copy)`.slice(0, 100) } })}
                                        >
                                            <Icon name="copy" /> Duplicate
                                        </button>
                                        <button
                                            className="btn-danger"
                                            onClick={() =>
                                                setConfirm({
                                                    title: `Delete the delivery type "${type.name}"?`,
                                                    message: "It leaves /giaotay. Deliveries already sent keep working until they expire.",
                                                    confirmText: "Delete",
                                                    run: () => api.delete(`/deliveries/types/${type.key}`),
                                                })
                                            }
                                        >
                                            Delete
                                        </button>
                                    </>
                                )}
                            </div>
                            <div style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", gap: 14, flexWrap: "wrap" }}>
                                <code className="mono">/giaotay loai:{type.name}</code>
                                <span>{type.confirm ? `Confirmation with ${type.rules.length} rule${type.rules.length === 1 ? "" : "s"}` : "Sent right away, no confirmation"}</span>
                                <span>{type.fields.length ? `Goods: ${type.fields.join(type.separator)}` : "Goods shown whole"}</span>
                                <span>Kept {type.keepDays} day{type.keepDays === 1 ? "" : "s"}</span>
                                {!type.enabled && <span style={{ color: "var(--warning)" }}>Hidden from /giaotay</span>}
                            </div>
                            <ViewTabs view={view} onChange={setView} />
                            <PreviewLookup roles={server.roles} channels={server.channels}>
                                <Preview view={view} type={type} rules={rules} bot={server.bot} />
                            </PreviewLookup>
                        </div>
                    )}
                </div>
            )}

            {modal?.kind === "type" && (
                <Modal title={modal.item ? `Edit "${modal.item.name}"` : modal.copy ? "Duplicate delivery type" : "New delivery type"} onClose={() => setModal(null)} width={1150}>
                    <PreviewLookup roles={server.roles} channels={server.channels}>
                        <TypeEditor initial={modal.item || modal.copy || {}} isNew={!modal.item} data={data} bot={server.bot} onSave={saveType} saving={saving} />
                    </PreviewLookup>
                </Modal>
            )}
            {modal?.kind === "rule" && (
                <Modal title={modal.item ? "Edit rule" : "New rule"} onClose={() => setModal(null)} width={640}>
                    <PreviewLookup roles={server.roles} channels={server.channels}>
                        <RuleEditor initial={modal.item || {}} onSave={saveRule} saving={saving} />
                    </PreviewLookup>
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
