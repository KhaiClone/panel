// Shared time-range selector. The keys match historyService.RANGE_MS on the
// server, so anything listed here is a range the API actually supports.
export const RANGES = [
    { key: "1h", label: "1H" },
    { key: "6h", label: "6H" },
    { key: "24h", label: "24H" },
    { key: "7d", label: "7D" },
    { key: "30d", label: "30D" },
];

export default function RangeTabs({ value, onChange }) {
    return (
        <div className="tab-bar" style={{ display: "flex", gap: 4 }}>
            {RANGES.map((r) => (
                <button
                    key={r.key}
                    className={`tab-item${value === r.key ? " active" : ""}`}
                    style={{ fontSize: 12, padding: "5px 12px" }}
                    onClick={() => onChange(r.key)}
                >
                    {r.label}
                </button>
            ))}
        </div>
    );
}
