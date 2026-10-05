import { useState } from "react";
import Field from "./Field";

// Discohook-style editor of a message template: content, up to 10 embeds
// (author, title, description, colour, fields, images, footer, timestamp, a
// show-if condition), the buttons (the bot's slots — label / emoji / style /
// place — plus link buttons) and the texts of its menus.

const STYLES = ["Primary", "Secondary", "Success", "Danger"];
const MAX_EMBEDS = 10;

const move = (arr, i, d) => {
    const j = i + d;
    if (j < 0 || j >= arr.length) return arr;
    const out = [...arr];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
};

function Section({ title, right, children, collapsible = false, defaultOpen = true, open: openProp, onToggle, summary }) {
    const [openState, setOpenState] = useState(defaultOpen);
    const open = openProp ?? openState;
    const toggle = () => (onToggle ? onToggle(!open) : setOpenState(!open));
    return (
        <div className={`emb-section ${collapsible && !open ? "closed" : ""}`}>
            <div className="emb-section-head" style={{ cursor: collapsible ? "pointer" : "default" }} onClick={() => collapsible && toggle()}>
                <span className="emb-section-title" style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    {collapsible && <span className="emb-caret">{open ? "▾" : "▸"}</span>}
                    {title}
                    {collapsible && !open && summary && <span className="emb-sum">{summary}</span>}
                </span>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                    {right}
                </div>
            </div>
            {(!collapsible || open) && children}
        </div>
    );
}

/** A fold inside an embed (author, fields, images…) — starts open only when it has something. */
function Sub({ title, summary, defaultOpen, children }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className="emb-sub">
            <div className="emb-sub-head" onClick={() => setOpen(!open)}>
                <span className="emb-caret">{open ? "▾" : "▸"}</span>
                <span>{title}</span>
                {!open && summary && <span className="emb-sum">{summary}</span>}
            </div>
            {open && <div className="emb-sub-body">{children}</div>}
        </div>
    );
}

const Mini = ({ children, onClick, title, danger, disabled, active }) => (
    <button
        type="button"
        className={`btn-ghost emb-mini ${active ? "emb-toggle on" : ""}`}
        style={danger ? { color: "var(--danger)" } : undefined}
        onClick={onClick}
        title={title}
        disabled={disabled}
    >
        {children}
    </button>
);

function ColorField({ value, onChange }) {
    const isHex = /^#[0-9a-f]{6}$/i.test(String(value || ""));
    return (
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>Màu</span>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="color" value={isHex ? value : "#9f92ff"} onChange={(e) => onChange(e.target.value)} style={{ width: 36, height: 32, padding: 0, border: "none", background: "none" }} />
                <div style={{ flex: 1 }}>
                    <Field value={typeof value === "number" ? `#${value.toString(16).padStart(6, "0")}` : value} onChange={onChange} placeholder="#9f92ff hoặc {biến}" />
                </div>
            </div>
        </label>
    );
}

const short = (v, n = 40) => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
};
const swatch = (c) => (/^#[0-9a-f]{6}$/i.test(String(c || "")) ? c : typeof c === "number" ? `#${c.toString(16).padStart(6, "0")}` : null);

/** One embed field: name + value, with show-if / repeat folded away unless used. */
function FieldRow({ f, j, count, onChange, onMove, onRemove }) {
    const [more, setMore] = useState(!!(f.if || f.each));
    return (
        <div className="emb-field">
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className="emb-field-n">{j + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <Field hideLabel label={`Tên field ${j + 1}`} placeholder="Tên field" value={f.name} onChange={(v) => onChange({ name: v })} />
                </div>
                <label className="emb-check" title="Hiện cùng hàng với field bên cạnh">
                    <input type="checkbox" checked={!!f.inline} onChange={(ev) => onChange({ inline: ev.target.checked })} /> Cùng hàng
                </label>
                <Mini onClick={() => setMore(!more)} active={more || !!(f.if || f.each)} title="Điều kiện hiện / lặp theo danh sách">⚙</Mini>
                <Mini onClick={() => onMove(-1)} disabled={j === 0} title="Lên">↑</Mini>
                <Mini onClick={() => onMove(1)} disabled={j === count - 1} title="Xuống">↓</Mini>
                <Mini onClick={onRemove} danger title="Xoá field">✕</Mini>
            </div>
            <Field hideLabel label={`Giá trị field ${j + 1}`} placeholder="Giá trị" value={f.value} onChange={(v) => onChange({ value: v })} multiline rows={1} />
            {more && (
                <div className="emb-grid2">
                    <Field hideLabel label={`Field ${j + 1} · hiện khi`} placeholder="Hiện khi… (vd: ticket)" value={f.if} onChange={(v) => onChange({ if: v || undefined })} />
                    <Field hideLabel label={`Field ${j + 1} · lặp theo`} placeholder="Lặp theo danh sách (vd: items)" value={f.each} onChange={(v) => onChange({ each: v || undefined })} />
                </div>
            )}
        </div>
    );
}

function EmbedEditor({ e, i, count, open, onToggle, onChange, onRemove, onMove, onDuplicate }) {
    const set = (patch) => onChange({ ...e, ...patch });
    const setIn = (key, patch) => {
        const next = { ...(e[key] || {}), ...patch };
        const empty = Object.values(next).every((v) => !v);
        set({ [key]: empty ? undefined : next });
    };
    const fields = e.fields || [];
    const setField = (j, patch) => set({ fields: fields.map((f, k) => (k === j ? { ...f, ...patch } : f)) });
    const color = swatch(e.color);
    const head = short(e.title || e.author?.name || e.description, 34);
    const summary = [fields.length ? `${fields.length} field` : "", e.image || e.thumbnail ? "ảnh" : "", e.if ? `khi ${short(e.if, 20)}` : ""].filter(Boolean).join(" · ");
    return (
        <Section
            title={
                <>
                    {color && <span className="emb-swatch" style={{ background: color }} />}
                    <span style={{ whiteSpace: "nowrap" }}>Embed {i + 1}</span>
                    {head && <span className="emb-sum emb-sum-title">{head}</span>}
                </>
            }
            summary={summary}
            collapsible
            open={open}
            onToggle={onToggle}
            right={
                <>
                    <Mini onClick={() => onMove(-1)} disabled={i === 0} title="Lên">↑</Mini>
                    <Mini onClick={() => onMove(1)} disabled={i === count - 1} title="Xuống">↓</Mini>
                    <Mini onClick={onDuplicate} disabled={count >= MAX_EMBEDS} title="Nhân bản">⧉</Mini>
                    <Mini onClick={onRemove} danger title="Xoá embed">✕</Mini>
                </>
            }
        >
            <div className="emb-grid2">
                <Field label="Tiêu đề" value={e.title} onChange={(v) => set({ title: v })} />
                <Field label="Link tiêu đề" value={e.url} onChange={(v) => set({ url: v })} />
                <ColorField value={e.color} onChange={(v) => set({ color: v })} />
            </div>
            <Field label="Mô tả" value={e.description} onChange={(v) => set({ description: v })} multiline rows={4} />

            <Sub title="Tác giả" summary={short(e.author?.name, 30)} defaultOpen={!!e.author}>
                <div className="emb-grid2">
                    <Field label="Tác giả" value={e.author?.name} onChange={(v) => setIn("author", { name: v })} />
                    <Field label="Ảnh tác giả (URL)" value={e.author?.icon_url} onChange={(v) => setIn("author", { icon_url: v })} />
                    <Field label="Link tác giả" value={e.author?.url} onChange={(v) => setIn("author", { url: v })} />
                </div>
            </Sub>

            <Sub title={`Field (${fields.length}/25)`} summary={short(fields.map((f) => f.name).filter(Boolean).join(", "), 40)} defaultOpen={fields.length > 0 && fields.length <= 6}>
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
                    <Mini onClick={() => set({ fields: [...fields, { name: "", value: "", inline: false }] })} disabled={fields.length >= 25}>+ Field</Mini>
                </div>
            </Sub>

            <Sub title="Ảnh" summary={[e.thumbnail && "thumbnail", e.image && "ảnh lớn"].filter(Boolean).join(", ")} defaultOpen={!!(e.thumbnail || e.image)}>
                <div className="emb-grid2">
                    <Field label="Thumbnail (URL)" value={e.thumbnail?.url} onChange={(v) => set({ thumbnail: v ? { url: v } : undefined })} />
                    <Field label="Ảnh lớn (URL)" value={e.image?.url} onChange={(v) => set({ image: v ? { url: v } : undefined })} />
                </div>
            </Sub>

            <Sub
                title="Footer & thời gian"
                summary={[short(e.footer?.text, 26), e.timestamp === true ? "lúc gửi" : e.timestamp ? String(e.timestamp) : ""].filter(Boolean).join(" · ")}
                defaultOpen={!!(e.footer || e.timestamp)}
            >
                <div className="emb-grid2">
                    <Field label="Footer" value={e.footer?.text} onChange={(v) => setIn("footer", { text: v })} />
                    <Field label="Ảnh footer (URL)" value={e.footer?.icon_url} onChange={(v) => setIn("footer", { icon_url: v })} />
                </div>
                <div className="emb-grid2">
                    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>Thời gian</span>
                        <select
                            className="input"
                            value={e.timestamp === true ? "now" : e.timestamp ? "var" : "none"}
                            onChange={(ev) => set({ timestamp: ev.target.value === "now" ? true : ev.target.value === "var" ? "{now}" : undefined })}
                        >
                            <option value="none">Không</option>
                            <option value="now">Lúc gửi</option>
                            <option value="var">Theo biến…</option>
                        </select>
                    </label>
                    {typeof e.timestamp === "string" && <Field label="Biến thời gian" value={e.timestamp} onChange={(v) => set({ timestamp: v })} />}
                </div>
            </Sub>

            <Sub title="Điều kiện hiện" summary={short(e.if, 30)} defaultOpen={!!e.if}>
                <Field label="Chỉ hiện embed khi…" placeholder="vd: !order.auto" value={e.if} onChange={(v) => set({ if: v || undefined })} />
            </Sub>
        </Section>
    );
}

function ButtonsEditor({ rows, slots, onChange }) {
    const placed = new Set(rows.flat().filter((b) => b.slot).map((b) => b.slot));
    const missing = Object.keys(slots).filter((s) => !placed.has(s));
    const setItem = (r, k, patch) => onChange(rows.map((row, i) => (i === r ? row.map((b, j) => (j === k ? { ...b, ...patch } : b)) : row)));
    const removeItem = (r, k) => onChange(rows.map((row, i) => (i === r ? row.filter((_, j) => j !== k) : row)).filter((row) => row.length));
    const moveRow = (r, k, d) => {
        const target = r + d;
        if (target < 0) return;
        const item = rows[r][k];
        const next = rows.map((row) => [...row]);
        next[r].splice(k, 1);
        if (!next[target]) next[target] = [];
        next[target].push(item);
        onChange(next.filter((row) => row.length));
    };
    return (
        <Section
            title="Nút"
            right={
                <>
                    {missing.map((s) => (
                        <Mini key={s} onClick={() => onChange([...rows, [{ slot: s }]])} title="Đặt nút này">+ {s}</Mini>
                    ))}
                    <Mini onClick={() => onChange([...rows, [{ type: "link", label: "Link", url: "https://" }]])} disabled={rows.length >= 5}>+ Nút link</Mini>
                </>
            }
        >
            {!rows.length && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Không có nút.</div>}
            {missing.length > 0 && (
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                    Nút của bot chưa đặt chỗ ({missing.join(", ")}) vẫn hiện ở hàng cuối khi bot cần — không thể bỏ nút bot cần.
                </div>
            )}
            {rows.map((row, r) => (
                <div key={r} style={{ display: "flex", flexDirection: "column", gap: 6, borderLeft: "2px solid var(--border)", paddingLeft: 8 }}>
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Hàng {r + 1}</span>
                    {row.map((b, k) => {
                        const d = b.slot ? slots[b.slot] || {} : {};
                        const isLink = !b.slot || d.style === "Link";
                        return (
                            <div key={k} style={{ display: "flex", gap: 6, alignItems: "flex-end", flexWrap: "wrap" }}>
                                <span className="badge" style={{ alignSelf: "center", fontSize: 11 }}>{b.slot ? `nút ${b.slot}` : "link"}</span>
                                <div style={{ flex: "1 1 120px" }}>
                                    <Field label="Nhãn" value={b.label ?? ""} placeholder={d.label || ""} onChange={(v) => setItem(r, k, { label: v || undefined })} />
                                </div>
                                <div style={{ width: 90 }}>
                                    <Field label="Emoji" value={b.emoji ?? ""} placeholder={d.emoji || ""} onChange={(v) => setItem(r, k, { emoji: v || undefined })} />
                                </div>
                                {!isLink && (
                                    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>Kiểu</span>
                                        <select className="input" value={b.style || d.style || "Secondary"} onChange={(ev) => setItem(r, k, { style: ev.target.value })}>
                                            {STYLES.map((s) => <option key={s}>{s}</option>)}
                                        </select>
                                    </label>
                                )}
                                {!b.slot && (
                                    <div style={{ flex: "1 1 160px" }}>
                                        <Field label="URL" value={b.url} onChange={(v) => setItem(r, k, { url: v })} />
                                    </div>
                                )}
                                <div style={{ width: 120 }}>
                                    <Field label="Hiện khi…" value={b.if} onChange={(v) => setItem(r, k, { if: v || undefined })} />
                                </div>
                                <Mini onClick={() => moveRow(r, k, -1)} disabled={r === 0} title="Lên hàng trên">↑</Mini>
                                <Mini onClick={() => moveRow(r, k, 1)} disabled={rows.length >= 5 && r === rows.length - 1} title="Xuống hàng dưới">↓</Mini>
                                <Mini onClick={() => removeItem(r, k)} danger title={b.slot ? "Bỏ khỏi bố cục (bot vẫn thêm lại nếu cần)" : "Xoá"}>✕</Mini>
                            </div>
                        );
                    })}
                </div>
            ))}
        </Section>
    );
}

export function SelectsEditor({ selects, defaults, onChange }) {
    const names = Object.keys(defaults || {});
    if (!names.length) return null;
    const get = (s) => ({ ...(defaults[s] || {}), ...(selects?.[s] || {}) });
    const set = (s, patch) => onChange({ ...(selects || {}), [s]: { ...(selects?.[s] || {}), ...patch } });
    return (
        <Section title="Menu chọn">
            {names.map((s) => {
                const cur = get(s);
                const d = defaults[s] || {};
                return (
                    <div key={s} style={{ display: "flex", flexDirection: "column", gap: 6, borderLeft: "2px solid var(--border)", paddingLeft: 8 }}>
                        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>menu {s}</span>
                        <div className="emb-grid2">
                            <Field label="Chữ mờ (placeholder)" slot={s} value={cur.placeholder} onChange={(v) => set(s, { placeholder: v })} />
                            {"label" in d && <Field label="Nhãn mỗi lựa chọn" slot={s} value={cur.label} onChange={(v) => set(s, { label: v })} />}
                            {"description" in d && <Field label="Mô tả mỗi lựa chọn" slot={s} value={cur.description} onChange={(v) => set(s, { description: v })} />}
                            {"emoji" in d && <Field label="Emoji mỗi lựa chọn" slot={s} value={cur.emoji} onChange={(v) => set(s, { emoji: v })} />}
                        </div>
                        {Object.keys(d.options || {}).map((val) => {
                            const o = { ...(d.options[val] || {}), ...(selects?.[s]?.options?.[val] || {}) };
                            const setOpt = (patch) => set(s, { options: { ...(selects?.[s]?.options || {}), [val]: { ...(selects?.[s]?.options?.[val] || {}), ...patch } } });
                            return (
                                <div key={val} className="emb-grid2">
                                    <Field label={`Lựa chọn "${val}" · nhãn`} slot={s} value={o.label} onChange={(v) => setOpt({ label: v })} />
                                    <Field label="Mô tả" slot={s} value={o.description} onChange={(v) => setOpt({ description: v })} />
                                    <Field label="Emoji" slot={s} value={o.emoji} onChange={(v) => setOpt({ emoji: v })} />
                                </div>
                            );
                        })}
                    </div>
                );
            })}
        </Section>
    );
}

/** value = { content, embeds, components, selects } (the panel's version of the template). */
export default function MessageEditor({ value, def, onChange }) {
    const embeds = value.embeds || [];
    const set = (patch) => onChange({ ...value, ...patch });
    const setEmbeds = (next) => set({ embeds: next });
    // Which embeds are unfolded, kept in step with add / move / duplicate /
    // remove. A message with many embeds starts with only the first one open.
    const [open, setOpen] = useState(() => embeds.map((_, i) => embeds.length <= 2 || i === 0));
    const flags = () => embeds.map((_, i) => !!open[i]);
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Section title="Nội dung" collapsible summary={short(value.content, 40) || "trống"}>
                <Field label="Nội dung" hideLabel value={value.content} onChange={(v) => set({ content: v })} multiline rows={3} placeholder="Chữ ngoài embed (tối đa 2000 ký tự)" />
            </Section>
            {embeds.length > 1 && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "0 2px" }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>
                        {embeds.length} embed · {flags().filter(Boolean).length} đang mở
                    </span>
                    <span style={{ display: "flex", gap: 4 }}>
                        <Mini onClick={() => setOpen(embeds.map(() => true))}>Mở hết</Mini>
                        <Mini onClick={() => setOpen(embeds.map(() => false))}>Thu hết</Mini>
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
                disabled={embeds.length >= MAX_EMBEDS}
                onClick={() => {
                    setEmbeds([...embeds, { description: "", color: "#9f92ff" }]);
                    setOpen([...flags(), true]);
                }}
            >
                + Thêm embed ({embeds.length}/{MAX_EMBEDS})
            </button>
            {(Object.keys(def.slots || {}).length > 0 || (value.components || []).length > 0) && (
                <ButtonsEditor rows={value.components || []} slots={def.slots || {}} onChange={(rows) => set({ components: rows })} />
            )}
            <SelectsEditor selects={value.selects} defaults={def.selects} onChange={(sel) => set({ selects: sel })} />
        </div>
    );
}
