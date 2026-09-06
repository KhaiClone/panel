import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import api from "../api/client";
import MetricChart, { fmtBytes, fmtPercent, fmtRate } from "./MetricChart";
import Sparkline from "./Sparkline";
import RangeTabs from "./RangeTabs";

// ─────────────────────────────────────────────────────────────────────────────
//  NodeMetrics — the VPS half of the monitoring split.
//
//  Four charts about the machine itself, then a breakdown of which projects on
//  it are consuming what. The per-project detail lives on each bot's own page;
//  here it is only enough to see who the heavy tenant is.
// ─────────────────────────────────────────────────────────────────────────────

const CHART_H = 190;

function ChartCard({ title, right, children }) {
    return (
        <div className="card" style={{ padding: "14px 16px 6px" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, letterSpacing: ".01em" }}>{title}</h3>
                {right && <span className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>{right}</span>}
            </div>
            {children}
        </div>
    );
}

const last = (arr) => {
    if (!Array.isArray(arr)) return null;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] !== null && arr[i] !== undefined) return arr[i];
    }
    return null;
};

export default function NodeMetrics({ nodeId, bots = [] }) {
    const [range, setRange] = useState("6h");
    const [data, setData] = useState(null);
    const [botHist, setBotHist] = useState({});
    const [loading, setLoading] = useState(true);

    const load = useCallback(async (r) => {
        try {
            const [nodeRes, botsRes] = await Promise.allSettled([
                api.get("/system/history", { params: { node: nodeId, range: r } }),
                api.get(`/nodes/${nodeId}/bots-history`, { params: { range: r } }),
            ]);
            if (nodeRes.status === "fulfilled") setData(nodeRes.value.data);
            if (botsRes.status === "fulfilled") setBotHist(botsRes.value.data.bots || {});
        } finally {
            setLoading(false);
        }
    }, [nodeId]);

    useEffect(() => {
        setLoading(true);
        load(range);
        const t = setInterval(() => load(range), 30_000);
        return () => clearInterval(t);
    }, [range, load]);

    const cpuSeries = [{ key: "cpu", label: "CPU", color: "#6366f1" }];
    const ramSeries = [{ key: "ram", label: "Memory", color: "#10b981" }];
    const diskSeries = [{ key: "disk", label: "Disk", color: "#f59e0b" }];
    const netSeries = [
        { key: "rx", label: "Download", color: "#10b981" },
        { key: "tx", label: "Upload", color: "#6366f1" },
    ];

    // Rank the node's projects by their most recent memory reading — the number
    // that actually decides whether this VPS is running out of room.
    const ranked = bots
        .map((b) => {
            const h = botHist[b._id] || {};
            return { bot: b, hist: h, mem: last(h.mem), cpu: last(h.cpu) };
        })
        .sort((a, b) => (b.mem ?? -1) - (a.mem ?? -1));

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <RangeTabs value={range} onChange={setRange} />
            </div>

            {loading && !data ? (
                <div className="card" style={{ padding: 32, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                    Loading history…
                </div>
            ) : (
                <>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 14 }}>
                        <ChartCard title="CPU" right={fmtPercent(last(data?.cpu))}>
                            <MetricChart data={data} series={cpuSeries} height={CHART_H} yRange={[0, 100]} format={fmtPercent} />
                        </ChartCard>
                        <ChartCard title="Memory" right={fmtPercent(last(data?.ram))}>
                            <MetricChart data={data} series={ramSeries} height={CHART_H} yRange={[0, 100]} format={fmtPercent} />
                        </ChartCard>
                        <ChartCard title="Disk" right={fmtPercent(last(data?.disk))}>
                            <MetricChart data={data} series={diskSeries} height={CHART_H} yRange={[0, 100]} format={fmtPercent} />
                        </ChartCard>
                        <ChartCard
                            title="Network"
                            right={`↓ ${fmtBytes(last(data?.rx))}/s  ↑ ${fmtBytes(last(data?.tx))}/s`}
                        >
                            <MetricChart data={data} series={netSeries} height={CHART_H} yRange={null} format={fmtRate} />
                        </ChartCard>
                    </div>

                    <div className="card" style={{ padding: 0, overflowX: "auto" }}>
                        <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid var(--border)" }}>
                            <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>Projects on this node</h3>
                            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "4px 0 0" }}>
                                Sorted by current memory. Open a project for its full history.
                            </p>
                        </div>
                        <table style={{ width: "100%", minWidth: 620, borderCollapse: "collapse", fontSize: 13 }}>
                            <thead>
                                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                                    {["Project", "Memory", "CPU", "Trend"].map((h) => (
                                        <th key={h} style={{ textAlign: "left", padding: "10px 16px", fontSize: 11, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-muted)" }}>
                                            {h}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {ranked.length === 0 && (
                                    <tr><td colSpan={4} style={{ padding: 22, textAlign: "center", color: "var(--text-muted)" }}>No projects on this node.</td></tr>
                                )}
                                {ranked.map(({ bot, hist, mem, cpu }) => (
                                    <tr key={bot._id} style={{ borderBottom: "1px solid var(--border)" }}>
                                        <td style={{ padding: "10px 16px" }}>
                                            <Link to={`/bots/${bot._id}`} style={{ color: "var(--text)", textDecoration: "none", fontWeight: 500 }}>
                                                {bot.name}
                                            </Link>
                                            <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>{bot.pm2Name}</div>
                                        </td>
                                        <td className="mono" style={{ padding: "10px 16px", fontWeight: 600 }}>{mem === null ? "—" : fmtBytes(mem)}</td>
                                        <td className="mono" style={{ padding: "10px 16px", color: "var(--text-muted)" }}>{cpu === null ? "—" : fmtPercent(cpu)}</td>
                                        <td style={{ padding: "10px 16px" }}>
                                            <Sparkline values={hist.mem} color="#10b981" width={130} height={26} range={null} />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </div>
    );
}
