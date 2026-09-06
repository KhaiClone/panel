import { useEffect, useRef, useMemo } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

// ─────────────────────────────────────────────────────────────────────────────
//  MetricChart — uPlot wrapper for the panel's time-series data.
//
//  Feed it the columnar payload the history endpoints return ({ ts, cpu, … })
//  and a series spec; it handles sizing, the crosshair tooltip and axis
//  formatting. uPlot draws to canvas, so colors have to be real values rather
//  than CSS variables — they are resolved once from the stylesheet below.
//
//  A null in a series is drawn as a gap, not as zero. That distinction matters
//  here: a bot that was stopped, or a node that was unreachable, must not read
//  as "0% CPU".
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve a CSS custom property to the literal color uPlot needs. */
const cssVar = (name, fallback) => {
    if (typeof window === "undefined") return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
};

const theme = () => ({
    grid: "rgba(255,255,255,0.05)",
    axis: cssVar("--text-muted", "#94a3b8"),
    font: '11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
});

export const fmtBytes = (b) => {
    if (b === null || b === undefined || !Number.isFinite(b)) return "—";
    if (b < 1024) return `${Math.round(b)} B`;
    const u = ["KB", "MB", "GB", "TB"];
    let v = b / 1024;
    let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};

export const fmtPercent = (v) =>
    v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(v < 10 ? 1 : 0)}%`;

export const fmtRate = (v) =>
    v === null || v === undefined || !Number.isFinite(v) ? "—" : `${fmtBytes(v)}/s`;

const fmtClock = (ts, spanMs) => {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    // Past a couple of days the hour matters less than the date.
    if (spanMs > 2 * 24 * 3600 * 1000) return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:00`;
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * Crosshair tooltip. Built as a plugin so it lives inside uPlot's own overlay
 * and follows the cursor without React re-rendering on every mouse move.
 */
const tooltipPlugin = (spec, format) => {
    let tip;
    return {
        hooks: {
            init: (u) => {
                tip = document.createElement("div");
                tip.className = "uplot-tip";
                tip.style.display = "none";
                u.over.appendChild(tip);
            },
            setCursor: (u) => {
                const { idx, left, top } = u.cursor;
                if (idx === null || idx === undefined || left < 0) {
                    tip.style.display = "none";
                    return;
                }
                const ts = u.data[0][idx] * 1000;
                const d = new Date(ts);
                const p = (n) => String(n).padStart(2, "0");
                const head = `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;

                const rows = spec
                    .map((s, i) => {
                        const v = u.data[i + 1][idx];
                        const txt = v === null || v === undefined ? "—" : format(v, s);
                        return `<div class="uplot-tip-row"><span class="uplot-tip-dot" style="background:${s.color}"></span><span class="uplot-tip-label">${s.label}</span><span class="uplot-tip-val">${txt}</span></div>`;
                    })
                    .join("");

                tip.innerHTML = `<div class="uplot-tip-head">${head}</div>${rows}`;
                tip.style.display = "block";

                // Flip to the other side of the cursor near the right edge so the
                // tooltip never runs off the plot.
                const w = tip.offsetWidth;
                const flip = left + w + 18 > u.over.clientWidth;
                tip.style.left = `${flip ? left - w - 12 : left + 12}px`;
                tip.style.top = `${Math.max(4, Math.min(top - 8, u.over.clientHeight - tip.offsetHeight - 4))}px`;
            },
        },
    };
};

/**
 * @param {Object}   data     columnar payload: { ts: number[], [key]: (number|null)[] }
 * @param {Array}    series   [{ key, label, color, fill? }]
 * @param {number}   height   px
 * @param {[number,number]|null} yRange  fixed y scale, e.g. [0, 100] for percentages
 * @param {Function} format   (value, seriesSpec) => string, used by axis + tooltip
 */
export default function MetricChart({
    data,
    series,
    height = 180,
    yRange = null,
    format = fmtPercent,
    empty = "No data recorded yet",
}) {
    const wrapRef = useRef(null);
    const plotRef = useRef(null);

    // uPlot wants seconds, and one array per series in spec order.
    const chartData = useMemo(() => {
        if (!data?.ts?.length) return null;
        return [data.ts.map((t) => t / 1000), ...series.map((s) => data[s.key] ?? [])];
    }, [data, series]);

    // Rebuild only when the shape changes — new points alone go through setData.
    const specKey = useMemo(
        () => series.map((s) => `${s.key}:${s.color}`).join("|") + `|${height}|${yRange}`,
        [series, height, yRange],
    );

    useEffect(() => {
        if (!wrapRef.current || !chartData) return;
        const el = wrapRef.current;
        const t = theme();
        const spanMs = data.ts.length ? data.ts[data.ts.length - 1] - data.ts[0] : 0;

        const opts = {
            width: el.clientWidth || 600,
            height,
            padding: [10, 8, 0, 0],
            legend: { show: false },
            cursor: {
                y: false,
                points: { size: 7, width: 2 },
                drag: { x: false, y: false },
            },
            scales: {
                x: { time: true },
                y: yRange ? { range: yRange } : { range: (u, min, max) => [0, max === 0 ? 1 : max * 1.15] },
            },
            axes: [
                {
                    stroke: t.axis,
                    font: t.font,
                    grid: { stroke: t.grid, width: 1 },
                    ticks: { stroke: t.grid, width: 1, size: 4 },
                    values: (u, vals) => vals.map((v) => fmtClock(v * 1000, spanMs)),
                },
                {
                    stroke: t.axis,
                    font: t.font,
                    size: 52,
                    grid: { stroke: t.grid, width: 1 },
                    ticks: { show: false },
                    values: (u, vals) => vals.map((v) => format(v, series[0])),
                },
            ],
            series: [
                {},
                ...series.map((s) => ({
                    label: s.label,
                    stroke: s.color,
                    width: 2,
                    fill: s.fill ?? `${s.color}1f`,
                    points: { show: false },
                })),
            ],
            plugins: [tooltipPlugin(series, format)],
        };

        const u = new uPlot(opts, chartData, el);
        plotRef.current = u;

        const ro = new ResizeObserver(() => {
            u.setSize({ width: el.clientWidth || 600, height });
        });
        ro.observe(el);

        return () => {
            ro.disconnect();
            u.destroy();
            plotRef.current = null;
        };
        // chartData is intentionally excluded: a data-only change is pushed via
        // setData below instead of tearing the chart down and rebuilding it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [specKey, !!chartData]);

    useEffect(() => {
        if (plotRef.current && chartData) plotRef.current.setData(chartData);
    }, [chartData]);

    if (!chartData) {
        return (
            <div
                style={{
                    height,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--text-dim, var(--text-muted))",
                    fontSize: 13,
                }}
            >
                {empty}
            </div>
        );
    }

    return <div ref={wrapRef} style={{ width: "100%", height }} />;
}
