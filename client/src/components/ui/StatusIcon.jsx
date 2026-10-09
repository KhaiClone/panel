import Icon from "./Icon";
import { TONE_COLOR } from "./StatusBadge";

const TONE_ICON = {
    success: "checkCircle",
    warning: "alert",
    danger: "xCircle",
    info: "info",
    accent: "clock",
    neutral: "minus",
};

/**
 * The mark in front of a line in a check list: an icon in the tone's colour.
 * `icon` overrides the tone's own (say "pause" for something switched off).
 *
 *   <StatusIcon tone="warning" />  Disk 81% used
 */
export default function StatusIcon({ tone = "neutral", icon, size = 14, title, style }) {
    return (
        <span title={title} style={{ display: "inline-flex", alignSelf: "center", verticalAlign: "-2px", color: TONE_COLOR[tone] || TONE_COLOR.neutral, ...style }}>
            <Icon name={icon || TONE_ICON[tone] || TONE_ICON.neutral} size={size} />
        </span>
    );
}
