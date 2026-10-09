// The colour of a group or tag is the admin's own choice, so these are data,
// not theme tokens: it only ever shows as a small dot.
export const PRESET_COLORS = [
    "#6366f1", "#3b82f6", "#0ea5e9", "#14b8a6", "#10b981", "#84cc16",
    "#eab308", "#f97316", "#ef4444", "#ec4899", "#a855f7", "#64748b",
];

export default function ColorPicker({ value, onChange }) {
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {PRESET_COLORS.map((c) => (
                <button
                    key={c}
                    type="button"
                    title={c}
                    aria-label={`Colour ${c}`}
                    aria-pressed={value === c}
                    onClick={() => onChange(c)}
                    style={{
                        width: 20, height: 20, borderRadius: "50%", background: c, cursor: "pointer", border: "none", padding: 0,
                        outline: value === c ? "2px solid var(--text)" : "2px solid transparent",
                        outlineOffset: 2,
                    }}
                />
            ))}
            <input
                type="color"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                title="Custom colour"
                style={{ width: 28, height: 28, borderRadius: 6, cursor: "pointer", border: "1px solid var(--border)", background: "var(--bg-input)", padding: 3 }}
            />
            <span className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>{value}</span>
        </div>
    );
}
