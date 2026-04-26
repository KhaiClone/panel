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
  online:    { dot: 'bg-emerald-400', glow: 'shadow-emerald-500/50', badge: 'bg-emerald-950/40 border-emerald-500/30 text-emerald-400', label: 'Online',    pulse: true },
  stopped:   { dot: 'bg-rose-400',     glow: 'shadow-rose-500/50',     badge: 'bg-rose-950/40 border-rose-500/30 text-rose-400',             label: 'Stopped',   pulse: false },
  errored:   { dot: 'bg-orange-400',  glow: 'shadow-orange-500/50',  badge: 'bg-orange-950/40 border-orange-500/30 text-orange-400',    label: 'Errored',   pulse: true },
  launching: { dot: 'bg-yellow-400',  glow: 'shadow-yellow-500/50',  badge: 'bg-yellow-950/40 border-yellow-500/30 text-yellow-400',   label: 'Launching', pulse: true },
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
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' +
    pad(d.getHours()) + ':' + pad(d.getMinutes())
  );
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
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

const parseMemLimit = (maxMemStr) => {
  if (!maxMemStr) return null;
  const match = maxMemStr.match(/^(\d+)([KMG]?)$/i);
  if (!match) return null;
  let val = parseInt(match[1], 10);
  const unit = match[2].toUpperCase();
  if (unit === 'K') val *= 1024;
  else if (unit === 'M') val *= 1024 * 1024;
  else if (unit === 'G') val *= 1024 * 1024 * 1024;
  return val > 0 ? val : null;
};

const getMemoryPercent = (usedBytes, maxMemStr) => {
  const limit = parseMemLimit(maxMemStr);
  if (!usedBytes || !limit) return null;
  return parseFloat(((usedBytes / limit) * 100).toFixed(1));
};

// ── Status Badge ───────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] ?? {
    dot: 'bg-slate-400', glow: '', badge: 'bg-slate-800 border-slate-700 text-slate-300', label: status ?? 'Unknown', pulse: false,
  };
  return (
    <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border text-[10px] font-black uppercase tracking-widest shadow-xl backdrop-blur-md ${cfg.badge}`}>
      <span className="relative flex h-2 w-2">
        {cfg.pulse && (
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${cfg.dot}`} />
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${cfg.dot}`} />
      </span>
      {cfg.label}
    </span>
  );
}

// ── Circular ring for resources ────────────────────────────────────────────
function ResourceRing({ percent, color, label, sub, size = 'md' }) {
  const dim = size === 'lg' ? { w: 140, cx: 70, r: 56, sw: 10, fs: 'text-2xl' } : { w: 96, cx: 44, r: 36, sw: 8, fs: 'text-lg' };
  const circ = 2 * Math.PI * dim.r;
  const [offset, setOffset] = useState(circ);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setOffset(circ - ((Math.min(percent, 100)) / 100) * circ);
    }, 100);
    return () => clearTimeout(timeout);
  }, [percent, circ]);

  const pct = Math.min(percent, 100);
  const autoColor = color ?? (pct > 85 ? '#f87171' : pct > 60 ? '#fb923c' : '#818cf8');

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative" style={{ width: dim.w, height: dim.w }}>
        <svg className="w-full h-full -rotate-90" viewBox={`0 0 ${dim.cx * 2} ${dim.cx * 2}`}>
          <circle cx={dim.cx} cy={dim.cx} r={dim.r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={dim.sw} />
          <motion.circle
            cx={dim.cx} cy={dim.cx} r={dim.r} fill="none"
            stroke={autoColor} strokeWidth={dim.sw} strokeLinecap="round"
            strokeDasharray={circ}
            animate={{ strokeDashoffset: offset }}
            transition={{ duration: 1, ease: "easeOut" }}
            style={{ filter: `drop-shadow(0 0 8px ${autoColor}66)` }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <motion.span 
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            className={`font-black text-slate-100 ${dim.fs}`}
          >
            {pct}%
          </motion.span>
        </div>
      </div>
      <div className="text-center">
        <p className={`font-black uppercase tracking-widest text-slate-400 ${size === 'lg' ? 'text-xs' : 'text-[10px]'}`}>{label}</p>
        {sub && <p className="text-[10px] font-mono text-slate-500 mt-1">{sub}</p>}
      </div>
    </div>
  );
}

const TABS = ['Controls', 'Resources', 'Logs', 'Environment', 'Files', 'Settings'];
const MEM_HINT = 'e.g. "300M", "1G" — blank for no limit';

export default function BotDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { groups } = useData();

  const [bot, setBot]         = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]         = useState('Controls');
  const [busy, setBusy]       = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [actionMsg, setActionMsg] = useState(null);

  const [editName,      setEditName]      = useState('');
  const [editExpiry,    setEditExpiry]    = useState('');
  const [editScript,    setEditScript]    = useState('');
  const [editGroupId,   setEditGroupId]   = useState('');
  const [editMaxMemory, setEditMaxMemory] = useState('');
  const [editPrice,     setEditPrice]     = useState('');
  const [savingMeta,    setSavingMeta]    = useState(false);

  const fetchBot = async () => {
    try {
      const { data } = await api.get(`/bots/${id}`);
      setBot(data);
      setEditName(data.name);
      setEditScript(data.startScript || 'index.js');
      setEditGroupId(data.groupId || '');
      setEditMaxMemory(data.maxMemory || '');
      setEditPrice(data.currentPrice || '');
      setEditExpiry(data.expiresAt ? toLocalDatetimeInputValue(data.expiresAt) : '');
    } catch {
      navigate('/dashboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBot();
    const interval = setInterval(fetchBot, 8_000);
    return () => clearInterval(interval);
  }, [id]);

  const runAction = async (name, endpoint, method = 'post') => {
    setBusy(name);
    setActionMsg(null);
    try {
      const { data } = await api[method](`/bots/${id}/${endpoint}`);
      setActionMsg({ type: 'success', text: data.message || `${name} successful` });
      fetchBot();
    } catch (err) {
      setActionMsg({ type: 'error', text: err.response?.data?.error || `${name} failed` });
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    setConfirm(null);
    setBusy('delete');
    try {
      await api.delete(`/bots/${id}`);
      navigate('/dashboard');
    } catch (err) {
      setActionMsg({ type: 'error', text: err.response?.data?.error || 'Delete failed' });
      setBusy(null);
    }
  };

  const saveMeta = async () => {
    setSavingMeta(true);
    try {
      const payload = {
        name:        editName,
        startScript: editScript,
        groupId:     editGroupId || null,
        maxMemory:   editMaxMemory || null,
        currentPrice: editPrice ? Number(editPrice) : null,
        expiresAt:   editExpiry ? new Date(editExpiry).toISOString() : null,
      };
      await api.put(`/bots/${id}`, payload);
      setActionMsg({ type: 'success', text: 'Settings saved' });
      fetchBot();
    } catch (err) {
      setActionMsg({ type: 'error', text: err.response?.data?.error || 'Save failed' });
    } finally {
      setSavingMeta(false);
    }
  };

  if (loading || !bot) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-4">
        <div className="w-10 h-10 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
        <p className="text-slate-500 text-xs font-bold uppercase tracking-widest animate-pulse">Syncing Instance...</p>
      </div>
    );
  }

  const isOnline  = bot.live?.status === 'online';
  const isStopped = !isOnline;
  const isLocal   = bot.source === 'local';
  const msLeft    = bot.expiresAt ? bot.expiresAt - Date.now() : null;
  const currentGroup = groups.find((g) => g._id === bot.groupId);
  const memPercent   = getMemoryPercent(bot.live?.memory, bot.maxMemory);
  const memLimitBytes = parseMemLimit(bot.maxMemory);
  const cpuPct = parseFloat((bot.live?.cpu ?? 0).toFixed(1));

  return (
    <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="p-6 max-w-5xl mx-auto space-y-8"
    >
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="flex items-center gap-3 lg:gap-4">
          <button
            onClick={() => navigate('/dashboard')}
            className="w-9 h-9 lg:w-10 lg:h-10 flex items-center justify-center rounded-xl bg-slate-900 border border-slate-800 text-slate-500 hover:text-slate-100 hover:border-slate-700 transition-all active:scale-95 shadow-lg"
          >
            ←
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-3xl font-black text-slate-100 tracking-tight truncate">{bot.name}</h1>
              {isLocal && (
                <span className="text-[10px] font-black uppercase tracking-widest bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 px-2.5 py-1 rounded-full shrink-0">
                  📂 Local
                </span>
              )}
              {currentGroup && (
                <span
                  className="text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full shrink-0 border"
                  style={{
                    background: `${currentGroup.color}11`,
                    borderColor: `${currentGroup.color}33`,
                    color: currentGroup.color,
                  }}
                >
                  {currentGroup.name}
                </span>
              )}
            </div>
            <p className="text-[10px] text-slate-500 font-mono mt-1 opacity-75">{bot.buyerID} / {bot.botID}</p>
          </div>
          <div className="shrink-0">
            <StatusBadge status={bot.live?.status} />
          </div>
          </div>
        </div>

        {/* ── Summary cards ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
          {[
            { label: 'CPU Load',      value: `${bot.live?.cpu ?? 0}%`, color: 'text-indigo-400' },
            {
              label: 'Memory',
              value: fmt(bot.live?.memory),
              subtext: memPercent !== null ? `${memPercent}%` : null,
              color: 'text-blue-400'
            },
            { label: 'Uptime',   value: isOnline ? formatUptime(bot.live?.uptime) : 'Offline', color: 'text-emerald-400' },
            { label: 'Restarts', value: bot.live?.restarts ?? 0, color: 'text-orange-400' },
            {
              label: 'Remaining',
              value: msLeft !== null ? formatTimeLeft(msLeft) : 'Unlimited',
              highlight: msLeft !== null && msLeft < 3 * 86_400_000,
              color: 'text-amber-400'
            },
          ].map(({ label, value, subtext, highlight, color }, i) => (
            <motion.div 
                key={label}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className="card py-4 bg-slate-900/40 border-slate-800/50 shadow-xl"
            >
              <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">{label}</p>
              <div className="flex items-baseline gap-2 mt-1">
                <p className={`text-xl font-black ${highlight ? 'text-rose-500' : color}`}>
                  {value}
                </p>
                {subtext && <span className="text-[10px] font-mono text-slate-500">{subtext}</span>}
              </div>
            </motion.div>
          ))}
        </div>

        {/* ── Action feedback ──────────────────────────────────────────────── */}
        <AnimatePresence>
            {actionMsg && (
            <motion.div 
                key="action-feedback"
                initial={{ opacity: 0, height: 0, y: -10 }}
                animate={{ opacity: 1, height: 'auto', y: 0 }}
                exit={{ opacity: 0, height: 0, y: -10 }}
                className={`text-xs font-bold uppercase tracking-wider rounded-xl px-4 py-3 border backdrop-blur-md shadow-2xl ${
                actionMsg.type === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                : 'bg-rose-500/10 border-rose-500/20 text-rose-400'
            }`}>
                {actionMsg.text}
            </motion.div>
            )}
        </AnimatePresence>

        {/* ── Tabs ────────────────────────────────────────────────────────── */}
        <div className="flex bg-slate-950/40 p-1.5 rounded-2xl border border-slate-800/50 gap-1 overflow-x-auto overflow-y-hidden no-scrollbar backdrop-blur-sm">
          {TABS.map((t) => (
            <button
              key={t}
              className={`relative px-6 py-2.5 text-[10px] font-black uppercase tracking-widest transition-all whitespace-nowrap rounded-xl group ${
                tab === t
                  ? 'text-white'
                  : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
              }`}
              onClick={() => setTab(t)}
            >
              {tab === t && (
                <motion.div 
                  layoutId="activeTabIndicator"
                  className="absolute inset-0 bg-indigo-600 rounded-xl shadow-[0_0_20px_rgba(79,70,229,0.3)]"
                  transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                />
              )}
              <span className="relative z-10">{t}</span>
            </button>
          ))}
        </div>

        {/* ── Tab Content ───────────────────────────────────────────────── */}
        <AnimatePresence mode="wait">
            <motion.div
                key={tab}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
            >
                {tab === 'Controls' && (
                <div className="card space-y-6 bg-slate-900/40 border-slate-800/50">
                    <div className="flex items-center justify-between border-b border-slate-800/50 pb-4">
                        <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                        Runtime Controls
                        </h2>
                        <span className="text-[10px] font-mono text-slate-600">PM2 ID: {bot.pm2Name}</span>
                    </div>
                    <div className="flex flex-wrap gap-3">
                    {isStopped && (
                        <button className="btn-success flex-1 min-w-[120px] py-2.5 font-black uppercase tracking-widest text-[10px]" disabled={!!busy} onClick={() => runAction('start', 'start')}>
                        {busy === 'start' ? 'Processing…' : '▶ Start Process'}
                        </button>
                    )}
                    {isOnline && (
                        <button className="btn-danger flex-1 min-w-[120px] py-2.5 font-black uppercase tracking-widest text-[10px]" disabled={!!busy} onClick={() => runAction('stop', 'stop')}>
                        {busy === 'stop' ? 'Processing…' : '⏹ Stop Process'}
                        </button>
                    )}
                    <button className="btn-warning flex-1 min-w-[120px] py-2.5 font-black uppercase tracking-widest text-[10px]" disabled={!!busy} onClick={() => runAction('restart', 'restart')}>
                        {busy === 'restart' ? 'Processing…' : '🔄 Restart'}
                    </button>
                    <button className="btn-primary flex-1 min-w-[120px] py-2.5 font-black uppercase tracking-widest text-[10px]" disabled={!!busy} onClick={() => setConfirm({ action: 'update' })}>
                        {busy === 'update' ? 'Processing…' : isLocal ? '📦 Rebuild' : '⬆️ Pull Update'}
                    </button>
                    <button className="btn-danger px-4 py-2.5 font-black uppercase tracking-widest text-[10px]" disabled={!!busy} onClick={() => setConfirm({ action: 'delete' })}>
                        🗑️ Delete
                    </button>
                    </div>

                    <div className="pt-2 space-y-3">
                    <h3 className="text-[9px] font-black text-slate-500 uppercase tracking-widest border-b border-slate-800/50 pb-2 mb-4">Metadata Analysis</h3>
                    {[
                        { label: 'Source',      value: isLocal ? `Local: ${bot.localPath}` : bot.repoUrl },
                        { label: 'Instance',    value: bot.branch || 'Production' },
                        { label: 'Entry Point', value: bot.startScript },
                        { label: 'Memory Limit',value: bot.maxMemory || 'Unrestricted' },
                        { label: 'Collection',  value: currentGroup?.name || 'Ungrouped' },
                        { label: 'Deployment',  value: fmtDate(bot.createdAt) },
                        { label: 'Expiration',  value: bot.expiresAt ? fmtDate(bot.expiresAt) : 'Permanent' },
                    ].map(({ label, value }) => (
                        <div key={label} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 group">
                        <span className="text-[10px] font-black uppercase tracking-widest text-slate-500 w-32 shrink-0">{label}</span>
                        <span className="text-[11px] text-slate-300 font-mono break-all bg-slate-950/30 px-2 py-1 rounded group-hover:bg-slate-950/50 transition-colors">{value}</span>
                        </div>
                    ))}
                    </div>
                </div>
                )}

                {tab === 'Resources' && (
                <div className="space-y-6">
                    <div className="card grid grid-cols-1 sm:grid-cols-3 gap-6 bg-slate-900/40 border-slate-800/50">
                        <div className="space-y-1">
                            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Availability</p>
                            <StatusBadge status={bot.live?.status} />
                        </div>
                        <div className="border-l border-slate-800/50 pl-6 space-y-1">
                            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Active Runtime</p>
                            <p className="text-xl font-black text-indigo-400">{isOnline ? formatUptime(bot.live?.uptime) : '0m'}</p>
                        </div>
                        <div className="border-l border-slate-800/50 pl-6 space-y-1">
                            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Crash Recovery</p>
                            <p className="text-xl font-black text-rose-400">{bot.live?.restarts ?? 0} cycles</p>
                        </div>
                    </div>

                    <div className="card bg-slate-900/40 border-slate-800/50">
                    <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-widest border-b border-slate-800/50 pb-4 mb-10">
                        Live Resource Telemetry
                    </h2>
                    <div className="flex flex-wrap items-center justify-around gap-12 py-6">
                        <ResourceRing
                        percent={cpuPct}
                        color={cpuPct > 80 ? '#f43f5e' : cpuPct > 50 ? '#f59e0b' : '#10b981'}
                        label="Compute Load"
                        sub={`${cpuPct}% utilization`}
                        size="lg"
                        />

                        {memPercent !== null ? (
                        <ResourceRing
                            percent={memPercent}
                            label="Memory Load"
                            sub={`${fmt(bot.live?.memory)} / ${fmt(memLimitBytes)}`}
                            size="lg"
                        />
                        ) : (
                        <div className="flex flex-col items-center gap-4">
                            <div className="w-[140px] h-[140px] rounded-full flex items-center justify-center border-[10px] border-slate-800/30 relative">
                                <div className="absolute inset-0 rounded-full bg-indigo-500/5 blur-xl animate-glow" />
                                <div className="flex flex-col items-center justify-center relative z-10">
                                    <span className="text-2xl font-black text-indigo-400">{fmt(bot.live?.memory)}</span>
                                    <span className="text-[9px] font-black uppercase text-slate-600 mt-1">Unlimited</span>
                                </div>
                            </div>
                            <div className="text-center">
                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Memory Usage</p>
                                <p className="text-[9px] text-slate-500 font-mono mt-1">Set limit in settings</p>
                            </div>
                        </div>
                        )}
                    </div>

                    {memPercent !== null && memPercent >= 80 && (
                        <motion.div 
                            key="memory-warning"
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            className="mt-6 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-xl px-4 py-3 text-[11px] font-bold uppercase tracking-wider flex items-center gap-3"
                        >
                        <span className="text-lg">⚠️</span>
                        <span>Memory critical: <strong>{memPercent}%</strong>. PM2 will restart process at 100%.</span>
                        </motion.div>
                    )}
                    </div>
                </div>
                )}

                {tab === 'Logs' && (
                <div className="card bg-slate-950 border-slate-800/50 p-0 overflow-hidden shadow-2xl"><LogViewer botId={id} /></div>
                )}

                {tab === 'Environment' && (
                <div className="card bg-slate-900/40 border-slate-800/50"><EnvEditor botId={id} /></div>
                )}

                {tab === 'Files' && (
                <div className="card bg-slate-900/40 border-slate-800/50"><FileEditor botId={id} /></div>
                )}

                {tab === 'Settings' && (
                <div className="card space-y-6 bg-slate-900/40 border-slate-800/50 shadow-xl">
                    <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-widest border-b border-slate-800/50 pb-4">
                    Instance Configuration
                    </h2>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-4">
                            <div>
                                <label className="label">Instance Alias</label>
                                <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} />
                            </div>
                            <div>
                                <label className="label">Primary Runtime Script</label>
                                <input className="input font-mono" value={editScript} onChange={(e) => setEditScript(e.target.value)} />
                            </div>
                            <div>
                                <label className="label">Target Deployment Group</label>
                                <select className="input" value={editGroupId} onChange={(e) => setEditGroupId(e.target.value)}>
                                    <option value="">Ungrouped</option>
                                    {groups.map((g) => (
                                        <option key={g._id} value={g._id}>{g.name}</option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <div className="space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="label">Memory Threshold</label>
                                    <input className="input font-mono" placeholder="300M" value={editMaxMemory} onChange={(e) => setEditMaxMemory(e.target.value)} />
                                </div>
                                <div>
                                    <label className="label">Hosting Unit Price</label>
                                    <input type="number" className="input font-mono" placeholder="VND/mo" value={editPrice} onChange={(e) => setEditPrice(e.target.value)} disabled={!editMaxMemory} />
                                </div>
                            </div>
                            <div>
                                <label className="label">Subscription Expiry</label>
                                <input type="datetime-local" className="input" value={editExpiry} onChange={(e) => setEditExpiry(e.target.value)} />
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-4 pt-4 border-t border-slate-800/50">
                        <button className="btn-primary px-8 py-3 font-black uppercase tracking-widest text-[10px]" onClick={saveMeta} disabled={savingMeta}>
                            {savingMeta ? 'Processing…' : '💾 Update Configuration'}
                        </button>
                        {isLocal && (
                            <p className="text-[10px] text-indigo-400/60 font-bold uppercase tracking-wider italic">
                                * Imported local directory — Source will persist on deletion.
                            </p>
                        )}
                    </div>
                </div>
                )}
            </motion.div>
        </AnimatePresence>

        {/* ── Modals ──────────────────────────────────────────────────────────── */}
        {confirm?.action === 'update' && (
            <ConfirmModal
            title={isLocal ? 'Reinstall & Restart' : 'Synchronize Repository'}
            message={isLocal ? 'Execute npm install and restart the instance.' : 'Pull latest remote changes, reinstall dependencies, and restart.'}
            confirmText="Continue Update"
            danger={false}
            onConfirm={() => { setConfirm(null); runAction('update', 'update'); }}
            onCancel={() => setConfirm(null)}
            />
        )}
        {confirm?.action === 'delete' && (
            <ConfirmModal
            title={`Terminate "${bot.name}"?`}
            message="This will immediately stop the process and wipe instance metadata. This action is irreversible."
            confirmText="Terminate Now"
            onConfirm={handleDelete}
            onCancel={() => setConfirm(null)}
            />
        )}
    </motion.div>
  );
}
