import { createContext, useContext, useRef, useState } from "react";
import { LIMITS, embedChars, emptyEmbed, fromHex, hex } from "./format";

// Discohook-style editor of one message: content, up to 10 embeds (author,
// title, description, colour, fields, images, footer, time) and rows of link
// buttons. Mentions (@everyone, @here, a role, a channel) go in at the caret
// of the last text box used — content by default.

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

function Count({ n, max }) {
    const cls = n > max ? "over" : n > max * 0.9 ? "near" : "";
    return <span className={`msg-count ${cls}`}>{n}/{max}</span>;
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
        className: "input",
        value: v,
        placeholder,
        onChange: (e) => onChange(e.target.value),
        onFocus: () => setActive(target.current),
        onBlur: (e) => (target.current.pos = { start: e.target.selectionStart, end: e.target.selectionEnd }),
        spellCheck: false,
        "aria-label": hideLabel ? label : undefined,
        style: { fontSize: 13, fontFamily: mono ? "var(--font-mono, ui-monospace, monospace)" : undefined, ...(multiline ? { resize: "vertical", minHeight: rows * 20 + 16, lineHeight: 1.5 } : {}) },
    };
    return (
        <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            {!hideLabel && (
                <span className="msg-label">
                    <span>{label}</span>
                    {max && v.length > 0 && <Count n={v.length} max={max} />}
                </span>
            )}
            {multiline ? <textarea rows={rows} {...props} /> : <input {...props} />}
        </label>
    );
}

const Mini = ({ children, onClick, title, danger, disabled }) => (
    <button type="button" className="btn-ghost msg-mini" style={danger ? { color: "var(--danger)" } : undefined} onClick={onClick} title={title} disabled={disabled}>
        {children}
    </button>
);

function Section({ title, right, children, open, onToggle, summary }) {
    const collapsible = !!onToggle;
    return (
        <div className={`msg-section ${collapsible && !open ? "closed" : ""}`}>
            <div className="msg-section-head" style={{ cursor: collapsible ? "pointer" : "default" }} onClick={() => collapsible && onToggle(!open)}>
                <span className="msg-section-title">
                    {collapsible && <span className="msg-caret">{open ? "▾" : "▸"}</span>}
                    {title}
                    {collapsible && !open && summary && <span className="msg-sum">{summary}</span>}
                </span>
                {right && (
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                        {right}
                    </div>
                )}
            </div>
            {(!collapsible || open) && children}
        </div>
    );
}

/** A fold inside an embed — starts open only when it has something. */
function Sub({ title, summary, defaultOpen, children }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className="msg-sub">
            <button type="button" className="msg-sub-head" onClick={() => setOpen(!open)}>
                <span className="msg-caret">{open ? "▾" : "▸"}</span>
                <span>{title}</span>
                {!open && summary && <span className="msg-sum">{summary}</span>}
            </button>
            {open && <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>}
        </div>
    );
}

function ColorField({ value, onChange }) {
    const [text, setText] = useState(null); // what is being typed, until it is a colour
    const shown = text ?? (typeof value === "number" ? hex(value) : "");
    return (
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="msg-label">Colour</span>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                    type="color"
                    value={typeof value === "number" ? hex(value) : "#1e1f22"}
                    onChange={(e) => {
                        setText(null);
                        onChange(fromHex(e.target.value));
                    }}
                    style={{ width: 36, height: 32, padding: 0, border: "none", background: "none", cursor: "pointer" }}
                />
                <input
                    className="input mono"
                    value={shown}
                    placeholder="none"
                    onChange={(e) => {
                        setText(e.target.value);
                        if (!e.target.value.trim()) onChange(null);
                        else if (fromHex(e.target.value) != null) onChange(fromHex(e.target.value));
                    }}
                    onBlur={() => setText(null)}
                    style={{ fontSize: 13 }}
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

function FieldRow({ f, j, count, onChange, onMove, onRemove }) {
    return (
        <div className="msg-field">
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className="msg-field-n">{j + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <TextBox hideLabel label={`Field ${j + 1} name`} placeholder="Name" value={f.name} onChange={(v) => onChange({ name: v })} />
                </div>
                <label className="msg-check" title="Show beside the fields next to it">
                    <input type="checkbox" checked={!!f.inline} onChange={(ev) => onChange({ inline: ev.target.checked })} /> Inline
                </label>
                <Mini onClick={() => onMove(-1)} disabled={j === 0} title="Up">↑</Mini>
                <Mini onClick={() => onMove(1)} disabled={j === count - 1} title="Down">↓</Mini>
                <Mini onClick={onRemove} danger title="Remove field">✕</Mini>
            </div>
            <TextBox hideLabel label={`Field ${j + 1} value`} placeholder="Value" value={f.value} onChange={(v) => onChange({ value: v })} multiline rows={2} />
            {(f.name?.length > LIMITS.fieldName * 0.9 || f.value?.length > LIMITS.fieldValue * 0.9) && (
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                    <Count n={f.name?.length || 0} max={LIMITS.fieldName} />
                    <Count n={f.value?.length || 0} max={LIMITS.fieldValue} />
                </div>
            )}
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
    const head = short(e.title || e.author?.name || e.description, 34);
    const chars = embedChars(e);
    const summary = [fields.length ? `${fields.length} field${fields.length === 1 ? "" : "s"}` : "", e.image?.url || e.thumbnail?.url ? "image" : ""].filter(Boolean).join(" · ");
    return (
        <Section
            title={
                <>
                    {typeof e.color === "number" && <span className="msg-swatch" style={{ background: hex(e.color) }} />}
                    <span style={{ whiteSpace: "nowrap" }}>Embed {i + 1}</span>
                    {head && <span className="msg-sum">{head}</span>}
                </>
            }
            summary={summary}
            open={open}
            onToggle={onToggle}
            right={
                <>
                    {chars > LIMITS.embedTotal * 0.5 && <Count n={chars} max={LIMITS.embedTotal} />}
                    <Mini onClick={() => onMove(-1)} disabled={i === 0} title="Up">↑</Mini>
                    <Mini onClick={() => onMove(1)} disabled={i === count - 1} title="Down">↓</Mini>
                    <Mini onClick={onDuplicate} disabled={count >= LIMITS.embeds} title="Duplicate">⧉</Mini>
                    <Mini onClick={onRemove} danger title="Remove embed">✕</Mini>
                </>
            }
        >
            <Sub title="Author" summary={short(e.author?.name, 30)} defaultOpen={!!e.author?.name}>
                <div className="msg-grid2">
                    <TextBox label="Name" value={e.author?.name} max={LIMITS.author} onChange={(v) => setIn("author", { name: v })} />
                    <TextBox label="Link" value={e.author?.url} placeholder="https://" onChange={(v) => setIn("author", { url: v })} />
                    <TextBox label="Icon (image link)" value={e.author?.icon_url} placeholder="https://" onChange={(v) => setIn("author", { icon_url: v })} />
                </div>
            </Sub>

            <div className="msg-grid2">
                <TextBox label="Title" value={e.title} max={LIMITS.title} onChange={(v) => set({ title: v })} />
                <TextBox label="Title link" value={e.url} placeholder="https://" onChange={(v) => set({ url: v })} />
                <ColorField value={e.color} onChange={(v) => set({ color: v })} />
            </div>
            <TextBox label="Description" value={e.description} max={LIMITS.description} onChange={(v) => set({ description: v })} multiline rows={4} />

            <Sub title={`Fields (${fields.length}/${LIMITS.fields})`} summary={short(fields.map((f) => f.name).filter(Boolean).join(", "), 40)} defaultOpen={fields.length > 0}>
                {fields.map((f, j) => (
                    <FieldRow
                        key={j}
                        f={f}
                        j={j}
                        count={fields.length}
                        onChange={(patch) => setField(j, patch)}
                        onMove={(d) => set({ fields: move(fields, j, d) })}
                        onRemove={() => set({ fields: fields.filter((_, k) => k !== j) })}
                    />
                ))}
                <div>
                    <Mini onClick={() => set({ fields: [...fields, { name: "", value: "", inline: false }] })} disabled={fields.length >= LIMITS.fields}>
                        + Field
                    </Mini>
                </div>
            </Sub>

            <Sub title="Images" summary={[e.thumbnail?.url && "thumbnail", e.image?.url && "image"].filter(Boolean).join(", ")} defaultOpen={!!(e.thumbnail?.url || e.image?.url)}>
                <div className="msg-grid2">
                    <TextBox label="Image (big, below)" value={e.image?.url} placeholder="https://…png" onChange={(v) => set({ image: v ? { url: v } : undefined })} />
                    <TextBox label="Thumbnail (small, right)" value={e.thumbnail?.url} placeholder="https://…png" onChange={(v) => set({ thumbnail: v ? { url: v } : undefined })} />
                </div>
            </Sub>

            <Sub title="Footer & time" summary={[short(e.footer?.text, 26), e.timestamp ? "time" : ""].filter(Boolean).join(" · ")} defaultOpen={!!(e.footer?.text || e.timestamp)}>
                <div className="msg-grid2">
                    <TextBox label="Footer" value={e.footer?.text} max={LIMITS.footer} onChange={(v) => setIn("footer", { text: v })} />
                    <TextBox label="Footer icon (image link)" value={e.footer?.icon_url} placeholder="https://" onChange={(v) => setIn("footer", { icon_url: v })} />
                </div>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span className="msg-label">Time (shown in each reader's own time zone)</span>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <input
                            type="datetime-local"
                            className="input"
                            style={{ width: "auto", fontSize: 13 }}
                            value={toLocalInput(e.timestamp)}
                            onChange={(ev) => set({ timestamp: ev.target.value ? new Date(ev.target.value).toISOString() : undefined })}
                        />
                        <Mini onClick={() => set({ timestamp: new Date().toISOString() })}>Now</Mini>
                        {e.timestamp && <Mini onClick={() => set({ timestamp: undefined })}>Clear</Mini>}
                    </div>
                </label>
            </Sub>
        </Section>
    );
}

function ButtonsEditor({ rows, onChange }) {
    const setItem = (r, k, patch) => onChange(rows.map((row, i) => (i === r ? row.map((b, j) => (j === k ? { ...b, ...patch } : b)) : row)));
    const removeItem = (r, k) => onChange(rows.map((row, i) => (i === r ? row.filter((_, j) => j !== k) : row)).filter((row) => row.length));
    const shift = (r, k, d) => {
        const target = r + d;
        if (target < 0 || target >= LIMITS.rows) return;
        const next = rows.map((row) => [...row]);
        const [item] = next[r].splice(k, 1);
        if (!next[target]) next[target] = [];
        if (next[target].length >= LIMITS.buttons) return;
        next[target].push(item);
        onChange(next.filter((row) => row.length));
    };
    const add = () => {
        const last = rows[rows.length - 1];
        const btn = { label: "", url: "https://", emoji: "" };
        if (last && last.length < LIMITS.buttons) onChange([...rows.slice(0, -1), [...last, btn]]);
        else onChange([...rows, [btn]]);
    };
    const full = rows.length >= LIMITS.rows && rows[rows.length - 1]?.length >= LIMITS.buttons;
    return (
        <Section title={`Link buttons (${rows.flat().length})`} right={<Mini onClick={add} disabled={full}>+ Button</Mini>}>
            {!rows.length && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>No buttons. Link buttons open a website, a Discord channel or an invite.</div>}
            {rows.map((row, r) => (
                <div key={r} className="msg-button-row">
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Row {r + 1}</span>
                    {row.map((b, k) => (
                        <div key={k} style={{ display: "flex", gap: 6, alignItems: "flex-end", flexWrap: "wrap" }}>
                            <div style={{ flex: "1 1 120px" }}>
                                <TextBox label="Label" value={b.label} max={LIMITS.label} onChange={(v) => setItem(r, k, { label: v })} />
                            </div>
                            <div style={{ width: 110 }}>
                                <TextBox label="Emoji" value={b.emoji} placeholder="🔥 or <:x:id>" onChange={(v) => setItem(r, k, { emoji: v })} />
                            </div>
                            <div style={{ flex: "2 1 200px" }}>
                                <TextBox label="Link" value={b.url} placeholder="https://" onChange={(v) => setItem(r, k, { url: v })} />
                            </div>
                            <Mini onClick={() => shift(r, k, -1)} disabled={r === 0} title="To the row above">↑</Mini>
                            <Mini onClick={() => shift(r, k, 1)} disabled={r >= LIMITS.rows - 1} title="To the row below">↓</Mini>
                            <Mini onClick={() => removeItem(r, k)} danger title="Remove">✕</Mini>
                        </div>
                    ))}
                </div>
            ))}
        </Section>
    );
}

/** Mentions into the last text box used: @everyone, @here, a role, a channel. */
function InsertBar({ roles, channels, insert }) {
    return (
        <div className="msg-insert">
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>Insert</span>
            <Mini onClick={() => insert("@everyone")} title="Pings everyone who can see the channel">@everyone</Mini>
            <Mini onClick={() => insert("@here")} title="Pings everyone online who can see the channel">@here</Mini>
            <select
                className="input"
                value=""
                disabled={!roles.length}
                onChange={(e) => e.target.value && insert(`<@&${e.target.value}>`)}
                title={roles.length ? "Mention a role" : "Pick a server first"}
            >
                <option value="">@ Role…</option>
                {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                        @{r.name}
                        {r.mentionable ? "" : " (not mentionable)"}
                    </option>
                ))}
            </select>
            <select
                className="input"
                value=""
                disabled={!channels.length}
                onChange={(e) => e.target.value && insert(`<#${e.target.value}>`)}
                title={channels.length ? "Link a channel" : "Pick a server first"}
            >
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
 */
export default function MessageEditor({ value, onChange, roles = [], channels = [] }) {
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

    const content = value.content || "";
    return (
        <Active.Provider value={{ setActive: (a) => (active.current = a) }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Section title="Content" right={<Count n={content.length} max={LIMITS.content} />}>
                    <InsertBar roles={roles} channels={channels} insert={insert} />
                    <textarea
                        ref={contentRef}
                        className="input"
                        rows={4}
                        value={content}
                        placeholder="The text above the embeds — markdown, emoji and mentions work. Only mentions here can ping."
                        spellCheck={false}
                        onChange={(e) => set({ content: e.target.value })}
                        onFocus={() => (active.current = toContent)}
                        onBlur={(e) => (toContent.pos = { start: e.target.selectionStart, end: e.target.selectionEnd })}
                        style={{ resize: "vertical", minHeight: 96, fontSize: 13, lineHeight: 1.5 }}
                    />
                </Section>

                {embeds.length > 1 && (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "0 2px" }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>
                            {embeds.length} embeds · {embeds.reduce((n, e) => n + embedChars(e), 0)}/{LIMITS.embedTotal} characters
                        </span>
                        <span style={{ display: "flex", gap: 4 }}>
                            <Mini onClick={() => setOpen(embeds.map(() => true))}>Open all</Mini>
                            <Mini onClick={() => setOpen(embeds.map(() => false))}>Close all</Mini>
                        </span>
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
                <button
                    type="button"
                    className="btn-ghost"
                    disabled={embeds.length >= LIMITS.embeds}
                    onClick={() => {
                        setEmbeds([...embeds, emptyEmbed()]);
                        setOpen([...flags(), true]);
                    }}
                >
                    + Add embed ({embeds.length}/{LIMITS.embeds})
                </button>

                {value.components === null ? (
                    <Section title="Buttons and menus">
                        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                            This message has buttons or menus that run the bot's own features. They stay exactly as they are — only the text and embeds change.
                        </div>
                    </Section>
                ) : (
                    <ButtonsEditor rows={value.components || []} onChange={(rows) => set({ components: rows })} />
                )}
            </div>
        </Active.Provider>
    );
}
