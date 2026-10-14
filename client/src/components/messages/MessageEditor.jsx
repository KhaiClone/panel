import { createContext, useContext, useEffect, useRef, useState } from "react";
import Icon from "../ui/Icon";
import { LIMITS, embedChars, emptyEmbed, fromHex, hex } from "./format";
import "./discohook.css";

// Discohook-style editor of one message: content, up to 10 embeds (author,
// body, fields, images, footer) and rows of link buttons, laid out like
// discohook.app — folds with chevrons, embeds as cards with their colour on
// the left, an "Add" menu under the message. Mentions (@everyone, @here, a
// role, a channel) go in at the caret of the last text box used — content by
// default. Pages wrap it in .dh (discohook.css) and add their own folds
// (profile, files) through `extra`, and buttons next to "Add" through `footer`.

const Active = createContext({ setActive: () => {} });

const move = (arr, i, d) => {
    const j = i + d;
    if (j < 0 || j >= arr.length) return arr;
    const out = [...arr];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
};

const short = (v, n = 40) => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
};

export function Count({ n, max }) {
    const cls = n > max ? "over" : n > max * 0.9 ? "near" : "";
    return <span className={`dh-count ${cls}`}>{n}/{max}</span>;
}

/** A text box that the insert bar can write into. `max` shows a counter. */
function TextBox({ label, value, onChange, max, multiline = false, rows = 3, placeholder, hideLabel = false, mono = false }) {
    const ref = useRef(null);
    // The insert bar may write long after the focus: always through the latest onChange.
    const apply = useRef(onChange);
    apply.current = onChange;
    const target = useRef(null);
    target.current ||= { get el() { return ref.current; }, apply: (x) => apply.current(x), pos: null };
    const { setActive } = useContext(Active);
    const v = value ?? "";
    const props = {
        ref,
        className: `dh-input${mono ? " mono" : ""}`,
        value: v,
        placeholder,
        onChange: (e) => onChange(e.target.value),
        onFocus: () => setActive(target.current),
        onBlur: (e) => (target.current.pos = { start: e.target.selectionStart, end: e.target.selectionEnd }),
        spellCheck: false,
        "aria-label": hideLabel ? label : undefined,
        ...(multiline ? { style: { minHeight: rows * 22 + 18 } } : {}),
    };
    return (
        <label className="dh-field">
            {!hideLabel && (
                <span className="dh-label">
                    {label}
                    {max ? <Count n={v.length} max={max} /> : null}
                </span>
            )}
            {multiline ? <textarea rows={rows} {...props} /> : <input {...props} />}
        </label>
    );
}

export const IconBtn = ({ icon, onClick, title, danger, disabled }) => (
    <button type="button" className={`dh-icon-btn${danger ? " danger" : ""}`} onClick={onClick} title={title} aria-label={title} disabled={disabled}>
        <Icon name={icon} size={16} />
    </button>
);

/**
 * A fold with a chevron, like Discohook's. Controlled (open + onToggle) or on
 * its own (defaultOpen). `right` holds buttons that do not fold it.
 */
export function Fold({ title, summary, open: openProp, onToggle, defaultOpen = false, right, big = false, children }) {
    const [own, setOwn] = useState(defaultOpen);
    const open = openProp ?? own;
    const toggle = () => (onToggle ? onToggle(!open) : setOwn(!open));
    return (
        <div className={`dh-fold${big ? " big" : ""}`}>
            <div className="dh-fold-head" onClick={toggle}>
                <Icon name={open ? "chevronDown" : "chevronRight"} size={16} />
                <span className="dh-fold-title">{title}</span>
                {!open && summary ? <span className="dh-sum">{summary}</span> : <span style={{ flex: 1 }} />}
                {right && (
                    <span className="dh-fold-right" onClick={(e) => e.stopPropagation()}>
                        {right}
                    </span>
                )}
            </div>
            {open && <div className="dh-fold-body">{children}</div>}
        </div>
    );
}

/** "Add ▾" — a small menu of things to add to the message. */
export function AddMenu({ items, label = "Add" }) {
    const [open, setOpen] = useState(false);
    const wrap = useRef(null);
    useEffect(() => {
        if (!open) return undefined;
        const close = (e) => wrap.current && !wrap.current.contains(e.target) && setOpen(false);
        document.addEventListener("mousedown", close);
        return () => document.removeEventListener("mousedown", close);
    }, [open]);
    return (
        <span className="dh-menu-wrap" ref={wrap}>
            <button type="button" className="dh-btn primary" onClick={() => setOpen(!open)}>
                {label} <Icon name="chevronDown" size={14} />
            </button>
            {open && (
                <div className="dh-menu">
                    {items.map((it) => (
                        <button
                            key={it.label}
                            type="button"
                            disabled={it.disabled}
                            title={it.title}
                            onClick={() => {
                                setOpen(false);
                                it.onClick();
                            }}
                        >
                            {it.icon && <Icon name={it.icon} size={15} />}
                            {it.label}
                        </button>
                    ))}
                </div>
            )}
        </span>
    );
}

function ColorField({ value, onChange }) {
    const [text, setText] = useState(null); // what is being typed, until it is a colour
    const shown = text ?? (typeof value === "number" ? hex(value) : "");
    return (
        <label className="dh-field">
            <span className="dh-label">Sidebar colour</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                    className="dh-input mono"
                    value={shown}
                    placeholder="#rrggbb"
                    onChange={(e) => {
                        setText(e.target.value);
                        if (!e.target.value.trim()) onChange(null);
                        else if (fromHex(e.target.value) != null) onChange(fromHex(e.target.value));
                    }}
                    onBlur={() => setText(null)}
                />
                <input
                    type="color"
                    className="dh-color"
                    value={typeof value === "number" ? hex(value) : "#202225"}
                    onChange={(e) => {
                        setText(null);
                        onChange(fromHex(e.target.value));
                    }}
                    title="Pick a colour"
                />
            </div>
        </label>
    );
}

const pad = (n) => String(n).padStart(2, "0");
const toLocalInput = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function FieldCard({ f, j, count, onChange, onMove, onDuplicate, onRemove, full }) {
    return (
        <div className="dh-card">
            <Fold
                title={`Field ${j + 1}${f.name ? ` - ${short(f.name, 30)}` : ""}`}
                defaultOpen
                right={
                    <>
                        <IconBtn icon="chevronUp" onClick={() => onMove(-1)} disabled={j === 0} title="Move up" />
                        <IconBtn icon="chevronDown" onClick={() => onMove(1)} disabled={j === count - 1} title="Move down" />
                        <IconBtn icon="copy" onClick={onDuplicate} disabled={full} title="Duplicate" />
                        <IconBtn icon="trash" onClick={onRemove} danger title="Remove field" />
                    </>
                }
            >
                <TextBox label="Name" value={f.name} max={LIMITS.fieldName} onChange={(v) => onChange({ name: v })} />
                <TextBox label="Value" value={f.value} max={LIMITS.fieldValue} onChange={(v) => onChange({ value: v })} multiline rows={2} />
                <label className="dh-check" title="Show beside the fields next to it">
                    <input type="checkbox" checked={!!f.inline} onChange={(ev) => onChange({ inline: ev.target.checked })} /> Inline
                </label>
            </Fold>
        </div>
    );
}

function EmbedEditor({ e, i, count, open, onToggle, onChange, onRemove, onMove, onDuplicate }) {
    const set = (patch) => onChange({ ...e, ...patch });
    const setIn = (key, patch) => {
        const next = { ...(e[key] || {}), ...patch };
        set({ [key]: Object.values(next).some(Boolean) ? next : undefined });
    };
    const fields = e.fields || [];
    const setField = (j, patch) => set({ fields: fields.map((f, k) => (k === j ? { ...f, ...patch } : f)) });
    const head = short(e.title || e.author?.name || e.description, 40);
    const chars = embedChars(e);
    return (
        <div className="dh-card dh-embed" style={{ "--c": typeof e.color === "number" ? hex(e.color) : "#202225" }}>
            <Fold
                big
                title={`Embed ${i + 1}${head ? ` - ${head}` : ""}`}
                open={open}
                onToggle={onToggle}
                right={
                    <>
                        {chars > LIMITS.embedTotal * 0.5 && <Count n={chars} max={LIMITS.embedTotal} />}
                        <IconBtn icon="chevronUp" onClick={() => onMove(-1)} disabled={i === 0} title="Move up" />
                        <IconBtn icon="chevronDown" onClick={() => onMove(1)} disabled={i === count - 1} title="Move down" />
                        <IconBtn icon="copy" onClick={onDuplicate} disabled={count >= LIMITS.embeds} title="Duplicate" />
                        <IconBtn icon="trash" onClick={onRemove} danger title="Remove embed" />
                    </>
                }
            >
                <Fold title="Author" summary={short(e.author?.name, 30)} defaultOpen={!!e.author?.name}>
                    <TextBox label="Name" value={e.author?.name} max={LIMITS.author} onChange={(v) => setIn("author", { name: v })} />
                    <div className="dh-grid">
                        <TextBox label="Icon" value={e.author?.icon_url} placeholder="https://…" onChange={(v) => setIn("author", { icon_url: v })} />
                        <TextBox label="Link" value={e.author?.url} placeholder="https://…" onChange={(v) => setIn("author", { url: v })} />
                    </div>
                </Fold>

                <Fold title="Body" summary={short(e.title || e.description, 30)} defaultOpen>
                    <TextBox label="Title" value={e.title} max={LIMITS.title} onChange={(v) => set({ title: v })} />
                    <div className="dh-grid">
                        <TextBox label="Title link" value={e.url} placeholder="https://…" onChange={(v) => set({ url: v })} />
                        <ColorField value={e.color} onChange={(v) => set({ color: v })} />
                    </div>
                    <TextBox label="Description" value={e.description} max={LIMITS.description} onChange={(v) => set({ description: v })} multiline rows={4} />
                </Fold>

                <Fold title={`Fields (${fields.length}/${LIMITS.fields})`} summary={short(fields.map((f) => f.name).filter(Boolean).join(", "), 40)} defaultOpen={fields.length > 0}>
                    {fields.map((f, j) => (
                        <FieldCard
                            key={j}
                            f={f}
                            j={j}
                            count={fields.length}
                            full={fields.length >= LIMITS.fields}
                            onChange={(patch) => setField(j, patch)}
                            onMove={(d) => set({ fields: move(fields, j, d) })}
                            onDuplicate={() => set({ fields: [...fields.slice(0, j + 1), { ...f }, ...fields.slice(j + 1)] })}
                            onRemove={() => set({ fields: fields.filter((_, k) => k !== j) })}
                        />
                    ))}
                    <div>
                        <button type="button" className="dh-btn primary" onClick={() => set({ fields: [...fields, { name: "", value: "", inline: false }] })} disabled={fields.length >= LIMITS.fields}>
                            Add Field
                        </button>
                    </div>
                </Fold>

                <Fold title="Images" summary={[e.image?.url && "image", e.thumbnail?.url && "thumbnail"].filter(Boolean).join(", ")} defaultOpen={!!(e.thumbnail?.url || e.image?.url)}>
                    <TextBox label="Image (big, below)" value={e.image?.url} placeholder="https://…png" onChange={(v) => set({ image: v ? { url: v } : undefined })} />
                    <TextBox label="Thumbnail (small, right)" value={e.thumbnail?.url} placeholder="https://…png" onChange={(v) => set({ thumbnail: v ? { url: v } : undefined })} />
                </Fold>

                <Fold title="Footer" summary={[short(e.footer?.text, 26), e.timestamp ? "time" : ""].filter(Boolean).join(" · ")} defaultOpen={!!(e.footer?.text || e.timestamp)}>
                    <TextBox label="Text" value={e.footer?.text} max={LIMITS.footer} onChange={(v) => setIn("footer", { text: v })} />
                    <TextBox label="Icon" value={e.footer?.icon_url} placeholder="https://…" onChange={(v) => setIn("footer", { icon_url: v })} />
                    <label className="dh-field">
                        <span className="dh-label">Timestamp</span>
                        <div className="dh-row">
                            <input
                                type="datetime-local"
                                className="dh-input"
                                style={{ width: "auto", colorScheme: "dark" }}
                                value={toLocalInput(e.timestamp)}
                                onChange={(ev) => set({ timestamp: ev.target.value ? new Date(ev.target.value).toISOString() : undefined })}
                            />
                            <button type="button" className="dh-btn secondary" onClick={() => set({ timestamp: new Date().toISOString() })}>
                                Now
                            </button>
                            {e.timestamp && (
                                <button type="button" className="dh-btn secondary" onClick={() => set({ timestamp: undefined })}>
                                    Clear
                                </button>
                            )}
                        </div>
                        <span className="dh-hint">Shown in each reader's own time zone.</span>
                    </label>
                </Fold>
            </Fold>
        </div>
    );
}

/** Rows of link buttons, each row a card like Discohook's "Row 1". */
function ButtonRows({ rows, onChange }) {
    const setItem = (r, k, patch) => onChange(rows.map((row, i) => (i === r ? row.map((b, j) => (j === k ? { ...b, ...patch } : b)) : row)));
    const removeItem = (r, k) => onChange(rows.map((row, i) => (i === r ? row.filter((_, j) => j !== k) : row)).filter((row) => row.length));
    const moveItem = (r, k, d) => onChange(rows.map((row, i) => (i === r ? move(row, k, d) : row)));
    const addTo = (r) => onChange(rows.map((row, i) => (i === r ? [...row, { label: "", url: "https://", emoji: "" }] : row)));
    return rows.map((row, r) => (
        <div key={r} className="dh-card">
            <Fold
                title={`Row ${r + 1}`}
                summary={short(row.map((b) => b.label || b.emoji).filter(Boolean).join(", "), 40)}
                defaultOpen
                right={
                    <>
                        <IconBtn icon="chevronUp" onClick={() => onChange(move(rows, r, -1))} disabled={r === 0} title="Move up" />
                        <IconBtn icon="chevronDown" onClick={() => onChange(move(rows, r, 1))} disabled={r === rows.length - 1} title="Move down" />
                        <IconBtn icon="copy" onClick={() => onChange([...rows.slice(0, r + 1), row.map((b) => ({ ...b })), ...rows.slice(r + 1)])} disabled={rows.length >= LIMITS.rows} title="Duplicate row" />
                        <IconBtn icon="trash" onClick={() => onChange(rows.filter((_, i) => i !== r))} danger title="Remove row" />
                    </>
                }
            >
                {row.map((b, k) => (
                    <div key={k} className="dh-card">
                        <Fold
                            title={
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                    <Icon name="externalLink" size={14} />
                                    {short(b.label || b.emoji || "Link button", 30)}
                                </span>
                            }
                            defaultOpen={!b.label}
                            right={
                                <>
                                    <IconBtn icon="chevronUp" onClick={() => moveItem(r, k, -1)} disabled={k === 0} title="Move left" />
                                    <IconBtn icon="chevronDown" onClick={() => moveItem(r, k, 1)} disabled={k === row.length - 1} title="Move right" />
                                    <IconBtn icon="trash" onClick={() => removeItem(r, k)} danger title="Remove button" />
                                </>
                            }
                        >
                            <div className="dh-grid">
                                <TextBox label="Label" value={b.label} max={LIMITS.label} onChange={(v) => setItem(r, k, { label: v })} />
                                <TextBox label="Emoji" value={b.emoji} placeholder="🔥 or <:name:id>" onChange={(v) => setItem(r, k, { emoji: v })} />
                            </div>
                            <TextBox label="Link" value={b.url} placeholder="https://…" onChange={(v) => setItem(r, k, { url: v })} />
                        </Fold>
                    </div>
                ))}
                <div>
                    <button type="button" className="dh-btn primary" onClick={() => addTo(r)} disabled={row.length >= LIMITS.buttons}>
                        Add Button
                    </button>
                </div>
            </Fold>
        </div>
    ));
}

/** Mentions into the last text box used: @everyone, @here, a role, a channel. */
function InsertBar({ roles, channels, insert }) {
    return (
        <div className="dh-insert">
            <button type="button" className="dh-btn secondary" onClick={() => insert("@everyone")} title="Pings everyone who can see the channel">
                @everyone
            </button>
            <button type="button" className="dh-btn secondary" onClick={() => insert("@here")} title="Pings everyone online who can see the channel">
                @here
            </button>
            <select className="dh-input" value="" disabled={!roles.length} onChange={(e) => e.target.value && insert(`<@&${e.target.value}>`)} title={roles.length ? "Mention a role" : "Pick a server first"}>
                <option value="">@ Role…</option>
                {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                        @{r.name}
                        {r.mentionable ? "" : " (not mentionable)"}
                    </option>
                ))}
            </select>
            <select className="dh-input" value="" disabled={!channels.length} onChange={(e) => e.target.value && insert(`<#${e.target.value}>`)} title={channels.length ? "Link a channel" : "Pick a server first"}>
                <option value="">#&nbsp;Channel…</option>
                {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                        #{c.name}
                    </option>
                ))}
            </select>
        </div>
    );
}

/**
 * value = { content, embeds, components } (format.js "editor" shape).
 * components === null: the message's own buttons/menus are kept as they are
 * (a message whose buttons run the bot's features) — not editable here.
 * roles / channels: the target server's, for the insert bar.
 * extra: folds shown after the content (profile, files); footer: buttons
 * next to "Add".
 */
export default function MessageEditor({ value, onChange, roles = [], channels = [], extra = null, footer = null }) {
    const embeds = value.embeds || [];
    const set = (patch) => onChange({ ...value, ...patch });
    const setEmbeds = (next) => set({ embeds: next });
    const active = useRef(null);
    const contentRef = useRef(null);
    const latest = useRef(set);
    latest.current = set;
    const contentTarget = useRef(null);
    contentTarget.current ||= { get el() { return contentRef.current; }, apply: (v) => latest.current({ content: v }), pos: null };
    const toContent = contentTarget.current;
    // Which embeds are unfolded, kept in step with add / move / duplicate / remove.
    const [open, setOpen] = useState(() => embeds.map((_, i) => embeds.length <= 2 || i === 0));
    const flags = () => embeds.map((_, i) => !!open[i]);

    const insert = (token) => {
        const a = active.current?.el && document.body.contains(active.current.el) ? active.current : toContent;
        const el = a.el;
        if (!el) return set({ content: `${value.content || ""}${token}` });
        const cur = el.value ?? "";
        // The button or menu that called this has the focus now: use where the
        // caret was when the text box was left (kept on blur), else the end.
        const live = document.activeElement === el;
        let start = live ? el.selectionStart : a.pos?.start;
        let end = live ? el.selectionEnd : a.pos?.end;
        if (start == null || start > cur.length) start = cur.length;
        if (end == null || end > cur.length || end < start) end = start;
        const needsSpace = start > 0 && !/\s$/.test(cur.slice(0, start));
        const needsTrail = end < cur.length && !/^\s/.test(cur.slice(end));
        const text = `${needsSpace ? " " : ""}${token}${needsTrail ? " " : ""}`;
        const caret = start + text.length;
        a.pos = { start: caret, end: caret };
        a.apply(cur.slice(0, start) + text + cur.slice(end));
        setTimeout(() => {
            if (!document.body.contains(el)) return;
            el.focus();
            el.setSelectionRange(caret, caret);
        }, 0);
    };

    const rows = value.components || [];
    const rowsFull = rows.length >= LIMITS.rows;
    const content = value.content || "";
    return (
        <Active.Provider value={{ setActive: (a) => (active.current = a) }}>
            <div className="dh-message-body">
                <div className="dh-field">
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "space-between" }}>
                        <span className="dh-label">
                            Content <Count n={content.length} max={LIMITS.content} />
                        </span>
                        <InsertBar roles={roles} channels={channels} insert={insert} />
                    </div>
                    <textarea
                        ref={contentRef}
                        className="dh-input"
                        rows={4}
                        value={content}
                        placeholder="The text above the embeds — markdown, emoji and mentions work. Only mentions here can ping."
                        spellCheck={false}
                        onChange={(e) => set({ content: e.target.value })}
                        onFocus={() => (active.current = toContent)}
                        onBlur={(e) => (toContent.pos = { start: e.target.selectionStart, end: e.target.selectionEnd })}
                        style={{ minHeight: 110 }}
                    />
                </div>

                {extra}

                {embeds.length > 1 && (
                    <div className="dh-meta" style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <span style={{ flex: 1 }}>
                            {embeds.length} embeds · {embeds.reduce((n, e) => n + embedChars(e), 0)}/{LIMITS.embedTotal} characters
                        </span>
                        <button type="button" onClick={() => setOpen(embeds.map(() => true))}>
                            Open all
                        </button>
                        <button type="button" onClick={() => setOpen(embeds.map(() => false))}>
                            Close all
                        </button>
                    </div>
                )}
                {embeds.map((e, i) => (
                    <EmbedEditor
                        key={i}
                        e={e}
                        i={i}
                        count={embeds.length}
                        open={!!open[i]}
                        onToggle={(o) => setOpen(flags().map((x, k) => (k === i ? o : x)))}
                        onChange={(ne) => setEmbeds(embeds.map((x, k) => (k === i ? ne : x)))}
                        onRemove={() => {
                            setEmbeds(embeds.filter((_, k) => k !== i));
                            setOpen(flags().filter((_, k) => k !== i));
                        }}
                        onMove={(d) => {
                            setEmbeds(move(embeds, i, d));
                            setOpen(move(flags(), i, d));
                        }}
                        onDuplicate={() => {
                            setEmbeds([...embeds.slice(0, i + 1), JSON.parse(JSON.stringify(e)), ...embeds.slice(i + 1)]);
                            const f = flags();
                            setOpen([...f.slice(0, i + 1), true, ...f.slice(i + 1)]);
                        }}
                    />
                ))}

                {value.components === null ? (
                    <div className="dh-note">This message has buttons or menus that run a bot's own features. They stay exactly as they are — only the text and embeds change.</div>
                ) : (
                    <ButtonRows rows={rows} onChange={(next) => set({ components: next })} />
                )}

                <div className="dh-row">
                    <AddMenu
                        items={[
                            {
                                label: `Embed (${embeds.length}/${LIMITS.embeds})`,
                                icon: "fileText",
                                disabled: embeds.length >= LIMITS.embeds,
                                onClick: () => {
                                    setEmbeds([...embeds, emptyEmbed()]);
                                    setOpen([...flags(), true]);
                                },
                            },
                            {
                                label: `Row of link buttons (${value.components === null ? "kept" : `${rows.length}/${LIMITS.rows}`})`,
                                icon: "externalLink",
                                disabled: value.components === null || rowsFull,
                                title: "Link buttons open a website, a Discord channel or an invite",
                                onClick: () => set({ components: [...rows, [{ label: "", url: "https://", emoji: "" }]] }),
                            },
                        ]}
                    />
                    {footer}
                </div>
            </div>
        </Active.Provider>
    );
}
