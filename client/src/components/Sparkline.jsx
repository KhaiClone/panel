// ─────────────────────────────────────────────────────────────────────────────
//  Sparkline — a plain inline SVG, deliberately NOT uPlot.
//
//  The systems list draws one of these per row. A uPlot instance per row would
//  mean a canvas, a ResizeObserver and a cursor handler each; at ~60 points and
//  ~120px wide none of that buys anything a path element cannot do. uPlot is
//  reserved for the detail charts, where the crosshair and axes earn their keep.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {(number|null)[]} values  nulls are treated as gaps, not zeros
 * @param {string} color
 * @param {[number,number]|null} range  fixed y bounds; null auto-scales
 */
export default function Sparkline({
    values,
    color = "var(--accent)",
    width = 120,
    height = 28,
    range = [0, 100],
}) {
    const pts = Array.isArray(values) ? values : [];
    const usable = pts.filter((v) => v !== null && v !== undefined && Number.isFinite(v));

    if (usable.length < 2) {
        return (
            <svg width={width} height={height} aria-hidden="true">
                <line
                    x1="0" y1={height / 2} x2={width} y2={height / 2}
                    stroke="var(--border)" strokeWidth="1" strokeDasharray="3 3"
                />
            </svg>
        );
    }

    const [lo, hi] = range ?? [Math.min(...usable), Math.max(...usable)];
    const span = hi - lo || 1;
    const pad = 2;
    const plotH = height - pad * 2;

    const x = (i) => (i / (pts.length - 1)) * width;
    const y = (v) => pad + (1 - Math.max(0, Math.min(1, (v - lo) / span))) * plotH;

    // Break the path at nulls so a gap stays a gap.
    const segments = [];
    let current = [];
    pts.forEach((v, i) => {
        if (v === null || v === undefined || !Number.isFinite(v)) {
            if (current.length > 1) segments.push(current);
            current = [];
            return;
        }
        current.push([x(i), y(v)]);
    });
    if (current.length > 1) segments.push(current);

    const last = usable[usable.length - 1];
    const lastIdx = pts.length - 1;

    return (
        <svg width={width} height={height} aria-hidden="true" style={{ display: "block", overflow: "visible" }}>
            {segments.map((seg, i) => (
                <polyline
                    key={i}
                    points={seg.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ")}
                    fill="none"
                    stroke={color}
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                />
            ))}
            {Number.isFinite(last) && (
                <circle cx={x(lastIdx)} cy={y(last)} r="2" fill={color} />
            )}
        </svg>
    );
}
