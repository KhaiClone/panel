import { useEffect, useState, useCallback, useMemo } from "react";
import api from "../api/client";
import MetricChart, { fmtBytes, fmtPercent } from "./MetricChart";
import RangeTabs from "./RangeTabs";

// ─────────────────────────────────────────────────────────────────────────────
//  BotMetrics — the per-project half of the monitoring split.
//
//  The numbers come from PM2 on the project's node, recorded every 15s. This is
//  what answers questions the machine-level charts cannot: did this bot leak
//  memory overnight, is it worth the RAM the buyer pays for, did it restart.
//
//  Samples taken while the process was down are stored as 0 with up = 0. They
//  are converted to null here so a stopped stretch draws as a gap rather than
//  as a genuine 0%, and the downtime is shaded behind the line instead.
// ─────────────────────────────────────────────────────────────────────────────

const CHART_H = 190;

const stats = (arr) => {
    const v = (arr || []).filter((x) => x !== null && x !== undefined && Number.isFinite(x));
    if (!v.length) return null;
    return {
        min: Math.min(...v),
        max: Math.max(...v),
        avg: v.reduce((a, b) => a + b, 0) / v.length,
        last: v[v.length - 1],
    };
};

function Figure({ label, value, color = "var(--text)" }) {
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--text-muted)", fontWeight: 600 }}>{label}</span>
            <span className="mono" style={{ fontSize: 13, fontWeight: 600, color }}>{value}</span>
        </div>
    );
}

function ChartCard({ title, figures, children }) {
    return (
        <div className="card" style={{ padding: "14px 16px 6px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 8 }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>{title}</h3>
                <div style={{ display: "flex", gap: 18 }}>{figures}</div>
            </div>
            {children}
        </div>
    );
}

export default function BotMetrics({ botId, maxMemory = null }) {
    const [range, setRange] = useState("6h");
    const [raw, setRaw] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    const load = useCallback(async (r) => {
        try {
            const { data } = await api.get(`/bots/${botId}/history`, { params: { range: r } });
            setRaw(data);
            setError("");
        } catch (err) {
            setError(err.response?.data?.error || "Could not load history");
        } finally {
            setLoading(false);
        }
    }, [botId]);

    useEffect(() => {
        setLoading(true);
        load(range);
        const t = setInterval(() => load(range), 30_000);
        return () => clearInterval(t);
    }, [range, load]);

    // Blank out samples taken while the process was down.
    const data = useMemo(() => {
        if (!raw?.ts?.length) return raw;
        const online = (i) => raw.up?.[i] === null || raw.up?.[i] === undefined || raw.up[i] > 0.5;
        return {
            ...raw,
            cpu: raw.cpu.map((v, i) => (online(i) ? v : null)),
            mem: raw.mem.map((v, i) => (online(i) ? v : null)),
        };
    }, [raw]);

    const cpu = stats(data?.cpu);
    const mem = stats(data?.mem);

    // Share of the samples in view where the process was actually running.
    const uptimePct = useMemo(() => {
        const u = raw?.up;
        if (!u?.length) return null;
        return (u.reduce((a, b) => a + (b ?? 0), 0) / u.length) * 100;
    }, [raw]);

    const limitBytes = useMemo(() => {
        if (!maxMemory) return null;
        const m = String(maxMemory).match(/^(\d+)\s*(K|M|G)?$/i);
        if (!m) return null;
        const n = parseInt(m[1], 10);
        const unit = (m[2] || "M").toUpperCase();
        return unit === "K" ? n * 1024 : unit === "G" ? n * 1024 ** 3 : n * 1024 ** 2;
    }, [maxMemory]);

    // Give the memory chart a ceiling of the PM2 limit when there is one, so the
    // line's height means "how close to being restarted" rather than just a shape.
    const memRange = limitBytes ? [0, Math.max(limitBytes, mem?.max ?? 0) * 1.05] : null;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="mobile-wrap" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                    <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Resource history</h2>
                    <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "4px 0 0" }}>
                        Recorded every 15s from PM2 on this project's node.
                        {uptimePct !== null && (
                            <> Running {uptimePct.toFixed(uptimePct > 99 || uptimePct < 1 ? 1 : 0)}% of this window.</>
                        )}
                    </p>
                </div>
                <RangeTabs value={range} onChange={setRange} />
            </div>

            {error && (
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid var(--danger-border)", fontSize: 13 }}>
                    {error}
                </div>
            )}

            {loading && !raw ? (
                <div className="card" style={{ padding: 28, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>Loading history…</div>
            ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 14 }}>
                    <ChartCard
                        title="Memory"
                        figures={
                            <>
                                <Figure label="now" value={mem ? fmtBytes(mem.last) : "—"} color="#10b981" />
                                <Figure label="peak" value={mem ? fmtBytes(mem.max) : "—"} />
                                <Figure label="avg" value={mem ? fmtBytes(mem.avg) : "—"} />
                                {limitBytes && <Figure label="limit" value={fmtBytes(limitBytes)} color="var(--warning)" />}
                            </>
                        }
                    >
                        <MetricChart
                            data={data}
                            series={[{ key: "mem", label: "Memory", color: "#10b981" }]}
                            height={CHART_H}
                            yRange={memRange}
                            format={fmtBytes}
                            empty="No samples yet — history starts once the sampler has run."
                        />
                    </ChartCard>

                    <ChartCard
                        title="CPU"
                        figures={
                            <>
                                <Figure label="now" value={cpu ? fmtPercent(cpu.last) : "—"} color="#6366f1" />
                                <Figure label="peak" value={cpu ? fmtPercent(cpu.max) : "—"} />
                                <Figure label="avg" value={cpu ? fmtPercent(cpu.avg) : "—"} />
                            </>
                        }
                    >
                        <MetricChart
                            data={data}
                            series={[{ key: "cpu", label: "CPU", color: "#6366f1" }]}
                            height={CHART_H}
                            yRange={null}
                            format={fmtPercent}
                            empty="No samples yet — history starts once the sampler has run."
                        />
                    </ChartCard>
                </div>
            )}
        </div>
    );
}
