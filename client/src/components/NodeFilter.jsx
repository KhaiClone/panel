// Node filter pills — options are derived from the bots themselves (nodeId +
// nodeName come back on every bot), so regular users get the filter too
// without needing access to the admin-only /api/nodes endpoint.

export const nodeKey = (bot) =>
    bot.nodeId && bot.nodeId !== "local" ? bot.nodeId : "local";

export const matchNode = (bot, value) =>
    value === "all" || nodeKey(bot) === value;

export function getNodeOptions(bots) {
    const map = new Map();
    for (const b of bots) {
        const key = nodeKey(b);
        if (!map.has(key)) {
            map.set(key, key === "local" ? "Local" : (b.nodeName || "Node"));
        }
    }
    // Local first, then remote nodes alphabetically
    return [...map.entries()]
        .map(([id, label]) => ({ id, label }))
        .sort((a, b) => (a.id === "local" ? -1 : b.id === "local" ? 1 : a.label.localeCompare(b.label)));
}

/**
 * Renders nothing while every bot lives on the same node — the filter only
 * appears once a second node actually holds something.
 */
export default function NodeFilter({ bots, value, onChange }) {
    const options = getNodeOptions(bots);
    if (options.length < 2 && value === "all") return null;

    return (
        <div className="tab-bar">
            <button
                className={`tab-item ${value === "all" ? "active" : ""}`}
                onClick={() => onChange("all")}
            >
                All Nodes
            </button>
            {options.map((o) => (
                <button
                    key={o.id}
                    className={`tab-item ${value === o.id ? "active" : ""}`}
                    onClick={() => onChange(o.id)}
                    title={o.id === "local" ? "Panel VPS" : `Node "${o.label}"`}
                >
                    ⬡ {o.label}
                </button>
            ))}
        </div>
    );
}
