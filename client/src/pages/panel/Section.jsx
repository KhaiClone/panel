/** A titled card on the Panel Settings tabs. `danger` marks what can replace data or move the panel. */
export default function Section({ icon, title, hint, danger = false, children }) {
    return (
        <div className="card" style={{ padding: 0, overflow: "hidden", ...(danger ? { border: "1px solid rgba(239,68,68,0.3)" } : {}) }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 16 }}>{icon}</span>
                <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>{title}</h2>
                {hint && <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>{hint}</span>}
            </div>
            <div style={{ padding: 16 }}>{children}</div>
        </div>
    );
}
