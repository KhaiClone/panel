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
    online:    { color: "var(--success)", bg: "var(--success-bg)", border: "var(--success-border)", label: "Online" },
    stopped:   { color: "var(--danger)", bg: "var(--danger-bg)", border: "var(--danger-border)", label: "Stopped" },
    errored:   { color: "#F97316", bg: "rgba(249,115,22,0.15)", border: "rgba(249,115,22,0.3)", label: "Errored" },
    launching: { color: "var(--warning)", bg: "var(--warning-bg)", border: "var(--warning-border)", label: "Starting" },
};
const getStyle = (s) => STATUS_STYLES[s] ?? { color: "var(--text-muted)", bg: "rgba(255,255,255,0.05)", border: "rgba(255,255,255,0.1)", label: s ?? "Unknown" };

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

function ProgressBar({ percent, color, animated = false }) {
    const pct = Math.min(Math.max(percent ?? 0, 0), 100);
    return (
        <div style={{ background: "var(--bg-input)", borderRadius: 8, height: 10, overflow: "hidden", position: "relative" }}>
            <div style={{ 
                width: `${pct}%`, height: "100%", borderRadius: 8, background: color, 
                transition: "width 0.5s cubic-bezier(0.4, 0, 0.2, 1)",
                position: "relative",
                overflow: "hidden"
            }}>
                {animated && <div style={{ 
                    position: "absolute", top: 0, left: 0, bottom: 0, width: "200%",
                    background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)",
                    animation: "shimmer 2s infinite"
                }} />}
            </div>
        </div>
    );
}

// ── SVG Icon Components ─────────────────────────────────────────────────────
const IconCpu = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
        <rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/>
        <line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/>
        <line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/>
        <line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/>
        <line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>
    </svg>
);
const IconMemory = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
        <rect x="2" y="6" width="20" height="12" rx="2"/>
        <line x1="6" y1="10" x2="6" y2="14"/><line x1="10" y1="10" x2="10" y2="14"/>
        <line x1="14" y1="10" x2="14" y2="14"/><line x1="18" y1="10" x2="18" y2="14"/>
    </svg>
);
const IconClock = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
);
const IconRefresh = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>
    </svg>
);
const IconHourglass = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 16, height: 16 }}>
        <path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/>
        <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>
    </svg>
);

// Inline spinner for buttons
const BtnSpinner = () => (
    <div style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid currentColor", borderTopColor: "transparent", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
);

const TABS = ['Manage', 'Resources', 'Logs', 'Environment', 'Files'];

export default function BotDetail() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { groups, tags: allTags } = useData();

    const [bot, setBot]       = useState(null);
    const [loading, setLoading] = useState(true);
    const [tab, setTab]       = useState('Manage');
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
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 16 }}>
                <div style={{ width: 48, height: 48, borderRadius: "50%", border: "4px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 1s linear infinite" }}/>
                <p style={{ fontSize: 15, color: "var(--text-muted)", fontWeight: 500 }}>Initializing Environment…</p>
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

    const toggleEditTag = (tagId) => setEditTags(prev => prev.includes(tagId) ? prev.filter(t => t !== tagId) : [...prev, tagId]);

    return (
        <div className="fade-in" style={{ padding: "32px", maxWidth: 1200, margin: "0 auto" }}>
            
            {/* Action message */}
            {actionMsg && (
                <div className="slide-up" style={{
                    display: "flex", alignItems: "center", gap: 12, marginBottom: 24,
                    padding: "12px 20px", borderRadius: 10, fontSize: 14, fontWeight: 500,
                    background: actionMsg.type === 'success' ? "var(--success-bg)" : "var(--danger-bg)",
                    border: `1px solid ${actionMsg.type === 'success' ? "var(--success-border)" : "var(--danger-border)"}`,
                    color: actionMsg.type === 'success' ? "var(--success)" : "var(--danger)",
                    boxShadow: actionMsg.type === 'success' ? "0 4px 12px rgba(16,185,129,0.2)" : "0 4px 12px rgba(239,68,68,0.2)"
                }}>
                    {actionMsg.type === 'success' ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 16, height: 16, flexShrink: 0 }}><polyline points="20 6 9 17 4 12"/></svg>
                    ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 16, height: 16, flexShrink: 0 }}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    )}
                    {actionMsg.text}
                    <button onClick={() => setActionMsg(null)} style={{ marginLeft: "auto", background: "none", border: "none", color: "inherit", cursor: "pointer", opacity: 0.7, padding: 4, display: "flex", alignItems: "center" }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14 }}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
            )}

            {/* Header */}
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <button onClick={() => navigate('/dashboard')} className="btn-ghost" style={{ padding: 10, borderRadius: 12, background: "var(--bg-input)" }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 18, height: 18 }}><polyline points="15 18 9 12 15 6"/></svg>
                    </button>
                    <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
                            <h1 style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", margin: 0, letterSpacing: "-0.02em" }}>{bot.name}</h1>
                            {isLocal && (
                                <span className="badge" style={{ background: "var(--accent-dim)", border: "1px solid var(--accent)", color: "var(--accent)", display: "flex", alignItems: "center", gap: 5 }}>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 11, height: 11 }}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                                    Local
                                </span>
                            )}
                            {currentGroup && (
                                <span className="badge" style={{ background: `${currentGroup.color}20`, border: `1px solid ${currentGroup.color}40`, color: currentGroup.color }}>{currentGroup.name}</span>
                            )}
                            {botTags.map(tag => (
                                <span key={tag._id} className="badge" style={{ background: `${tag.color}20`, border: `1px solid ${tag.color}40`, color: tag.color }}>
                                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: tag.color }}/>
                                    {tag.name}
                                </span>
                            ))}
                        </div>
                        <p className="mono" style={{ fontSize: 13, color: "var(--text-dim)" }}>
                            {bot.buyerID} / {bot.botID}
                        </p>
                    </div>
                </div>

                <div className="status-pill" style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color, padding: "8px 16px", fontSize: 14 }}>
                    <span className="status-dot" style={{ background: s.color, width: 10, height: 10 }}/>
                    {s.label}
                </div>
            </div>

            {/* Decorative status accent bar */}
            <div style={{ height: 2, background: `linear-gradient(90deg, ${s.color}, transparent)`, marginBottom: 28, borderRadius: 1 }} />

            {/* Summary stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 32 }}>
                {[
                    { label: "CPU Usage",  value: `${bot.live?.cpu ?? 0}%`,                        color: "var(--accent-hover)", Icon: IconCpu },
                    { label: "Memory",     value: fmt(bot.live?.memory),                            color: "#60A5FA",             Icon: IconMemory },
                    { label: "Uptime",     value: isOnline ? formatUptime(bot.live?.uptime) : "—", color: "var(--success)",      Icon: IconClock },
                    { label: "Restarts",   value: bot.live?.restarts ?? 0,                          color: "var(--danger)",       Icon: IconRefresh },
                    { label: "Time Left",  value: msLeft !== null ? formatTimeLeft(msLeft) : "∞",  color: msLeft !== null && msLeft < 3 * 86_400_000 ? "var(--danger)" : "var(--warning)", Icon: IconHourglass },
                ].map(({ label, value, color, Icon }) => (
                    <div key={label} className="card card-hover" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</p>
                            <span style={{ color, opacity: 0.6 }}><Icon /></span>
                        </div>
                        <p className="mono" style={{ fontSize: 22, fontWeight: 700, color }}>{value}</p>
                    </div>
                ))}
            </div>

            {/* Tabs */}
            <div className="tab-bar" style={{ marginBottom: 24, display: "inline-flex" }}>
                {TABS.map(t => (
                    <button key={t} className={`tab-item ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
                        {t}
                    </button>
                ))}
            </div>

            <div className="slide-up">
                {/* ── Manage Tab (Controls + Settings merged) ── */}
                {tab === 'Manage' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

                        {/* Section 1: Runtime Controls + Metadata side by side */}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, alignItems: "start" }}>
                            {/* Runtime Controls card */}
                            <div className="card">
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, paddingBottom: 16, borderBottom: "1px solid var(--border-light)" }}>
                                    <div>
                                        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", margin: 0 }}>Runtime Controls</h2>
                                        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>Manage the PM2 instance lifecycle</p>
                                    </div>
                                    <span className="mono badge" style={{ background: "var(--bg-input)", color: "var(--text-dim)", border: "1px solid var(--border)" }}>
                                        {bot.pm2Name}
                                    </span>
                                </div>
                                
                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                                    {isStopped && (
                                        <button className="btn-success" style={{ padding: "12px", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }} disabled={!!busy} onClick={() => runAction('start', 'start')}>
                                            {busy === 'start' ? (
                                                <><BtnSpinner /> Starting…</>
                                            ) : (
                                                <><svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 14, height: 14 }}><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Instance</>
                                            )}
                                        </button>
                                    )}
                                    {isOnline && (
                                        <button className="btn-danger" style={{ padding: "12px", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }} disabled={!!busy} onClick={() => runAction('stop', 'stop')}>
                                            {busy === 'stop' ? (
                                                <><BtnSpinner /> Stopping…</>
                                            ) : (
                                                <><svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 14, height: 14 }}><rect x="6" y="6" width="12" height="12" rx="2"/></svg> Stop Instance</>
                                            )}
                                        </button>
                                    )}
                                    <button className="btn-warning" style={{ padding: "12px", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }} disabled={!!busy} onClick={() => runAction('restart', 'restart')}>
                                        {busy === 'restart' ? (
                                            <><BtnSpinner /> Restarting…</>
                                        ) : (
                                            <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14 }}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> Restart Instance</>
                                        )}
                                    </button>
                                    <button className="btn-primary" style={{ padding: "12px", gridColumn: "1 / -1", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }} disabled={!!busy} onClick={() => setConfirm({ action: 'update' })}>
                                        {busy === 'update' ? (
                                            <><BtnSpinner /> Processing…</>
                                        ) : isLocal ? (
                                            <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Rebuild from Local</>
                                        ) : (
                                            <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg> Pull &amp; Update from Git</>
                                        )}
                                    </button>
                                </div>
                            </div>

                            {/* Instance Metadata card */}
                            <div className="card">
                                <h3 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", marginBottom: 20, paddingBottom: 16, borderBottom: "1px solid var(--border-light)" }}>
                                    Instance Metadata
                                </h3>
                                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                                    {[
                                        { label: 'Source',          value: isLocal ? `Local: ${bot.localPath}` : bot.repoUrl },
                                        { label: 'Branch',          value: bot.branch || 'main' },
                                        { label: 'Start Command',   value: bot.startScript },
                                        { label: 'Install Command', value: bot.installCommand || '—' },
                                        { label: 'Memory Limit',    value: bot.maxMemory || 'Unrestricted' },
                                        { label: 'Created',         value: fmtDate(bot.createdAt) },
                                        { label: 'Expires',         value: bot.expiresAt ? fmtDate(bot.expiresAt) : 'Permanent' },
                                    ].map(({ label, value }) => (
                                        <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                                            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-muted)", flexShrink: 0 }}>{label}</span>
                                            <span className="mono" style={{ fontSize: 13, color: "var(--text)", textAlign: "right", wordBreak: "break-all" }}>{value}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* Divider */}
                        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                            <div style={{ flex: 1, height: 1, background: "var(--border-light)" }} />
                            <h3 style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", margin: 0, whiteSpace: "nowrap" }}>Configuration</h3>
                            <div style={{ flex: 1, height: 1, background: "var(--border-light)" }} />
                        </div>

                        {/* Section 2: Configuration form */}
                        <div className="card">
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32, marginBottom: 32 }}>
                                <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                                    <div>
                                        <label className="label">Instance Name</label>
                                        <input className="input" value={editName} onChange={e => setEditName(e.target.value)} />
                                    </div>
                                    <div>
                                        <label className="label">Start Command</label>
                                        <input className="input mono" value={editScript} onChange={e => setEditScript(e.target.value)} />
                                        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>Supports sudo, e.g. <span className="mono">sudo java -jar app.jar</span></p>
                                    </div>
                                    <div>
                                        <label className="label">Install Command</label>
                                        <input className="input mono" placeholder="Leave empty to skip" value={editInstallCommand} onChange={e => setEditInstallCommand(e.target.value)} />
                                        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>Executed during rebuild or git pull.</p>
                                    </div>
                                    <div>
                                        <label className="label">Group Assignment</label>
                                        <select className="input" value={editGroupId} onChange={e => setEditGroupId(e.target.value)}>
                                            <option value="">Ungrouped</option>
                                            {groups.map(g => <option key={g._id} value={g._id}>{g.name}</option>)}
                                        </select>
                                    </div>
                                    {allTags.length > 0 && (
                                        <div>
                                            <label className="label">Tags</label>
                                            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                                                {allTags.map(tag => {
                                                    const isActive = editTags.includes(tag._id);
                                                    return (
                                                        <button
                                                            key={tag._id} type="button" onClick={() => toggleEditTag(tag._id)}
                                                            className="badge"
                                                            style={{
                                                                cursor: "pointer", transition: "all 0.2s",
                                                                background: isActive ? `${tag.color}25` : "var(--bg-input)",
                                                                border: `1px solid ${isActive ? tag.color + "50" : "var(--border)"}`,
                                                                color: isActive ? tag.color : "var(--text-muted)",
                                                            }}
                                                        >
                                                            <span style={{ width: 8, height: 8, borderRadius: "50%", background: isActive ? tag.color : "var(--text-dim)", transition: "all 0.2s" }}/>
                                                            {tag.name}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                                        <div>
                                            <label className="label">Memory Limit</label>
                                            <input className="input mono" placeholder="e.g. 500M, 1G" value={editMaxMemory} onChange={e => setEditMaxMemory(e.target.value)} />
                                        </div>
                                        <div>
                                            <label className="label">Monthly Price (VND)</label>
                                            <input type="number" className="input mono" placeholder="e.g. 50000" value={editPrice} onChange={e => setEditPrice(e.target.value)} disabled={!editMaxMemory} />
                                        </div>
                                    </div>
                                    <div>
                                        <label className="label">Subscription Expiration</label>
                                        <input type="datetime-local" className="input" value={editExpiry} onChange={e => setEditExpiry(e.target.value)} />
                                    </div>
                                    
                                    <div style={{ marginTop: "auto", background: "var(--bg-input)", padding: 16, borderRadius: 8, border: "1px solid var(--border)" }}>
                                        <h4 style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>Need Help?</h4>
                                        <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                                            Make sure the memory limit uses correct suffixes (K, M, G). The start command will be executed from the root of your project directory.
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <div style={{ display: "flex", alignItems: "center", gap: 16, paddingTop: 20, borderTop: "1px solid var(--border-light)" }}>
                                <button className="btn-primary" style={{ padding: "10px 24px", display: "flex", alignItems: "center", gap: 8 }} onClick={saveMeta} disabled={savingMeta}>
                                    {savingMeta ? (
                                        <><BtnSpinner /> Saving…</>
                                    ) : (
                                        <><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 15, height: 15 }}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Configuration</>
                                    )}
                                </button>
                                {isLocal && (
                                    <p style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic", display: "flex", alignItems: "center", gap: 6 }}>
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                                        Local directory mapping — source code persists even if instance is deleted.
                                    </p>
                                )}
                            </div>
                        </div>

                        {/* Danger Zone */}
                        <div style={{ padding: 20, borderRadius: 10, background: 'rgba(239,68,68,0.03)', border: '1px solid var(--danger-border)' }}>
                            <h3 style={{ fontSize: 12, fontWeight: 700, color: 'var(--danger)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 12px' }}>Danger Zone</h3>
                            <button
                                className="btn-ghost"
                                style={{ padding: "10px 20px", color: "var(--danger)", border: "1px solid var(--danger-border)", background: "rgba(239,68,68,0.05)", display: "flex", alignItems: "center", gap: 8 }}
                                disabled={!!busy}
                                onClick={() => setConfirm({ action: 'delete' })}
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16 }}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                                Delete Instance
                            </button>
                        </div>
                    </div>
                )}

                {/* Resources Tab */}
                {tab === 'Resources' && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
                        <div className="card" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24 }}>
                            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
                                <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>Current Status</p>
                                <span className="status-pill" style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color, fontSize: 15, padding: "8px 20px" }}>
                                    <span className="status-dot" style={{ background: s.color, width: 10, height: 10 }}/>
                                    {s.label}
                                </span>
                            </div>
                            <div style={{ borderLeft: "1px solid var(--border-light)", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
                                <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>Uptime</p>
                                <p style={{ fontSize: 28, fontWeight: 700, color: "var(--accent-hover)" }}>{isOnline ? formatUptime(bot.live?.uptime) : '—'}</p>
                            </div>
                            <div style={{ borderLeft: "1px solid var(--border-light)", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
                                <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>Process Restarts</p>
                                <p style={{ fontSize: 28, fontWeight: 700, color: "var(--danger)" }}>{bot.live?.restarts ?? 0}</p>
                            </div>
                        </div>

                        <div className="card">
                            <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", marginBottom: 24, paddingBottom: 16, borderBottom: "1px solid var(--border-light)" }}>
                                Live Hardware Metrics
                            </h2>
                            <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
                                {/* CPU */}
                                <div>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                            <span style={{ padding: 6, background: "var(--bg-input)", borderRadius: 6, display: "flex", alignItems: "center", color: "var(--text-muted)" }}><IconCpu /></span>
                                            <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>CPU Utilization</span>
                                        </div>
                                        <span className="mono" style={{ fontSize: 16, fontWeight: 700, color: cpuPct > 80 ? "#ef4444" : cpuPct > 50 ? "#f59e0b" : "#10b981" }}>
                                            {cpuPct}%
                                        </span>
                                    </div>
                                    <ProgressBar percent={cpuPct} color={cpuPct > 80 ? "#ef4444" : cpuPct > 50 ? "#f59e0b" : "#10b981"} animated={isOnline} />
                                </div>
                                {/* Memory */}
                                <div>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                            <span style={{ padding: 6, background: "var(--bg-input)", borderRadius: 6, display: "flex", alignItems: "center", color: "var(--text-muted)" }}><IconMemory /></span>
                                            <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>Memory Utilization</span>
                                        </div>
                                        <span className="mono" style={{ fontSize: 16, fontWeight: 700, color: memPercent !== null && memPercent > 80 ? "#ef4444" : "#6366f1" }}>
                                            {fmt(bot.live?.memory)}{memLimitBytes ? ` / ${fmt(memLimitBytes)}` : ""}
                                        </span>
                                    </div>
                                    {memPercent !== null ? (
                                        <ProgressBar percent={memPercent} color={memPercent > 85 ? "var(--danger)" : "var(--accent-hover)"} animated={isOnline} />
                                    ) : (
                                        <div style={{ background: "var(--bg-input)", borderRadius: 8, height: 10 }}>
                                            <div style={{ height: "100%", borderRadius: 8, background: "var(--accent-hover)", width: "30%", opacity: 0.5 }}/>
                                        </div>
                                    )}
                                    {memPercent !== null && memPercent >= 80 && (
                                        <div style={{ marginTop: 12, padding: "8px 12px", background: "var(--danger-bg)", border: "1px solid var(--danger-border)", borderRadius: 6, display: "inline-flex", gap: 8, color: "var(--danger)", fontSize: 13, fontWeight: 500 }}>
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14, flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                                            Warning: Memory critical at {memPercent}%. PM2 will restart process if it hits 100%.
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Logs Tab */}
                {tab === 'Logs' && (
                    <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid var(--border)", background: "var(--bg-base)", boxShadow: "0 10px 30px rgba(0,0,0,0.5)" }}>
                        <LogViewer botId={id} />
                    </div>
                )}

                {/* Environment Tab */}
                {tab === 'Environment' && (
                    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                        <EnvEditor botId={id} />
                    </div>
                )}

                {/* Files Tab */}
                {tab === 'Files' && (
                    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                        <FileEditor botId={id} />
                    </div>
                )}
            </div>

            {/* Modals */}
            {confirm?.action === 'update' && (
                <ConfirmModal
                    title={isLocal ? 'Rebuild Local Instance?' : 'Synchronize Git Repository?'}
                    message={isLocal ? 'Execute the install command and restart the instance.' : 'Pull latest changes, reinstall dependencies, and restart.'}
                    confirmText="Continue Update" danger={false}
                    onConfirm={() => { setConfirm(null); runAction('update', 'update'); }}
                    onCancel={() => setConfirm(null)}
                />
            )}
            {confirm?.action === 'delete' && (
                <ConfirmModal
                    title={`Terminate "${bot.name}"?`}
                    message={isLocal
                        ? "This will stop the PM2 process and remove the instance from the panel.\n\n📂 Your project folder will NOT be deleted."
                        : "This will stop the PM2 process, remove the instance, and delete the project folder from disk.\n\n⚠️ This action is irreversible."}
                    confirmText={isLocal ? "Remove from Panel" : "Delete Everything"}
                    onConfirm={handleDelete}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </div>
    );
}
