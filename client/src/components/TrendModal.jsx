// client/src/components/TrendModal.jsx
export default function TrendModal({ title, color, data, valueKey, onClose }) {
    // data = array of stat snapshots; valueKey = 'cpu' | 'mem'
    const values = data.map((s) =>
        valueKey === "cpu" ? s.cpu.usagePercent : s.memory.usedPercent,
    );
    const timestamps = data.map((s) => s._ts); // we'll add _ts below

    if (values.length < 2) {
        return (
            <Overlay onClose={onClose}>
                <p className="text-slate-400 text-center py-8">
                    Not enough data yet — wait a few samples.
                </p>
            </Overlay>
        );
    }

    const W = 560,
        H = 200,
        PAD = 36;
    const PAD_BOTTOM = 52; // extra room for time labels
    const max = Math.max(...values, 10);
    const pts = values.map((v, i) => {
        const x = PAD + (i / (values.length - 1)) * (W - PAD * 2);
        const y = PAD + (1 - v / max) * (H - PAD * 2);
        return { x, y, v };
    });
    const polyline = pts.map((p) => `${p.x},${p.y}`).join(" ");

    // Show label only for first, last, min, max points
    const minIdx = values.indexOf(Math.min(...values));
    const maxIdx = values.indexOf(Math.max(...values));
    const labelSet = new Set([0, values.length - 1, minIdx, maxIdx]);

    return (
        <Overlay onClose={onClose}>
            <h3 className="text-base font-bold text-slate-100 mb-4">
                {title} — Trend
            </h3>

            {/* Chart */}
            <svg
                viewBox={`0 0 ${W} ${H + 16}`}
                className="w-full rounded bg-slate-900/60 mb-4"
            >
                {/* Grid lines */}
                {[0, 25, 50, 75, 100].map((pct) => {
                    const y = PAD + (1 - pct / max) * (H - PAD * 2);
                    if (y < PAD || y > H - PAD) return null;
                    return (
                        <g key={pct}>
                            <line
                                x1={PAD}
                                y1={y}
                                x2={W - PAD}
                                y2={y}
                                stroke="#334155"
                                strokeWidth="1"
                            />
                            <text
                                x={PAD - 4}
                                y={y + 4}
                                textAnchor="end"
                                fontSize="9"
                                fill="#64748b"
                            >
                                {pct}%
                            </text>
                        </g>
                    );
                })}
                {/* Line */}
                <polyline
                    points={polyline}
                    fill="none"
                    stroke={color}
                    strokeWidth="2"
                    strokeLinejoin="round"
                />
                {/* X-axis time labels — show ~5 evenly spaced */}
                {(() => {
                    const count = Math.min(5, data.length);
                    const step =
                        Math.floor((data.length - 1) / (count - 1)) || 1;
                    const indices = Array.from({ length: count }, (_, i) =>
                        Math.min(i * step, data.length - 1),
                    );
                    return indices.map((idx) => {
                        const s = data[idx];
                        const x =
                            PAD + (idx / (data.length - 1)) * (W - PAD * 2);
                        const label = s._ts
                            ? new Date(s._ts).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                              })
                            : "";
                        return (
                            <g key={idx}>
                                {/* tick mark */}
                                <line
                                    x1={x}
                                    y1={H - PAD_BOTTOM + 4}
                                    x2={x}
                                    y2={H - PAD_BOTTOM + 10}
                                    stroke="#475569"
                                    strokeWidth="1"
                                />
                                {/* time label */}
                                <text
                                    x={x}
                                    y={H - PAD_BOTTOM + 22}
                                    textAnchor={
                                        idx === 0
                                            ? "start"
                                            : idx === data.length - 1
                                              ? "end"
                                              : "middle"
                                    }
                                    fontSize="9"
                                    fill="#64748b"
                                >
                                    {label}
                                </text>
                            </g>
                        );
                    });
                })()}
                {/* Dots + labels */}
                {pts.map((p, i) => (
                    <g key={i}>
                        <circle
                            cx={p.x}
                            cy={p.y}
                            r={labelSet.has(i) ? 4 : 2.5}
                            fill={labelSet.has(i) ? color : "#1e293b"}
                            stroke={color}
                            strokeWidth="1.5"
                        />
                        {labelSet.has(i) && (
                            <text
                                x={p.x}
                                y={p.y - 8}
                                textAnchor="middle"
                                fontSize="10"
                                fontWeight="bold"
                                fill={color}
                            >
                                {p.v}%
                            </text>
                        )}
                    </g>
                ))}
            </svg>

            {/* Table */}
            <div className="max-h-48 overflow-y-auto rounded border border-slate-700">
                <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-800">
                        <tr>
                            <th className="text-left px-3 py-2 text-slate-400 font-semibold">
                                #
                            </th>
                            <th className="text-left px-3 py-2 text-slate-400 font-semibold">
                                Time
                            </th>
                            <th className="text-right px-3 py-2 text-slate-400 font-semibold">
                                Usage %
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {[...data].reverse().map((s, i) => {
                            const val =
                                valueKey === "cpu"
                                    ? s.cpu.usagePercent
                                    : s.memory.usedPercent;
                            return (
                                <tr
                                    key={i}
                                    className="border-t border-slate-700/50 hover:bg-slate-700/30"
                                >
                                    <td className="px-3 py-1.5 text-slate-600">
                                        {data.length - i}
                                    </td>
                                    <td className="px-3 py-1.5 text-slate-400 font-mono">
                                        {s._ts
                                            ? new Date(
                                                  s._ts,
                                              ).toLocaleTimeString()
                                            : "—"}
                                    </td>
                                    <td
                                        className="px-3 py-1.5 text-right font-semibold"
                                        style={{
                                            color:
                                                val > 80
                                                    ? "#f87171"
                                                    : val > 50
                                                      ? "#fb923c"
                                                      : color,
                                        }}
                                    >
                                        {val}%
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <button className="btn-ghost w-full mt-3 text-sm" onClick={onClose}>
                Close
            </button>
        </Overlay>
    );
}

function Overlay({ children, onClose }) {
    return (
        <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4"
            onClick={(e) => {
                e.stopPropagation();
                onClose();
            }}
        >
            <div
                className="card w-full max-w-xl space-y-2"
                onClick={(e) => e.stopPropagation()}
            >
                {children}
            </div>
        </div>
    );
}
