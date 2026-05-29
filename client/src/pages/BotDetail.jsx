import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../api/client';
import LogViewer from '../components/LogViewer';
import EnvEditor from '../components/EnvEditor';
import ConfirmModal from '../components/ConfirmModal';
import FileEditor from '../components/FileEditor';
import { useData } from '../context/DataContext';

// ── Helpers ────────────────────────────────────────────────────────────────
const STATUS_STYLES = {
    online:    { color: "#22c55e", bg: "rgba(34,197,94,0.1)",   border: "rgba(34,197,94,0.3)",   label: "Online"   },
    stopped:   { color: "#ef4444", bg: "rgba(239,68,68,0.1)",   border: "rgba(239,68,68,0.3)",   label: "Stopped"  },
    errored:   { color: "#f97316", bg: "rgba(249,115,22,0.1)",  border: "rgba(249,115,22,0.3)",  label: "Errored"  },
    launching: { color: "#f59e0b", bg: "rgba(245,158,11,0.1)",  border: "rgba(245,158,11,0.3)",  label: "Starting" },
};
const getStyle = (s) => STATUS_STYLES[s] ?? { color: "#8892a4", bg: "rgba(136,146,164,0.08)", border: "rgba(136,146,164,0.2)", label: s ?? "Unknown" };

const fmt = (bytes) => {
    if (!bytes) return '—';
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
    return `${(bytes / 1_048_576).toFixed(0)} MB`;
};
const fmtDate = (ts) => ts ? new Date(ts).toLocaleString() : '—';
const toLocalDatetimeInputValue = (tsMs) => {
    const d = new Date(tsMs);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
};
const formatTimeLeft = (ms) => {
    if (ms <= 0) return 'Expired';
    const d = Math.floor(ms / 86_400_000);
    const h = Math.floor((ms % 86_400_000) / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
};
const formatUptime = (pmUptime) => {
    if (!pmUptime) return '—';
    const ms = Date.now() - pmUptime;
    if (ms <= 0) return '—';
    const d = Math.floor(ms / 86_400_000);
    const h = Math.floor((ms % 86_400_000) / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
};
const parseMemLimit = (s) => {
    if (!s) return null;
    const m = s.match(/^(\d+)([KMG]?)$/i);
    if (!m) return null;
    let v = parseInt(m[1], 10);
    const u = m[2].toUpperCase();
    if (u === 'K') v *= 1024;
    else if (u === 'M') v *= 1024 * 1024;
    else if (u === 'G') v *= 1024 * 1024 * 1024;
    return v > 0 ? v : null;
};

function ProgressBar({ percent, color }) {
    const pct = Math.min(Math.max(percent ?? 0, 0), 100);
    return (
        <div style={{ background: "var(--bg-input)", borderRadius: 4, height: 8, overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", borderRadius: 4, background: color, transition: "width 0.5s ease" }}/>
        </div>
    );
}

const TABS = ['Controls', 'Resources', 'Logs', 'Environment', 'Files', 'Settings'];

export default function BotDetail() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { groups, tags: allTags } = useData();

    const [bot, setBot]       = useState(null);
    const [loading, setLoading] = useState(true);
    const [tab, setTab]       = useState('Controls');
    const [busy, setBusy]     = useState(null);
    const [confirm, setConfirm] = useState(null);
    const [actionMsg, setActionMsg] = useState(null);

    const [editName,           setEditName]           = useState('');
    const [editExpiry,         setEditExpiry]         = useState('');
    const [editScript,         setEditScript]         = useState('');
    const [editInstallCommand, setEditInstallCommand] = useState('');
    const [editGroupId,        setEditGroupId]        = useState('');
    const [editMaxMemory,      setEditMaxMemory]      = useState('');
    const [editPrice,          setEditPrice]          = useState('');
    const [editTags,           setEditTags]           = useState([]);
    const [savingMeta,         setSavingMeta]         = useState(false);

    const fetchBot = async () => {
        try {
            const { data } = await api.get(`/bots/${id}`);
            setBot(data);
            setEditName(data.name);
            setEditScript(data.startScript || 'npm start');
            setEditInstallCommand(data.installCommand || '');
            setEditGroupId(data.groupId || '');
            setEditMaxMemory(data.maxMemory || '');
            setEditPrice(data.currentPrice || '');
            setEditTags(Array.isArray(data.tags) ? data.tags : []);
            setEditExpiry(data.expiresAt ? toLocalDatetimeInputValue(data.expiresAt) : '');
        } catch { navigate('/dashboard'); }
        finally { setLoading(false); }
    };

    useEffect(() => {
        fetchBot();
        const interval = setInterval(fetchBot, 8_000);
        return () => clearInterval(interval);
    }, [id]);

    const runAction = async (name, endpoint, method = 'post') => {
        setBusy(name); setActionMsg(null);
        try {
            const { data } = await api[method](`/bots/${id}/${endpoint}`);
            setActionMsg({ type: 'success', text: data.message || `${name} successful` });
            fetchBot();
        } catch (err) {
            setActionMsg({ type: 'error', text: err.response?.data?.error || `${name} failed` });
        } finally { setBusy(null); }
    };

    const handleDelete = async () => {
        setConfirm(null); setBusy('delete');
        try { await api.delete(`/bots/${id}`); navigate('/dashboard'); }
        catch (err) { setActionMsg({ type: 'error', text: err.response?.data?.error || 'Delete failed' }); setBusy(null); }
    };

    const saveMeta = async () => {
        setSavingMeta(true);
        try {
            await api.put(`/bots/${id}`, {
                name: editName, startScript: editScript,
                installCommand: editInstallCommand || null,
                groupId: editGroupId || null, maxMemory: editMaxMemory || null,
                currentPrice: editPrice ? Number(editPrice) : null,
                tags: editTags,
                expiresAt: editExpiry ? new Date(editExpiry).toISOString() : null,
            });
            setActionMsg({ type: 'success', text: 'Settings saved' });
            fetchBot();
        } catch (err) {
            setActionMsg({ type: 'error', text: err.response?.data?.error || 'Save failed' });
        } finally { setSavingMeta(false); }
    };

    if (loading || !bot) {
        return (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", paddingTop: 80, gap: 12 }}>
                <div style={{
                    width: 28, height: 28, borderRadius: "50%",
                    border: "3px solid var(--border)", borderTopColor: "var(--accent)",
                    animation: "spin 0.8s linear infinite",
                }}/>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading instance…</p>
            </div>
        );
    }

    const isOnline     = bot.live?.status === 'online';
    const isStopped    = !isOnline;
    const isLocal      = bot.source === 'local';
    const msLeft       = bot.expiresAt ? bot.expiresAt - Date.now() : null;
    const currentGroup = groups.find(g => g._id === bot.groupId);
    const botTags      = (bot.tags || []).map(tagId => allTags.find(t => t._id === tagId)).filter(Boolean);
    const cpuPct       = parseFloat((bot.live?.cpu ?? 0).toFixed(1));
    const memLimitBytes = parseMemLimit(bot.maxMemory);
    const memPercent   = (bot.live?.memory && memLimitBytes) ? parseFloat(((bot.live.memory / memLimitBytes) * 100).toFixed(1)) : null;
    const s            = getStyle(bot.live?.status);

    const toggleEditTag = (tagId) => {
        setEditTags(prev => prev.includes(tagId) ? prev.filter(t => t !== tagId) : [...prev, tagId]);
    };

    const pageStyle = { padding: "20px 24px", maxWidth: 960, margin: "0 auto" };
    const cardStyle = { marginBottom: 16 };

    return (
        <div style={pageStyle}>

            {/* Header */}
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 20 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <button
                        onClick={() => navigate('/dashboard')}
                        className="btn-ghost"
                        style={{ padding: "6px 10px", flexShrink: 0 }}
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14 }}>
                            <polyline points="15 18 9 12 15 6"/>
                        </svg>
                    </button>
                    <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--text)", margin: 0 }}>{bot.name}</h1>
                            {isLocal && (
                                <span style={{
                                    fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99,
                                    background: "rgba(91,115,232,0.12)", border: "1px solid rgba(91,115,232,0.3)", color: "var(--accent)"
                                }}>
                                    📂 Local
                                </span>
                            )}
                            {currentGroup && (
                                <span style={{
                                    fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99,
                                    background: `${currentGroup.color}18`, border: `1px solid ${currentGroup.color}40`, color: currentGroup.color
                                }}>
                                    {currentGroup.name}
                                </span>
                            )}
                            {botTags.map(tag => (
                                <span key={tag._id} style={{
                                    display: "inline-flex", alignItems: "center", gap: 4,
                                    fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99,
                                    background: `${tag.color}18`, border: `1px solid ${tag.color}40`, color: tag.color
                                }}>
                                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: tag.color }}/>
                                    {tag.name}
                                </span>
                            ))}
                        </div>
                        <p className="mono" style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
                            {bot.buyerID} / {bot.botID}
                        </p>
                    </div>
                </div>

                <span style={{
                    display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px",
                    borderRadius: 99, fontSize: 12, fontWeight: 600, flexShrink: 0,
                    background: s.bg, border: `1px solid ${s.border}`, color: s.color,
                }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: s.color }}/>
                    {s.label}
                </span>
            </div>

            {/* Summary stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 20 }}>
                {[
                    { label: "CPU",       value: `${bot.live?.cpu ?? 0}%`,                          color: "#818cf8" },
                    { label: "Memory",    value: fmt(bot.live?.memory),                              color: "#60a5fa" },
                    { label: "Uptime",    value: isOnline ? formatUptime(bot.live?.uptime) : "—",   color: "#34d399" },
                    { label: "Restarts",  value: bot.live?.restarts ?? 0,                            color: "#f97316" },
                    { label: "Remaining", value: msLeft !== null ? formatTimeLeft(msLeft) : "∞",    color: msLeft !== null && msLeft < 3 * 86_400_000 ? "#ef4444" : "#f59e0b" },
                ].map(({ label, value, color }) => (
                    <div key={label} className="card" style={{ padding: 14 }}>
                        <p style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{label}</p>
                        <p className="mono" style={{ fontSize: 16, fontWeight: 700, color }}>{value}</p>
                    </div>
                ))}
            </div>

            {/* Action message */}
            {actionMsg && (
                <div style={{
                    display: "flex", alignItems: "center", gap: 8, marginBottom: 16,
                    padding: "10px 14px", borderRadius: 8, fontSize: 13, fontWeight: 500,
                    background: actionMsg.type === 'success' ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                    border: `1px solid ${actionMsg.type === 'success' ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                    color: actionMsg.type === 'success' ? "#4ade80" : "#f87171",
                }}>
                    <span>{actionMsg.type === 'success' ? '✓' : '✕'}</span>
                    {actionMsg.text}
                    <button onClick={() => setActionMsg(null)} style={{ marginLeft: "auto", background: "none", border: "none", color: "inherit", cursor: "pointer", opacity: 0.6 }}>✕</button>
                </div>
            )}

            {/* Tabs */}
            <div className="tab-bar no-scrollbar" style={{ marginBottom: 16 }}>
                {TABS.map(t => (
                    <button key={t} className={`tab-item ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
                        {t}
                    </button>
                ))}
            </div>

            {/* Controls */}
            {tab === 'Controls' && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div className="card">
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
                            <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0 }}>Runtime Controls</h2>
                            <span className="mono" style={{ fontSize: 11, color: "var(--text-dim)", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 5, padding: "2px 8px" }}>
                                {bot.pm2Name}
                            </span>
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                            {isStopped && (
                                <button className="btn-success" style={{ flex: "1 1 120px" }} disabled={!!busy} onClick={() => runAction('start', 'start')}>
                                    {busy === 'start' ? '⏳ Processing…' : '▶ Start'}
                                </button>
                            )}
                            {isOnline && (
                                <button className="btn-danger" style={{ flex: "1 1 120px" }} disabled={!!busy} onClick={() => runAction('stop', 'stop')}>
                                    {busy === 'stop' ? '⏳ Processing…' : '⏹ Stop'}
                                </button>
                            )}
                            <button className="btn-warning" style={{ flex: "1 1 120px" }} disabled={!!busy} onClick={() => runAction('restart', 'restart')}>
                                {busy === 'restart' ? '⏳ Processing…' : '↺ Restart'}
                            </button>
                            <button className="btn-primary" style={{ flex: "1 1 120px" }} disabled={!!busy} onClick={() => setConfirm({ action: 'update' })}>
                                {busy === 'update' ? '⏳ Processing…' : isLocal ? '📦 Rebuild' : '⬆ Pull Update'}
                            </button>
                            <button className="btn-danger" disabled={!!busy} onClick={() => setConfirm({ action: 'delete' })}>
                                🗑️ Delete
                            </button>
                        </div>
                    </div>

                    {/* Metadata */}
                    <div className="card">
                        <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 14, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
                            Instance Metadata
                        </h3>
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            {[
                                { label: 'Source',          value: isLocal ? `Local: ${bot.localPath}` : bot.repoUrl },
                                { label: 'Branch',          value: bot.branch || 'main' },
                                { label: 'Start Command',   value: bot.startScript },
                                { label: 'Install Command', value: bot.installCommand || '—' },
                                { label: 'Memory Limit',    value: bot.maxMemory || 'Unrestricted' },
                                { label: 'Group',           value: currentGroup?.name || 'Ungrouped' },
                                { label: 'Created',         value: fmtDate(bot.createdAt) },
                                { label: 'Expires',         value: bot.expiresAt ? fmtDate(bot.expiresAt) : 'Permanent' },
                            ].map(({ label, value }) => (
                                <div key={label} style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
                                    <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", width: 130, flexShrink: 0 }}>{label}</span>
                                    <span className="mono" style={{ fontSize: 12, color: "var(--text)", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 5, padding: "2px 8px", wordBreak: "break-all" }}>{value}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Resources */}
            {tab === 'Resources' && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div className="card">
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, divideColor: "var(--border)" }}>
                            <div>
                                <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Status</p>
                                <span style={{
                                    display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px",
                                    borderRadius: 99, fontSize: 12, fontWeight: 600,
                                    background: s.bg, border: `1px solid ${s.border}`, color: s.color,
                                }}>
                                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: s.color }}/>
                                    {s.label}
                                </span>
                            </div>
                            <div style={{ borderLeft: "1px solid var(--border)", paddingLeft: 16 }}>
                                <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Uptime</p>
                                <p style={{ fontSize: 22, fontWeight: 700, color: "#818cf8" }}>{isOnline ? formatUptime(bot.live?.uptime) : '—'}</p>
                            </div>
                            <div style={{ borderLeft: "1px solid var(--border)", paddingLeft: 16 }}>
                                <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Restarts</p>
                                <p style={{ fontSize: 22, fontWeight: 700, color: "#f87171" }}>{bot.live?.restarts ?? 0}</p>
                            </div>
                        </div>
                    </div>

                    <div className="card">
                        <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
                            Live Resource Usage
                        </h2>
                        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                            {/* CPU */}
                            <div>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>CPU Usage</span>
                                    <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: cpuPct > 80 ? "#ef4444" : cpuPct > 50 ? "#f97316" : "#22c55e" }}>
                                        {cpuPct}%
                                    </span>
                                </div>
                                <ProgressBar percent={cpuPct} color={cpuPct > 80 ? "#ef4444" : cpuPct > 50 ? "#f97316" : "#22c55e"} />
                            </div>
                            {/* Memory */}
                            <div>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Memory Usage</span>
                                    <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: "#818cf8" }}>
                                        {fmt(bot.live?.memory)}{memLimitBytes ? ` / ${fmt(memLimitBytes)}` : ""}
                                    </span>
                                </div>
                                {memPercent !== null ? (
                                    <ProgressBar percent={memPercent} color={memPercent > 85 ? "#ef4444" : "#818cf8"} />
                                ) : (
                                    <div style={{ background: "var(--bg-input)", borderRadius: 4, height: 8 }}>
                                        <div style={{ height: "100%", borderRadius: 4, background: "#818cf8", width: "30%" }}/>
                                    </div>
                                )}
                                {memPercent !== null && memPercent >= 80 && (
                                    <p style={{ fontSize: 12, color: "#f87171", marginTop: 8 }}>
                                        ⚠️ Memory critical: {memPercent}%. PM2 will restart at 100%.
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Logs */}
            {tab === 'Logs' && (
                <div style={{ borderRadius: 10, overflow: "hidden", background: "#06090f", border: "1px solid var(--border)" }}>
                    <LogViewer botId={id} />
                </div>
            )}

            {/* Environment */}
            {tab === 'Environment' && (
                <div className="card">
                    <EnvEditor botId={id} />
                </div>
            )}

            {/* Files */}
            {tab === 'Files' && (
                <div className="card">
                    <FileEditor botId={id} />
                </div>
            )}

            {/* Settings */}
            {tab === 'Settings' && (
                <div className="card">
                    <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
                        Instance Configuration
                    </h2>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                            <div>
                                <label className="label">Instance Name</label>
                                <input className="input" value={editName} onChange={e => setEditName(e.target.value)} />
                            </div>
                            <div>
                                <label className="label">Start Command</label>
                                <input className="input mono" value={editScript} onChange={e => setEditScript(e.target.value)} />
                                <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>Supports sudo, e.g. "sudo java -jar app.jar"</p>
                            </div>
                            <div>
                                <label className="label">Install Command</label>
                                <input className="input mono" placeholder="Leave empty to skip" value={editInstallCommand} onChange={e => setEditInstallCommand(e.target.value)} />
                                <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>Used during rebuild/update.</p>
                            </div>
                            <div>
                                <label className="label">Group</label>
                                <select className="input" value={editGroupId} onChange={e => setEditGroupId(e.target.value)}>
                                    <option value="">Ungrouped</option>
                                    {groups.map(g => <option key={g._id} value={g._id}>{g.name}</option>)}
                                </select>
                            </div>
                            {allTags.length > 0 && (
                                <div>
                                    <label className="label">Tags</label>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                                        {allTags.map(tag => {
                                            const isActive = editTags.includes(tag._id);
                                            return (
                                                <button
                                                    key={tag._id}
                                                    type="button"
                                                    onClick={() => toggleEditTag(tag._id)}
                                                    style={{
                                                        display: "inline-flex", alignItems: "center", gap: 4,
                                                        padding: "3px 10px", borderRadius: 99, fontSize: 12, fontWeight: 500, cursor: "pointer",
                                                        background: isActive ? `${tag.color}18` : "var(--bg-input)",
                                                        border: `1px solid ${isActive ? tag.color + "40" : "var(--border)"}`,
                                                        color: isActive ? tag.color : "var(--text-muted)",
                                                    }}
                                                >
                                                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: isActive ? tag.color : "var(--text-dim)" }}/>
                                                    {tag.name}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>

                        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                                <div>
                                    <label className="label">Memory Limit</label>
                                    <input className="input mono" placeholder="300M" value={editMaxMemory} onChange={e => setEditMaxMemory(e.target.value)} />
                                </div>
                                <div>
                                    <label className="label">Price (VND)</label>
                                    <input type="number" className="input mono" placeholder="per month" value={editPrice} onChange={e => setEditPrice(e.target.value)} disabled={!editMaxMemory} />
                                </div>
                            </div>
                            <div>
                                <label className="label">Subscription Expiry</label>
                                <input type="datetime-local" className="input" value={editExpiry} onChange={e => setEditExpiry(e.target.value)} />
                            </div>
                        </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 12, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
                        <button className="btn-primary" style={{ padding: "8px 20px" }} onClick={saveMeta} disabled={savingMeta}>
                            {savingMeta ? '⏳ Saving…' : '💾 Save Changes'}
                        </button>
                        {isLocal && (
                            <p style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                                * Local directory — source persists on deletion.
                            </p>
                        )}
                    </div>
                </div>
            )}

            {/* Modals */}
            {confirm?.action === 'update' && (
                <ConfirmModal
                    title={isLocal ? 'Reinstall & Restart' : 'Synchronize Repository'}
                    message={isLocal ? 'Execute install command and restart the instance.' : 'Pull latest changes, reinstall dependencies, and restart.'}
                    confirmText="Continue" danger={false}
                    onConfirm={() => { setConfirm(null); runAction('update', 'update'); }}
                    onCancel={() => setConfirm(null)}
                />
            )}
            {confirm?.action === 'delete' && (
                <ConfirmModal
                    title={`Terminate "${bot.name}"?`}
                    message={isLocal
                        ? "This will stop the PM2 process and remove the bot from the panel.\n\n📂 Your project folder will NOT be deleted — it stays safe on disk."
                        : "This will stop the PM2 process, remove the bot from the panel, and delete the project folder from disk.\n\n⚠️ This action is irreversible."}
                    confirmText={isLocal ? "Remove from Panel" : "Delete Everything"}
                    onConfirm={handleDelete}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </div>
    );
}
