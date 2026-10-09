import Icon from "./Icon";

const ICON = { warning: "alert", danger: "alertCircle", success: "checkCircle" };

/** A line of feedback or warning: a tinted box, the icon in the tone's colour. */
export default function Notice({ tone = "warning", children }) {
    return (
        <div className={`notice notice-${tone}`}>
            <Icon name={ICON[tone] || "info"} className="notice-icon" />
            <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
        </div>
    );
}
