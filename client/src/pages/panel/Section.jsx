import { Icon } from "../../components/ui";

/**
 * A titled card on the Panel Settings tabs. `icon` is an Icon name; `danger`
 * marks what can replace data or move the panel. `actions` sit at the right
 * of the title row; `flush` drops the body's padding. With no children the
 * card is just its title row.
 */
export default function Section({ icon, title, hint, danger = false, actions, flush = false, children }) {
    const hasBody = children != null && children !== false;
    return (
        <div className="card" style={{ padding: 0, overflow: "hidden", ...(danger ? { borderColor: "var(--danger-border)" } : {}) }}>
            <div style={{ padding: "12px 16px", borderBottom: hasBody ? "1px solid var(--border)" : "none", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {icon && <Icon name={icon} style={{ color: danger ? "var(--danger)" : "var(--text-dim)" }} />}
                <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{title}</h2>
                {hint && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{hint}</span>}
                {actions && <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>{actions}</div>}
            </div>
            {hasBody && <div style={flush ? undefined : { padding: 16 }}>{children}</div>}
        </div>
    );
}
