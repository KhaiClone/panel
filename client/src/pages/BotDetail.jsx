import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../api/client';
import LogViewer from '../components/LogViewer';
import EnvEditor from '../components/EnvEditor';
import ConfirmModal from '../components/ConfirmModal';
import FileEditor from '../components/FileEditor';

// ── Helpers ────────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  online:    { dot: 'bg-emerald-400', glow: 'shadow-emerald-500/50', badge: 'bg-emerald-900/40 border-emerald-600 text-emerald-300', label: 'Online',    pulse: true },
  stopped:   { dot: 'bg-red-400',     glow: 'shadow-red-500/50',     badge: 'bg-red-900/40 border-red-700 text-red-300',             label: 'Stopped',   pulse: false },
  errored:   { dot: 'bg-orange-400',  glow: 'shadow-orange-500/50',  badge: 'bg-orange-900/40 border-orange-600 text-orange-300',    label: 'Errored',   pulse: true },
  launching: { dot: 'bg-yellow-400',  glow: 'shadow-yellow-500/50',  badge: 'bg-yellow-900/40 border-yellow-600 text-yellow-300',   label: 'Launching', pulse: true },
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
  if (ms <= 0) return '🚨 Suspended (Expired)';
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

// Parse a memory limit string like "300M", "1G" → bytes
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
    dot: 'bg-slate-400', glow: '', badge: 'bg-slate-800 border-slate-600 text-slate-300', label: status ?? 'Unknown', pulse: false,
  };
  return (
    <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border text-sm font-semibold shadow-lg ${cfg.badge}`}>
      <span className="relative flex h-2.5 w-2.5">
        {cfg.pulse && (
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${cfg.dot}`} />
        )}
        <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${cfg.dot}`} />
      </span>
      {cfg.label}
    </span>
  );
}

// ── Circular ring for resources ────────────────────────────────────────────
function ResourceRing({ percent, color, label, sub, size = 'md' }) {
  const dim = size === 'lg' ? { w: 140, cx: 70, r: 56, sw: 10, fs: 'text-2xl' } : { w: 96, cx: 44, r: 36, sw: 8, fs: 'text-lg' };
  const circ = 2 * Math.PI * dim.r;
  const offset = circ - ((Math.min(percent, 100)) / 100) * circ;

  const pct = Math.min(percent, 100);
  const autoColor = color ?? (pct > 85 ? '#f87171' : pct > 60 ? '#fb923c' : '#818cf8');

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative" style={{ width: dim.w, height: dim.w }}>
        <svg className="w-full h-full -rotate-90" viewBox={`0 0 ${dim.w * 2 / (size === 'lg' ? 2 : 1)} ${dim.w * 2 / (size === 'lg' ? 2 : 1)}`}
          style={{ width: dim.w, height: dim.w }}>
          <circle cx={dim.cx} cy={dim.cx} r={dim.r} fill="none" stroke="#1e293b" strokeWidth={dim.sw} />
          <circle
            cx={dim.cx} cy={dim.cx} r={dim.r} fill="none"
            stroke={autoColor} strokeWidth={dim.sw} strokeLinecap="round"
            strokeDasharray={circ} strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.7s cubic-bezier(0.4,0,0.2,1)', filter: `drop-shadow(0 0 6px ${autoColor}88)` }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`font-bold text-slate-100 ${dim.fs}`}>{pct}%</span>
        </div>
      </div>
      <div className="text-center">
        <p className={`font-semibold text-slate-200 ${size === 'lg' ? 'text-base' : 'text-sm'}`}>{label}</p>
        {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

const TABS = ['Controls', 'Resources', 'Logs', 'Environment', 'Files', 'Settings'];
const MEM_HINT = 'e.g. "300M", "1G" — blank for no limit';

// ── Component ──────────────────────────────────────────────────────────────

export default function BotDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [bot, setBot]         = useState(null);
  const [groups, setGroups]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]         = useState('Controls');
  const [busy, setBusy]       = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [actionMsg, setActionMsg] = useState(null);

  // Settings edit state
  const [editName,      setEditName]      = useState('');
  const [editExpiry,    setEditExpiry]    = useState('');
  const [editScript,    setEditScript]    = useState('');
  const [editGroupId,   setEditGroupId]   = useState('');
  const [editMaxMemory, setEditMaxMemory] = useState('');
  const [editPrice,     setEditPrice]     = useState('');
  const [savingMeta,    setSavingMeta]    = useState(false);

  // ── Fetch ─────────────────────────────────────────────────────────────────
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
    api.get('/groups').then((r) => setGroups(r.data)).catch(() => {});
    const interval = setInterval(fetchBot, 8_000);
    return () => clearInterval(interval);
  }, [id]);

  // ── Actions ───────────────────────────────────────────────────────────────
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

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading || !bot) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-indigo-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  const isOnline  = bot.live?.status === 'online';
  const isStopped = !isOnline;
  const isLocal   = bot.source === 'local';
  const msLeft    = bot.expiresAt ? bot.expiresAt - Date.now() : null;
  const currentGroup = groups.find((g) => g._id === bot.groupId);

  // Memory ring data
  const memPercent   = getMemoryPercent(bot.live?.memory, bot.maxMemory);
  const memLimitBytes = parseMemLimit(bot.maxMemory);
  const cpuPct = parseFloat((bot.live?.cpu ?? 0).toFixed(1));

  return (
    <>
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="flex items-start gap-3">
          <button
            className="text-slate-500 hover:text-slate-300 transition-colors mt-1"
            onClick={() => navigate('/dashboard')}
          >
            ← Back
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-100 truncate">{bot.name}</h1>
              {isLocal && (
                <span className="text-xs bg-violet-900/50 border border-violet-700 text-violet-300 px-2 py-0.5 rounded-full shrink-0">
                  📂 Local
                </span>
              )}
              {currentGroup && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full shrink-0 border"
                  style={{
                    background: `${currentGroup.color}22`,
                    borderColor: `${currentGroup.color}66`,
                    color: currentGroup.color,
                  }}
                >
                  {currentGroup.name}
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500 font-mono mt-0.5">{bot.buyerID} / {bot.botID}</p>
          </div>
          {/* Beautiful status badge */}
          <div className="shrink-0 mt-1">
            <StatusBadge status={bot.live?.status} />
          </div>
        </div>

        {/* ── Summary cards ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          {[
            { label: 'CPU',      value: `${bot.live?.cpu ?? 0}%` },
            {
              label: 'RAM',
              value: fmt(bot.live?.memory),
              subtext: memPercent !== null ? `${memPercent}% of max` : null,
            },
            { label: 'Uptime',   value: isOnline ? formatUptime(bot.live?.uptime) : '—' },
            { label: 'Restarts', value: bot.live?.restarts ?? 0 },
            {
              label: 'Expires',
              value: msLeft !== null ? formatTimeLeft(msLeft) : '♾️ Never',
              highlight: msLeft !== null && msLeft < 3 * 86_400_000,
            },
          ].map(({ label, value, subtext, highlight }) => (
            <div key={label} className="card py-3">
              <p className="text-xs text-slate-500 uppercase tracking-wider">{label}</p>
              <div className="flex items-baseline gap-2 mt-0.5">
                <p className={`text-lg font-bold ${highlight ? 'text-amber-400' : 'text-slate-100'}`}>
                  {value}
                </p>
                {subtext && <span className="text-xs text-slate-400">{subtext}</span>}
              </div>
            </div>
          ))}
        </div>

        {/* ── Action feedback ──────────────────────────────────────────────── */}
        {actionMsg && (
          <div className={`text-sm rounded-lg px-4 py-2.5 border ${
            actionMsg.type === 'success'
              ? 'bg-emerald-900/40 border-emerald-700 text-emerald-400'
              : 'bg-red-900/40 border-red-700 text-red-400'
          }`}>
            {actionMsg.text}
          </div>
        )}

        {/* ── Tabs ────────────────────────────────────────────────────────── */}
        <div className="flex border-b border-slate-700 gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap ${
                tab === t
                  ? 'border-indigo-500 text-indigo-400'
                  : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>

        {/* ── Tab: Controls ───────────────────────────────────────────────── */}
        {tab === 'Controls' && (
          <div className="card space-y-5">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
              Process Control
            </h2>
            <div className="flex flex-wrap gap-3">
              {isStopped && (
                <button className="btn-success" disabled={!!busy} onClick={() => runAction('start', 'start')}>
                  {busy === 'start' ? '…' : '▶ Start'}
                </button>
              )}
              {isOnline && (
                <button className="btn-danger" disabled={!!busy} onClick={() => runAction('stop', 'stop')}>
                  {busy === 'stop' ? '…' : '⏹ Stop'}
                </button>
              )}
              <button className="btn-warning" disabled={!!busy} onClick={() => runAction('restart', 'restart')}>
                {busy === 'restart' ? '…' : '🔄 Restart'}
              </button>
              <button className="btn-primary" disabled={!!busy} onClick={() => setConfirm({ action: 'update' })}>
                {busy === 'update' ? '…' : isLocal ? '📦 Reinstall & Restart' : '⬆️ Pull & Update'}
              </button>
              <button className="btn-danger ml-auto" disabled={!!busy} onClick={() => setConfirm({ action: 'delete' })}>
                🗑️ Delete Bot
              </button>
            </div>

            {/* Bot info */}
            <div className="border-t border-slate-700 pt-4 space-y-2 text-sm">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Bot Info</h3>
              {[
                { label: 'PM2 Name',    value: bot.pm2Name },
                isLocal
                  ? { label: 'Local Path',  value: bot.localPath }
                  : { label: 'Repo URL',    value: bot.repoUrl },
                { label: 'Branch',      value: bot.branch || '—' },
                { label: 'Start Script',value: bot.startScript },
                { label: 'Max Memory',  value: bot.maxMemory || 'No limit' },
                { label: 'Group',       value: currentGroup?.name || 'None' },
                { label: 'Created',     value: fmtDate(bot.createdAt) },
                { label: 'Expires At',  value: bot.expiresAt ? fmtDate(bot.expiresAt) : 'Never' },
              ].map(({ label, value }) => (
                <div key={label} className="flex gap-4">
                  <span className="text-slate-500 w-28 shrink-0">{label}</span>
                  <span className="text-slate-200 font-mono text-xs break-all">{value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Tab: Resources ──────────────────────────────────────────────── */}
        {tab === 'Resources' && (
          <div className="space-y-4">
            {/* Status hero */}
            <div className="card flex items-center gap-4">
              <div>
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Current Status</p>
                <StatusBadge status={bot.live?.status} />
              </div>
              <div className="border-l border-slate-700 pl-4 ml-2">
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Uptime</p>
                <p className="text-lg font-bold text-slate-100">{isOnline ? formatUptime(bot.live?.uptime) : '—'}</p>
              </div>
              <div className="border-l border-slate-700 pl-4">
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Restarts</p>
                <p className="text-lg font-bold text-slate-100">{bot.live?.restarts ?? 0}</p>
              </div>
            </div>

            {/* Resource rings */}
            <div className="card">
              <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-6">
                Process Resource Usage
              </h2>
              <div className="flex flex-wrap items-center justify-around gap-8 py-4">
                {/* CPU ring */}
                <ResourceRing
                  percent={cpuPct}
                  color={cpuPct > 80 ? '#f87171' : cpuPct > 50 ? '#fb923c' : '#34d399'}
                  label="CPU Usage"
                  sub={`${cpuPct}% of core`}
                  size="lg"
                />

                {/* RAM ring — with limit % if available, else raw bytes */}
                {memPercent !== null ? (
                  <ResourceRing
                    percent={memPercent}
                    label="Memory Usage"
                    sub={`${fmt(bot.live?.memory)} / ${fmt(memLimitBytes)}`}
                    size="lg"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <div
                      className="w-36 h-36 rounded-full flex items-center justify-center"
                      style={{
                        background: 'conic-gradient(#818cf8 0%, #1e293b 0%)',
                        boxShadow: '0 0 24px #818cf844',
                        border: '10px solid #1e293b',
                      }}
                    >
                      <div className="flex flex-col items-center justify-center">
                        <span className="text-2xl font-bold text-slate-100">{fmt(bot.live?.memory)}</span>
                        <span className="text-xs text-slate-400 mt-1">no limit set</span>
                      </div>
                    </div>
                    <div className="text-center">
                      <p className="text-base font-semibold text-slate-200">Memory Usage</p>
                      <p className="text-xs text-slate-500 mt-0.5">Set a limit in Settings to see %</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Warning if memory is high */}
              {memPercent !== null && memPercent >= 80 && (
                <div className="mt-4 bg-amber-900/30 border border-amber-700 text-amber-300 rounded-lg px-4 py-2.5 text-sm">
                  ⚠️ Memory usage is at <strong>{memPercent}%</strong> of the configured limit ({bot.maxMemory}). PM2 will automatically restart this bot when it hits 100%.
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Tab: Logs ───────────────────────────────────────────────────── */}
        {tab === 'Logs' && (
          <div className="card"><LogViewer botId={id} /></div>
        )}

        {/* ── Tab: Environment ────────────────────────────────────────────── */}
        {tab === 'Environment' && (
          <div className="card"><EnvEditor botId={id} /></div>
        )}

        {/* ── Tab: Files ──────────────────────────────────────────────────── */}
        {tab === 'Files' && (
          <div className="card"><FileEditor botId={id} /></div>
        )}

        {/* ── Tab: Settings ───────────────────────────────────────────────── */}
        {tab === 'Settings' && (
          <div className="card space-y-4">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
              Edit Metadata
            </h2>

            <div>
              <label className="label">Display Name</label>
              <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>

            <div>
              <label className="label">Start Script</label>
              <input className="input font-mono" value={editScript} onChange={(e) => setEditScript(e.target.value)} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="label">Group</label>
                <select className="input" value={editGroupId} onChange={(e) => setEditGroupId(e.target.value)}>
                  <option value="">— No group —</option>
                  {groups.map((g) => (
                    <option key={g._id} value={g._id}>{g.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Max Memory Restart</label>
                <input
                  className="input font-mono"
                  placeholder="300M"
                  value={editMaxMemory}
                  onChange={(e) => setEditMaxMemory(e.target.value)}
                  pattern="^\d+[KMG]?$"
                  title={MEM_HINT}
                />
                <p className="text-xs text-slate-500 mt-1">{MEM_HINT}</p>
              </div>
              <div>
                <label className="label">Current Price (VND/m)</label>
                <input
                  type="number"
                  className="input font-mono disabled:opacity-50"
                  placeholder="Optional"
                  value={editPrice}
                  onChange={(e) => setEditPrice(e.target.value)}
                  disabled={!editMaxMemory}
                  title="Only available when Max Memory is set"
                />
                <p className="text-xs text-slate-500 mt-1">Optional override price.</p>
              </div>
            </div>

            <div>
              <label className="label">Expiry Date</label>
              <input
                type="datetime-local"
                className="input"
                value={editExpiry}
                onChange={(e) => setEditExpiry(e.target.value)}
              />
              <p className="text-xs text-slate-500 mt-1">Clear to remove expiry.</p>
            </div>

            {isLocal && (
              <div className="bg-violet-900/20 border border-violet-800/50 rounded-lg px-4 py-3 text-xs text-violet-300">
                📂 This bot was imported from a local folder. The source directory will <strong>not</strong> be deleted when you remove the bot.
              </div>
            )}

            <button className="btn-primary" onClick={saveMeta} disabled={savingMeta}>
              {savingMeta ? 'Saving…' : '💾 Save Settings'}
            </button>
          </div>
        )}
      </div>

      {/* ── Confirm: Update ──────────────────────────────────────────────────── */}
      {confirm?.action === 'update' && (
        <ConfirmModal
          title={isLocal ? 'Reinstall & Restart' : 'Pull & Update Bot'}
          message={
            isLocal
              ? 'This will run npm install and restart the bot. If the folder is a git repo, git pull will also run.'
              : 'This will run git pull + npm install, then restart the bot. Local changes in the bot directory will be overwritten.'
          }
          confirmText={isLocal ? 'Reinstall & Restart' : 'Update & Restart'}
          danger={false}
          onConfirm={() => { setConfirm(null); runAction('update', 'update'); }}
          onCancel={() => setConfirm(null)}
        />
      )}

      {/* ── Confirm: Delete ──────────────────────────────────────────────────── */}
      {confirm?.action === 'delete' && (
        <ConfirmModal
          title={`Delete "${bot.name}"?`}
          message={
            isLocal
              ? 'This will stop the bot and remove it from PM2 and the database. The local folder on disk will NOT be deleted.'
              : 'This will stop the bot, remove it from PM2, and permanently delete its source directory. This cannot be undone.'
          }
          confirmText="Delete Forever"
          onConfirm={handleDelete}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}
