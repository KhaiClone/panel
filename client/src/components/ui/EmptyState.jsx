import Icon from "./Icon";

/**
 * What a list shows when it has nothing in it: an icon, a short title, one
 * line on what to do next, and optionally the button that does it.
 * `compact` is for a list inside a card; the default stands on the page.
 */
export default function EmptyState({ icon = "inbox", title, description, action, compact = false }) {
    return (
        <div className={`empty-state${compact ? " compact" : ""}`}>
            {icon && (
                <span className="empty-icon">
                    <Icon name={icon} size={compact ? 18 : 20} />
                </span>
            )}
            {title && <p className="empty-title">{title}</p>}
            {description && <p className="empty-desc">{description}</p>}
            {action && <div style={{ marginTop: 14 }}>{action}</div>}
        </div>
    );
}
