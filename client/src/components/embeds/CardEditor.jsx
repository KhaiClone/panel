import Field from "./Field";
import { SelectsEditor } from "./MessageEditor";

// Editor of a "card" — the words of a Components V2 view whose layout the bot
// builds (lists of decors, menus). Colour, every text slot, every button's
// label / emoji / style and the menus' texts. value = the panel's version
// (any subset); empty slots fall back to the default.

const STYLES = ["Primary", "Secondary", "Success", "Danger"];

export default function CardEditor({ value, def, onChange }) {
    const d = def.default || {};
    const texts = { ...(d.texts || {}), ...(value.texts || {}) };
    const buttons = d.buttons || {};
    const set = (patch) => onChange({ ...value, ...patch });
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {d.color != null && (
                <div className="emb-section">
                    <span className="emb-section-title">Màu</span>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                            type="color"
                            value={/^#[0-9a-f]{6}$/i.test(String(value.color ?? d.color)) ? value.color ?? d.color : "#9f92ff"}
                            onChange={(e) => set({ color: e.target.value })}
                            style={{ width: 36, height: 32, padding: 0, border: "none", background: "none" }}
                        />
                        <div style={{ flex: 1 }}>
                            <Field value={value.color ?? d.color} onChange={(v) => set({ color: v })} />
                        </div>
                    </div>
                </div>
            )}
            <div className="emb-section">
                <span className="emb-section-title">Chữ</span>
                <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
                    Mỗi ô là một đoạn chữ riêng, tên ô cho biết lúc nào bot dùng nó. Bot tự đặt từng đoạn vào chỗ của nó — có thể chung một tin, có thể là các câu trả lời
                    khác nhau — nên bên xem trước mỗi đoạn có khung riêng.
                </p>
                {Object.keys(texts).map((slot) => (
                    <Field
                        key={slot}
                        label={slot}
                        slot={slot}
                        value={texts[slot]}
                        onChange={(v) => set({ texts: { ...(value.texts || {}), [slot]: v } })}
                        multiline={String(texts[slot] || "").length > 60 || String(texts[slot] || "").includes("\n")}
                        rows={Math.min(8, String(texts[slot] || "").split("\n").length + 1)}
                        hint={def.slotVars?.[slot] ? `Phần này có thêm biến riêng — xem bảng biến khi đang sửa.` : undefined}
                    />
                ))}
            </div>
            {Object.keys(buttons).length > 0 && (
                <div className="emb-section">
                    <span className="emb-section-title">Nút</span>
                    {Object.keys(buttons).map((slot) => {
                        const cur = { ...(buttons[slot] || {}), ...(value.buttons?.[slot] || {}) };
                        const setB = (patch) => set({ buttons: { ...(value.buttons || {}), [slot]: { ...(value.buttons?.[slot] || {}), ...patch } } });
                        return (
                            <div key={slot} style={{ display: "flex", gap: 6, alignItems: "flex-end", flexWrap: "wrap" }}>
                                <span className="badge" style={{ alignSelf: "center", fontSize: 11 }}>nút {slot}</span>
                                <div style={{ flex: "1 1 140px" }}>
                                    <Field label="Nhãn" value={cur.label} onChange={(v) => setB({ label: v })} />
                                </div>
                                <div style={{ width: 90 }}>
                                    <Field label="Emoji" value={cur.emoji} onChange={(v) => setB({ emoji: v })} />
                                </div>
                                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                    <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>Kiểu</span>
                                    <select className="input" value={cur.style || "Secondary"} onChange={(e) => setB({ style: e.target.value })}>
                                        {STYLES.map((s) => <option key={s}>{s}</option>)}
                                    </select>
                                </label>
                            </div>
                        );
                    })}
                </div>
            )}
            <SelectsEditor selects={value.selects} defaults={d.selects} onChange={(sel) => set({ selects: sel })} />
        </div>
    );
}
