// ─────────────────────────────────────────────────────────────────────────────
//  Panel Settings — the panel's own process, config and plumbing, in four tabs
//  (one URL each: /panel-manage/<tab>). The header — status, Restart, Rebuild —
//  stays on every tab, so a change anywhere can be applied right there.
//  Each tab lives in pages/panel/.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { NavLink, Navigate, useParams } from "react-router-dom";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";
import { Icon, PageHeader, StatusBadge, StatusIcon } from "../components/ui";
import OverviewTab from "./panel/OverviewTab";
import ConfigTab from "./panel/ConfigTab";
import IntegrationsTab from "./panel/IntegrationsTab";
import RecoveryTab from "./panel/RecoveryTab";
import { fmtUptime } from "./panel/format";

const TABS = [
    { id: "overview", label: "Overview" },
    { id: "config", label: "Config" },
    { id: "integrations", label: "Integrations" },
    { id: "recovery", label: "Recovery" },
];

function ReconnectOverlay({ onReconnected }) {
    const [dots, setDots] = useState("");
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        const dotTimer = setInterval(() => setDots(d => (d.length >= 3 ? "" : d + ".")), 500);
        return () => clearInterval(dotTimer);
    }, []);

    useEffect(() => {
        const timer = setInterval(async () => {
            setAttempt(a => a + 1);
            try { await api.get("/panel/status"); onReconnected(); } catch { /* ignore */ }
        }, 2000);
        return () => clearInterval(timer);
    }, [onReconnected]);

    return createPortal(
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "var(--overlay)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
            <div style={{ width: 60, height: 60, borderRadius: "50%", border: "4px solid var(--accent-border)", borderTopColor: "var(--accent)", animation: "spin 1s linear infinite" }}/>
            <div style={{ textAlign: "center" }}>
                <h2 style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", margin: "0 0 8px 0" }}>Panel restarting{dots}</h2>
                <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "0 0 4px 0" }}>Waiting for the panel to come back online</p>
                <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>Attempt #{attempt}</p>
            </div>
        </div>,
        document.body
    );
}

function BuildResult({ buildOutput, onDismiss }) {
    return (
        <div className="card" style={{ padding: 16, border: `1px solid ${buildOutput.success ? 'var(--success-border)' : 'var(--danger-border)'}`, background: buildOutput.success ? 'var(--success-bg)' : 'var(--danger-bg)' }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: buildOutput.output || buildOutput.agents?.length ? 12 : 0 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: buildOutput.success ? "var(--success)" : "var(--danger)", margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
                    <Icon name={buildOutput.success ? "checkCircle" : "xCircle"} />
                    {buildOutput.success ? "Build successful" : "Build failed"}
                </h3>
                <button onClick={onDismiss} className="btn-ghost btn-sm">Dismiss</button>
            </div>
            {buildOutput.message && <p style={{ fontSize: 13, margin: "0 0 8px 0" }}>{buildOutput.message}</p>}
            {buildOutput.agents?.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, margin: "0 0 10px 0" }}>
                    {buildOutput.agents.map((a) => (
                        <div key={a.nodeId} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12 }}>
                            <StatusIcon tone={a.ok ? "success" : "danger"} />
                            <strong style={{ color: "var(--text)", whiteSpace: "nowrap" }}>Agent · {a.name}{a.isPanelNode ? " (panel)" : ""}</strong>
                            <span style={{ color: a.ok ? "var(--text-muted)" : "var(--danger)", minWidth: 0, overflowWrap: "anywhere" }}>{a.message}</span>
                        </div>
                    ))}
                </div>
            )}
            {buildOutput.output && <pre className="mono" style={{ fontSize: 11, color: "var(--text-dim)", background: "var(--bg-base)", padding: 12, borderRadius: 8, margin: 0, maxHeight: 300, overflowY: "auto", whiteSpace: "pre-wrap" }}>{buildOutput.output}</pre>}
        </div>
    );
}

export default function PanelManage() {
    const { tab } = useParams();
    const [status, setStatus] = useState(null);
    const [reconnecting, setReconnecting] = useState(false);
    const [confirm, setConfirm] = useState(null);
    const [building, setBuilding] = useState(null); // null | "agents" | "panel"
    const [buildOutput, setBuildOutput] = useState(() => {
        const saved = sessionStorage.getItem("panel_build_output");
        if (saved) { sessionStorage.removeItem("panel_build_output"); try { return JSON.parse(saved); } catch { return null; } }
        return null;
    });

    const fetchStatus = useCallback(() => { api.get("/panel/status").then(r => setStatus(r.data)).catch(() => {}); }, []);
    useEffect(() => { fetchStatus(); const int = setInterval(fetchStatus, 5000); return () => clearInterval(int); }, [fetchStatus]);

    const handleRestart = () => {
        setConfirm({
            title: "Restart panel",
            message: "The panel will restart. You'll lose connection for a few seconds while it comes back up. Continue?",
            onConfirm: async () => {
                setConfirm(null);
                try { await api.post("/panel/restart"); setTimeout(() => setReconnecting(true), 1000); }
                catch (err) { alert("Failed to restart: " + (err.response?.data?.message || err.message)); }
            },
        });
    };

    // Two requests, agents first: a newer panel may call endpoints an older
    // agent does not have. Kept separate so neither runs into the reverse
    // proxy's read timeout on its own.
    const handleRebuild = () => {
        setConfirm({
            title: "Update agents, rebuild & restart panel",
            message: "First updates the agent on every node (git pull, install, restart — bots keep running), then rebuilds the client UI and restarts the panel. The panel stays online during the build. Continue?",
            onConfirm: async () => {
                setConfirm(null); setBuildOutput(null);
                let agents = [];
                try {
                    setBuilding("agents");
                    try {
                        const r = await api.post("/panel/update-agents", {}, { timeout: 600_000 });
                        agents = r.data.agents || [];
                    } catch (err) {
                        setBuildOutput({ success: false, output: "", message: `Agent update failed — the panel was NOT rebuilt: ${err.response?.data?.error || err.message}` });
                        return;
                    }
                    // The rebuild itself runs on the panel node's agent — without it there is nothing to rebuild with.
                    const panelAgent = agents.find((a) => a.isPanelNode);
                    if (panelAgent && !panelAgent.ok) {
                        setBuildOutput({ success: false, output: "", agents, message: "The agent on the panel's own node did not update — the panel was NOT rebuilt." });
                        return;
                    }

                    setBuilding("panel");
                    try {
                        const r = await api.post("/panel/rebuild", {}, { timeout: 300_000 });
                        const outputData = { success: true, output: r.data.buildOutput, message: r.data.message, agents };
                        setBuildOutput(outputData); sessionStorage.setItem("panel_build_output", JSON.stringify(outputData));
                        setTimeout(() => setReconnecting(true), 1000);
                    } catch (err) {
                        setBuildOutput({ success: false, output: err.response?.data?.buildOutput || err.message, message: err.response?.data?.message || "Build failed", agents });
                    }
                } finally { setBuilding(null); }
            },
        });
    };

    const handleReconnected = useCallback(() => { setReconnecting(false); fetchStatus(); window.location.reload(); }, [fetchStatus]);
    const onRestarting = useCallback(() => setTimeout(() => setReconnecting(true), 1000), []);

    if (!TABS.some((t) => t.id === tab)) return <Navigate to="/panel-manage/overview" replace />;

    if (!status) {
        return <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 14 }}>Loading panel info…</div>;
    }

    const { env, git, pm2 } = status;
    const isOnline = pm2?.status === "online";

    return (
        <div className="page-compact fade-in" style={{ maxWidth: 960, display: "flex", flexDirection: "column", gap: 20 }}>
            {reconnecting && <ReconnectOverlay onReconnected={handleReconnected} />}
            {confirm && <ConfirmModal title={confirm.title} message={confirm.message} onConfirm={confirm.onConfirm} onCancel={() => setConfirm(null)} />}

            {/* Status + the two actions every tab may need */}
            <PageHeader
                title="Panel Settings"
                description={
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <StatusBadge tone={isOnline ? "success" : "danger"}>{pm2?.status ? pm2.status[0].toUpperCase() + pm2.status.slice(1) : "Unknown"}</StatusBadge>
                        {env?.isDev && <StatusBadge tone="warning">Dev mode</StatusBadge>}
                        <span>
                            v{env?.version || "?"}
                            {git?.commitHash && <span className="mono" style={{ color: "var(--text-dim)" }}> · {git.commitHash.substring(0, 7)}</span>}
                            {pm2?.pm_uptime && <> · up {fmtUptime(pm2.pm_uptime)}</>}
                        </span>
                    </span>
                }
                actions={
                    <>
                        <button onClick={handleRestart} disabled={!!building} className="btn-ghost" title="Restarts the PM2 process">
                            <Icon name="restart" /> Restart
                        </button>
                        <button onClick={handleRebuild} disabled={!!building} className="btn-primary" style={{ cursor: building ? "wait" : "pointer" }} title="Updates every node's agent, then rebuilds and restarts the panel">
                            <Icon name={building ? "hourglass" : "wrench"} />
                            {building === "agents" ? "Updating agents…" : building ? "Rebuilding…" : "Rebuild & restart"}
                        </button>
                    </>
                }
            />

            {buildOutput && <BuildResult buildOutput={buildOutput} onDismiss={() => setBuildOutput(null)} />}

            <div className="scroll-x" style={{ maxWidth: "100%" }}>
                <div className="tab-bar" style={{ display: "inline-flex" }}>
                    {TABS.map((t) => (
                        <NavLink key={t.id} to={`/panel-manage/${t.id}`} className={({ isActive }) => `tab-item${isActive ? " active" : ""}`} style={{ textDecoration: "none" }}>
                            {t.label}
                        </NavLink>
                    ))}
                </div>
            </div>

            {tab === "overview" && <OverviewTab status={status} />}
            {tab === "config" && <ConfigTab onRestart={handleRestart} />}
            {tab === "integrations" && <IntegrationsTab />}
            {tab === "recovery" && <RecoveryTab onRestart={handleRestart} onRestarting={onRestarting} />}
        </div>
    );
}
