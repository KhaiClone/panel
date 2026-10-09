/** A form control with its label above and an optional hint below. */
export default function Field({ label, hint, children }) {
    return (
        <label style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>{label}</span>
            {children}
            {hint && <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>{hint}</span>}
        </label>
    );
}
