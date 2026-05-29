import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../api/client';
import LogViewer from '../components/LogViewer';
import EnvEditor from '../components/EnvEditor';
import ConfirmModal from '../components/ConfirmModal';
import FileEditor from '../components/FileEditor';
import { motion, AnimatePresence } from 'framer-motion';
import { useData } from '../context/DataContext';

// ── Helpers ────────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  online:    { dot: 'bg-emerald-400', badge: 'bg-emerald-950/30 border-emerald-500/25 text-emerald-400', label: 'Online',    pulse: true  },
  stopped:   { dot: 'bg-rose-400',    badge: 'bg-rose-950/30 border-rose-500/25 text-rose-400',          label: 'Stopped',   pulse: false },
  errored:   { dot: 'bg-orange-400',  badge: 'bg-orange-950/30 border-orange-500/25 text-orange-400',    label: 'Errored',   pulse: true  },
  launching: { dot: 'bg-yellow-400',  badge: 'bg-yellow-950/30 border-yellow-500/25 text-yellow-300',    label: 'Launching', pulse: true  },
};

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
  if (ms <= 0) return '🚨 Expired';
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
  if (u === 'K') v *= 1024; else if (u === 'M') v *= 1024 * 1024; else if (u === 'G') v *= 1024 * 1024 * 1024;
  return v > 0 ? v : null;
};
const getMemoryPercent = (used, maxStr) => {
  const limit = parseMemLimit(maxStr);
  if (!used || !limit) return null;
  return parseFloat(((used / limit) * 100).toFixed(1));
};

// ── Status Badge ───────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] ?? { dot: 'bg-slate-400', badge: 'bg-slate-800/30 border-slate-700 text-slate-400', label: status ?? 'Unknown', pulse: false };
  return (
    <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-[9px] font-black uppercase tracking-[0.1em] ${cfg.badge}`}>
      <span className="relative flex h-2 w-2">
        {cfg.pulse && <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-70 ${cfg.dot}`} />}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${cfg.dot}`} />
      </span>
      {cfg.label}
    </span>
  );
}

// ── Circular resource ring ──────────────────────────────────────────────────
function ResourceRing({ percent, color, label, sub }) {
  const r = 52; const circ = 2 * Math.PI * r;
  const [offset, setOffset] = useState(circ);
  useEffect(() => {
    const t = setTimeout(() => setOffset(circ - ((Math.min(percent, 100)) / 100) * circ), 120);
    return () => clearTimeout(t);
  }, [percent, circ]);
  const pct = Math.min(percent, 100);
  const c = color ?? (pct > 85 ? '#f87171' : pct > 60 ? '#fb923c' : '#818cf8');
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative" style={{ width: 130, height: 130 }}>
        <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="10" />
          <motion.circle cx="60" cy="60" r={r} fill="none" stroke={c} strokeWidth="10" strokeLinecap="round"
            strokeDasharray={circ}
            animate={{ strokeDashoffset: offset }}
            transition={{ duration: 1, ease: "easeOut" }}
            style={{ filter: `drop-shadow(0 0 10px ${c}77)` }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-black text-slate-100">{pct}%</span>
        </div>
      </div>
      <div className="text-center">
        <p className="text-xs font-black uppercase tracking-[0.1em] text-slate-400">{label}</p>
        {sub && <p className="text-[10px] font-mono text-slate-500 mt-1">{sub}</p>}
      </div>
    </div>
  );
}

// ── Tabs ───────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'Controls',    icon: '⚡' },
  { id: 'Resources',   icon: '📊' },
  { id: 'Logs',        icon: '📋' },
  { id: 'Environment', icon: '🔐' },
  { id: 'Files',       icon: '📁' },
  { id: 'Settings',    icon: '⚙️' },
];

export default function BotDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { groups, tags: allTags } = useData();

  const [bot, setBot]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]     = useState('Controls');
  const [busy, setBusy]   = useState(null);
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
      <div className="flex flex-col h-full items-center justify-center pt-32 gap-4">
        <div className="relative w-12 h-12">
          <div className="absolute inset-0 rounded-full" style={{ border: "3px solid rgba(124,58,237,0.15)" }} />
          <div className="absolute inset-0 rounded-full animate-spin" style={{ border: "3px solid transparent", borderTopColor: "#7C3AED" }} />
        </div>
        <p className="text-xs text-slate-500 font-bold uppercase tracking-widest animate-pulse">Syncing instance…</p>
      </div>
    );
  }

  const isOnline   = bot.live?.status === 'online';
  const isStopped  = !isOnline;
  const isLocal    = bot.source === 'local';
  const msLeft     = bot.expiresAt ? bot.expiresAt - Date.now() : null;
  const currentGroup = groups.find((g) => g._id === bot.groupId);
  const botTags    = (bot.tags || []).map((tagId) => allTags.find((t) => t._id === tagId)).filter(Boolean);
  const memPercent   = getMemoryPercent(bot.live?.memory, bot.maxMemory);
  const memLimitBytes = parseMemLimit(bot.maxMemory);
  const cpuPct = parseFloat((bot.live?.cpu ?? 0).toFixed(1));

  const toggleEditTag = (tagId) => {
    setEditTags((prev) =>
      prev.includes(tagId) ? prev.filter((t) => t !== tagId) : [...prev, tagId]
    );
  };

  // Summary stats
  const summaryStats = [
    { label: 'CPU',       value: `${bot.live?.cpu ?? 0}%`,                          color: '#818cf8' },
    { label: 'Memory',    value: fmt(bot.live?.memory),                             color: '#60a5fa' },
    { label: 'Uptime',    value: isOnline ? formatUptime(bot.live?.uptime) : 'Offline', color: '#34d399' },
    { label: 'Restarts',  value: bot.live?.restarts ?? 0,                            color: '#fb923c' },
    { label: 'Remaining', value: msLeft !== null ? formatTimeLeft(msLeft) : '∞',    color: '#fbbf24', highlight: msLeft !== null && msLeft < 3 * 86_400_000 },
  ];

  const cardStyle = {
    background: "linear-gradient(135deg, rgba(17,24,39,0.95) 0%, rgba(13,21,37,0.95) 100%)",
    border: "1px solid rgba(255,255,255,0.06)",
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-5 lg:p-7 max-w-5xl mx-auto space-y-6">

      {/* ── Header ── */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex items-center gap-3 lg:gap-4">
          <button
            onClick={() => navigate('/dashboard')}
            className="w-9 h-9 flex items-center justify-center rounded-xl text-slate-500 hover:text-slate-100 transition-all active:scale-95"
            style={cardStyle}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-2xl lg:text-3xl font-black text-slate-100 tracking-tight truncate">{bot.name}</h1>
              {isLocal && (
                <span className="text-[9px] font-black uppercase tracking-[0.1em] px-2.5 py-1 rounded-full shrink-0"
                  style={{ background: "rgba(124,58,237,0.12)", border: "1px solid rgba(124,58,237,0.2)", color: "#a78bfa" }}>
                  📂 Local
                </span>
              )}
              {currentGroup && (
                <span className="text-[9px] font-black uppercase tracking-[0.1em] px-2.5 py-1 rounded-full shrink-0 border"
                  style={{ background: `${currentGroup.color}14`, borderColor: `${currentGroup.color}30`, color: currentGroup.color }}>
                  {currentGroup.name}
                </span>
              )}
              {botTags.map((tag) => (
                <span key={tag._id}
                  className="text-[9px] font-black uppercase tracking-[0.07em] px-2.5 py-1 rounded-full shrink-0 border inline-flex items-center gap-1"
                  style={{ background: `${tag.color}14`, borderColor: `${tag.color}30`, color: tag.color }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: tag.color }} />
                  {tag.name}
                </span>
              ))}
            </div>
            <p className="text-[10px] text-slate-600 font-mono mt-1 truncate">{bot.buyerID} / {bot.botID}</p>
          </div>
        </div>
        <StatusBadge status={bot.live?.status} />
      </div>

      {/* ── Summary cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
        {summaryStats.map(({ label, value, color, highlight }, i) => (
          <motion.div key={label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}
            className="rounded-xl p-3.5" style={cardStyle}>
            <p className="text-[9px] font-black text-slate-500 uppercase tracking-[0.1em]">{label}</p>
            <p className="text-lg font-black mt-1.5 font-mono tracking-tight" style={{ color: highlight ? '#f87171' : color }}>
              {value}
            </p>
          </motion.div>
        ))}
      </div>

      {/* ── Action feedback ── */}
      <AnimatePresence>
        {actionMsg && (
          <motion.div key="msg" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="flex items-center gap-2.5 text-xs font-semibold rounded-xl px-4 py-3 border"
            style={{
              background: actionMsg.type === 'success' ? 'rgba(5,150,105,0.1)' : 'rgba(220,38,38,0.1)',
              borderColor: actionMsg.type === 'success' ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)',
              color: actionMsg.type === 'success' ? '#34d399' : '#f87171',
            }}>
            <span>{actionMsg.type === 'success' ? '✓' : '✕'}</span>
            {actionMsg.text}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Tabs ── */}
      <div className="tab-bar no-scrollbar">
        {TABS.map(({ id: t, icon }) => (
          <button key={t} className={`tab-item ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {tab === t && (
              <motion.div layoutId="tabBg" className="absolute inset-0 rounded-lg"
                style={{ background: "linear-gradient(135deg, rgba(124,58,237,0.25), rgba(79,70,229,0.2))", border: "1px solid rgba(124,58,237,0.2)" }}
                transition={{ type: "spring", bounce: 0.2, duration: 0.5 }} />
            )}
            <span className="relative z-10 flex items-center gap-1.5">
              <span className="text-[11px]">{icon}</span>
              <span>{t}</span>
            </span>
          </button>
        ))}
      </div>

      {/* ── Tab content ── */}
      <AnimatePresence mode="wait">
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>

          {/* CONTROLS */}
          {tab === 'Controls' && (
            <div className="space-y-5">
              <div className="card space-y-5" style={cardStyle}>
                <div className="flex items-center justify-between pb-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                  <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.12em]">Runtime Controls</h2>
                  <span className="text-[9px] font-mono text-slate-600 px-2 py-1 rounded" style={{ background: "rgba(255,255,255,0.03)" }}>
                    PM2: {bot.pm2Name}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2.5">
                  {isStopped && (
                    <button className="btn-success flex-1 min-w-[130px] py-3 font-black uppercase tracking-wider text-[10px]"
                      disabled={!!busy} onClick={() => runAction('start', 'start')}>
                      {busy === 'start' ? '⏳ Processing…' : '▶ Start Process'}
                    </button>
                  )}
                  {isOnline && (
                    <button className="btn-danger flex-1 min-w-[130px] py-3 font-black uppercase tracking-wider text-[10px]"
                      disabled={!!busy} onClick={() => runAction('stop', 'stop')}>
                      {busy === 'stop' ? '⏳ Processing…' : '⏹ Stop Process'}
                    </button>
                  )}
                  <button className="btn-warning flex-1 min-w-[130px] py-3 font-black uppercase tracking-wider text-[10px]"
                    disabled={!!busy} onClick={() => runAction('restart', 'restart')}>
                    {busy === 'restart' ? '⏳ Processing…' : '🔄 Restart'}
                  </button>
                  <button className="btn-primary flex-1 min-w-[130px] py-3 font-black uppercase tracking-wider text-[10px]"
                    disabled={!!busy} onClick={() => setConfirm({ action: 'update' })}>
                    {busy === 'update' ? '⏳ Processing…' : isLocal ? '📦 Rebuild' : '⬆️ Pull Update'}
                  </button>
                  <button className="btn-danger px-5 py-3 font-black uppercase tracking-wider text-[10px]"
                    disabled={!!busy} onClick={() => setConfirm({ action: 'delete' })}>
                    🗑️ Delete
                  </button>
                </div>
              </div>

              {/* Metadata */}
              <div className="card space-y-3" style={cardStyle}>
                <h3 className="text-[9px] font-black text-slate-500 uppercase tracking-[0.12em] pb-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                  Instance Metadata
                </h3>
                {[
                  { label: 'Source',          value: isLocal ? `Local: ${bot.localPath}` : bot.repoUrl },
                  { label: 'Branch',          value: bot.branch || 'Production' },
                  { label: 'Start Command',   value: bot.startScript },
                  { label: 'Install Command', value: bot.installCommand || '— None —' },
                  { label: 'Memory Limit',    value: bot.maxMemory || 'Unrestricted' },
                  { label: 'Group',           value: currentGroup?.name || 'Ungrouped' },
                  { label: 'Created',         value: fmtDate(bot.createdAt) },
                  { label: 'Expires',         value: bot.expiresAt ? fmtDate(bot.expiresAt) : 'Permanent' },
                ].map(({ label, value }) => (
                  <div key={label} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                    <span className="text-[9px] font-black uppercase tracking-[0.1em] text-slate-500 sm:w-32 shrink-0">{label}</span>
                    <span className="text-[11px] text-slate-300 font-mono break-all px-2 py-1 rounded" style={{ background: "rgba(6,11,20,0.5)", border: "1px solid rgba(255,255,255,0.04)" }}>{value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* RESOURCES */}
          {tab === 'Resources' && (
            <div className="space-y-5">
              <div className="card grid grid-cols-1 sm:grid-cols-3 gap-5" style={cardStyle}>
                <div>
                  <p className="text-[9px] font-black text-slate-500 uppercase tracking-[0.1em] mb-2">Status</p>
                  <StatusBadge status={bot.live?.status} />
                </div>
                <div className="sm:border-l sm:pl-5" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                  <p className="text-[9px] font-black text-slate-500 uppercase tracking-[0.1em] mb-1">Uptime</p>
                  <p className="text-xl font-black text-indigo-400">{isOnline ? formatUptime(bot.live?.uptime) : '—'}</p>
                </div>
                <div className="sm:border-l sm:pl-5" style={{ borderColor: "rgba(255,255,255,0.05)" }}>
                  <p className="text-[9px] font-black text-slate-500 uppercase tracking-[0.1em] mb-1">Restarts</p>
                  <p className="text-xl font-black text-rose-400">{bot.live?.restarts ?? 0}</p>
                </div>
              </div>

              <div className="card" style={cardStyle}>
                <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.12em] pb-5 mb-8" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                  Live Resource Telemetry
                </h2>
                <div className="flex flex-wrap items-center justify-around gap-10 py-4">
                  <ResourceRing percent={cpuPct}
                    color={cpuPct > 80 ? '#f43f5e' : cpuPct > 50 ? '#f59e0b' : '#10b981'}
                    label="CPU Load" sub={`${cpuPct}% utilization`} />
                  {memPercent !== null ? (
                    <ResourceRing percent={memPercent} label="Memory Load" sub={`${fmt(bot.live?.memory)} / ${fmt(memLimitBytes)}`} />
                  ) : (
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-[130px] h-[130px] rounded-full flex items-center justify-center relative"
                        style={{ border: "10px solid rgba(255,255,255,0.04)" }}>
                        <div className="absolute inset-0 rounded-full animate-glow" style={{ background: "radial-gradient(circle, rgba(124,58,237,0.08) 0%, transparent 70%)" }} />
                        <span className="text-xl font-black text-indigo-400 relative z-10">{fmt(bot.live?.memory)}</span>
                      </div>
                      <div className="text-center">
                        <p className="text-xs font-black uppercase tracking-[0.1em] text-slate-400">Memory Usage</p>
                        <p className="text-[10px] text-slate-500 mt-1">Set limit in Settings</p>
                      </div>
                    </div>
                  )}
                </div>
                {memPercent !== null && memPercent >= 80 && (
                  <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                    className="mt-6 rounded-xl px-4 py-3 text-[11px] font-bold flex items-center gap-3"
                    style={{ background: "rgba(220,38,38,0.1)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171" }}>
                    <span>⚠️</span>
                    <span>Memory critical: <strong>{memPercent}%</strong>. PM2 will restart at 100%.</span>
                  </motion.div>
                )}
              </div>
            </div>
          )}

          {/* LOGS */}
          {tab === 'Logs' && (
            <div className="rounded-2xl overflow-hidden" style={{ background: "#06090f", border: "1px solid rgba(255,255,255,0.06)", boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}>
              <LogViewer botId={id} />
            </div>
          )}

          {/* ENV */}
          {tab === 'Environment' && (
            <div className="card" style={cardStyle}><EnvEditor botId={id} /></div>
          )}

          {/* FILES */}
          {tab === 'Files' && (
            <div className="card" style={cardStyle}><FileEditor botId={id} /></div>
          )}

          {/* SETTINGS */}
          {tab === 'Settings' && (
            <div className="card space-y-6" style={cardStyle}>
              <div className="pb-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.12em]">Instance Configuration</h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div>
                    <label className="label">Instance Name</label>
                    <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} />
                  </div>
                  <div>
                    <label className="label">Start Command</label>
                    <input className="input font-mono" value={editScript} onChange={(e) => setEditScript(e.target.value)} />
                    <p className="text-[10px] text-slate-500 mt-1.5">Supports sudo, e.g. "sudo java -jar app.jar"</p>
                  </div>
                  <div>
                    <label className="label">Install Command</label>
                    <input className="input font-mono" placeholder="Leave empty to skip" value={editInstallCommand} onChange={(e) => setEditInstallCommand(e.target.value)} />
                    <p className="text-[10px] text-slate-500 mt-1.5">Used during rebuild/update. Leave empty to skip.</p>
                  </div>
                  <div>
                    <label className="label">Group</label>
                    <select className="input" value={editGroupId} onChange={(e) => setEditGroupId(e.target.value)}>
                      <option value="">Ungrouped</option>
                      {groups.map((g) => <option key={g._id} value={g._id}>{g.name}</option>)}
                    </select>
                  </div>
                  {allTags.length > 0 && (
                    <div>
                      <label className="label">Tags</label>
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {allTags.map((tag) => {
                          const isActive = editTags.includes(tag._id);
                          return (
                            <button
                              key={tag._id}
                              type="button"
                              onClick={() => toggleEditTag(tag._id)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[9px] font-black uppercase tracking-[0.07em] transition-all duration-150"
                              style={{
                                background: isActive ? `${tag.color}22` : 'rgba(255,255,255,0.03)',
                                border: `1px solid ${isActive ? tag.color + '55' : 'rgba(255,255,255,0.08)'}`,
                                color: isActive ? tag.color : '#64748b',
                              }}
                            >
                              <span className="w-1.5 h-1.5 rounded-full" style={{ background: isActive ? tag.color : '#64748b' }} />
                              {tag.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="label">Memory Limit</label>
                      <input className="input font-mono" placeholder="300M" value={editMaxMemory} onChange={(e) => setEditMaxMemory(e.target.value)} />
                    </div>
                    <div>
                      <label className="label">Price (VND)</label>
                      <input type="number" className="input font-mono" placeholder="per month" value={editPrice} onChange={(e) => setEditPrice(e.target.value)} disabled={!editMaxMemory} />
                    </div>
                  </div>
                  <div>
                    <label className="label">Subscription Expiry</label>
                    <input type="datetime-local" className="input" value={editExpiry} onChange={(e) => setEditExpiry(e.target.value)} />
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-4 pt-4" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                <button className="btn-primary px-8 py-3 font-black uppercase tracking-widest text-[10px]" onClick={saveMeta} disabled={savingMeta}>
                  {savingMeta ? '⏳ Saving…' : '💾 Save Changes'}
                </button>
                {isLocal && (
                  <p className="text-[9px] text-violet-400/60 font-bold uppercase tracking-wider italic">
                    * Local directory — source persists on deletion.
                  </p>
                )}
              </div>
            </div>
          )}

        </motion.div>
      </AnimatePresence>

      {/* Modals */}
      {confirm?.action === 'update' && (
        <ConfirmModal title={isLocal ? 'Reinstall & Restart' : 'Synchronize Repository'}
          message={isLocal ? 'Execute install command and restart the instance.' : 'Pull latest changes, reinstall dependencies, and restart.'}
          confirmText="Continue" danger={false}
          onConfirm={() => { setConfirm(null); runAction('update', 'update'); }}
          onCancel={() => setConfirm(null)} />
      )}
      {confirm?.action === 'delete' && (
        <ConfirmModal title={`Terminate "${bot.name}"?`}
          message={isLocal
            ? "This will stop the PM2 process and remove the bot from the panel.\n\n📂 Your project folder will NOT be deleted — it stays safe on disk."
            : "This will stop the PM2 process, remove the bot from the panel, and delete the project folder from disk.\n\n⚠️ This action is irreversible."}
          confirmText={isLocal ? "Remove from Panel" : "Delete Everything"}
          onConfirm={handleDelete}
          onCancel={() => setConfirm(null)} />
      )}
    </motion.div>
  );
}
