import { TONE_COLOR } from "./StatusBadge";

/**
 * One figure with its label. Flat: no coloured border; a `tone` only adds a
 * status dot before the label. Put several in a .stat-grid.
 *
 *   <StatCard label="Pending" value={12} tone="warning" hint="since Monday" />
 */
export default function StatCard({ label, value, tone, hint }) {
    return (
        <div className="stat-card">
            <div className="stat-label">
                {tone && <span className="status-dot" style={{ background: TONE_COLOR[tone] || tone }} />}
                {label}
            </div>
            <div className="stat-value">{value}</div>
            {hint && <div className="stat-hint">{hint}</div>}
        </div>
    );
}
