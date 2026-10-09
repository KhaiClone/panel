// A status is a coloured dot and a word; the dot carries the colour, the word
// stays readable. Styled by .status-badge in index.css.
//
//   <StatusBadge tone="success">Online</StatusBadge>

export const TONE_COLOR = {
    success: "var(--success)",
    warning: "var(--warning)",
    danger: "var(--danger)",
    accent: "var(--accent-hover)",
    info: "var(--info)",
    neutral: "var(--text-dim)",
};

export default function StatusBadge({ tone = "neutral", color, title, children }) {
    return (
        <span className="status-badge" title={title}>
            <span className="status-dot" style={{ background: color || TONE_COLOR[tone] || TONE_COLOR.neutral }} />
            {children}
        </span>
    );
}
