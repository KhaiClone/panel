import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import api from "../api/client";
import MetricChart, { cssVar, fmtBytes, fmtPercent, fmtRate } from "./MetricChart";
import Sparkline from "./Sparkline";
import RangeTabs from "./RangeTabs";
import { DataTable, Icon } from "./ui";

// ─────────────────────────────────────────────────────────────────────────────
//  NodeMetrics — the VPS half of the monitoring split.
//
//  Four charts about the machine itself, then a breakdown of which projects on
//  it are consuming what. The per-project detail lives on each bot's own page;
//  here it is only enough to see who the heavy tenant is.
// ─────────────────────────────────────────────────────────────────────────────

const CHART_H = 190;

function ChartCard({ icon, title, right, children }) {
    return (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {icon && <Icon name={icon} style={{ color: "var(--text-dim)" }} />}
                <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{title}</h2>
                {right && <span className="mono" style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: "auto" }}>{right}</span>}
            </div>
            <div style={{ padding: "6px 16px 6px" }}>
                {children}
            </div>
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

    const cpuSeries = [{ key: "cpu", label: "CPU", color: cssVar("--accent", "#6366f1") }];
    const ramSeries = [{ key: "ram", label: "Memory", color: cssVar("--success", "#10b981") }];
    const diskSeries = [{ key: "disk", label: "Disk", color: cssVar("--warning", "#f59e0b") }];
    const netSeries = [
        { key: "rx", label: "Download", color: cssVar("--success", "#10b981") },
        { key: "tx", label: "Upload", color: cssVar("--accent", "#6366f1") },
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
                        <ChartCard icon="cpu" title="CPU" right={fmtPercent(last(data?.cpu))}>
                            <MetricChart data={data} series={cpuSeries} height={CHART_H} yRange={[0, 100]} format={fmtPercent} />
                        </ChartCard>
                        <ChartCard icon="memory" title="Memory" right={fmtPercent(last(data?.ram))}>
                            <MetricChart data={data} series={ramSeries} height={CHART_H} yRange={[0, 100]} format={fmtPercent} />
                        </ChartCard>
                        <ChartCard icon="database" title="Disk" right={fmtPercent(last(data?.disk))}>
                            <MetricChart data={data} series={diskSeries} height={CHART_H} yRange={[0, 100]} format={fmtPercent} />
                        </ChartCard>
                        <ChartCard
                            icon="activity"
                            title="Network"
                            right={`↓ ${fmtBytes(last(data?.rx))}/s  ↑ ${fmtBytes(last(data?.tx))}/s`}
                        >
                            <MetricChart data={data} series={netSeries} height={CHART_H} yRange={null} format={fmtRate} />
                        </ChartCard>
                    </div>

                    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <Icon name="folder" style={{ color: "var(--text-dim)" }} />
                            <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Projects on this node</h2>
                            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Sorted by current memory. Open a project for its full history.</span>
                        </div>
                        <DataTable flush minWidth={620} columns={["Project", { label: "Memory", align: "right" }, { label: "CPU", align: "right" }, "Trend"]}>
                            {ranked.length === 0 && (
                                <tr><td colSpan={4} style={{ padding: 22, textAlign: "center", color: "var(--text-muted)" }}>No projects on this node.</td></tr>
                            )}
                            {ranked.map(({ bot, hist, mem, cpu }) => (
                                <tr key={bot._id}>
                                    <td>
                                        <Link to={`/bots/${bot._id}`} style={{ color: "var(--text)", textDecoration: "none", fontWeight: 500 }}>
                                            {bot.name}
                                        </Link>
                                        <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>{bot.pm2Name}</div>
                                    </td>
                                    <td className="mono num" style={{ fontWeight: 600 }}>{mem === null ? "—" : fmtBytes(mem)}</td>
                                    <td className="mono num" style={{ color: "var(--text-muted)" }}>{cpu === null ? "—" : fmtPercent(cpu)}</td>
                                    <td>
                                        <Sparkline values={hist.mem} color="var(--success)" width={130} height={26} range={null} />
                                    </td>
                                </tr>
                            ))}
                        </DataTable>
                    </div>
                </>
            )}
        </div>
    );
}
