import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../api/client';
import LogViewer from '../components/LogViewer';
import ConfirmModal from '../components/ConfirmModal';
import FileEditor from '../components/FileEditor';

// ── Helpers ────────────────────────────────────────────────────────────────

const STATUS_STYLES = {
  online:    'text-emerald-400',
  stopped:   'text-red-400',
  errored:   'text-orange-400',
  launching: 'text-yellow-400',
};

const fmt = (bytes) => {
  if (!bytes) return '—';
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  return `${(bytes / 1_048_576).toFixed(0)} MB`;
};

const fmtDate = (ts) => ts ? new Date(ts).toLocaleString() : '—';

/**
 * Convert a UTC timestamp (ms) to "YYYY-MM-DDTHH:MM" in LOCAL time
 * so that <input type="datetime-local"> shows the correct local datetime
 * without any timezone drift on repeated saves.
 */
const toLocalDatetimeInputValue = (tsMs) => {
  const d = new Date(tsMs);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' +
    pad(d.getMonth() + 1) + '-' +
    pad(d.getDate()) + 'T' +
    pad(d.getHours()) + ':' +
    pad(d.getMinutes())
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

const getMemoryPercent = (usedBytes, maxMemStr) => {
  if (!usedBytes || !maxMemStr) return null;
  const match = maxMemStr.match(/^(\d+)([KMG]?)$/i);
  if (!match) return null;
  let val = parseInt(match[1], 10);
  const unit = match[2].toUpperCase();
  if (unit === 'K') val *= 1024;
  else if (unit === 'M') val *= 1024 * 1024;
  else if (unit === 'G') val *= 1024 * 1024 * 1024;
  if (val <= 0) return null;
  return ((usedBytes / val) * 100).toFixed(1) + '%';
};

const TABS = ['Controls', 'Logs', 'Environment', 'Files', 'Settings'];
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
      setEditExpiry(
        data.expiresAt
          ? toLocalDatetimeInputValue(data.expiresAt)
          : ''
      );
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

  const statusColor = STATUS_STYLES[bot.live?.status] ?? 'text-slate-400';
  const isOnline    = bot.live?.status === 'online';
  const isStopped   = !isOnline;
  const isLocal     = bot.source === 'local';
  const msLeft      = bot.expiresAt ? bot.expiresAt - Date.now() : null;

  // Find current group
  const currentGroup = groups.find((g) => g._id === bot.groupId);

  return (
    <>
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3">
          <button
            className="text-slate-500 hover:text-slate-300 transition-colors"
            onClick={() => navigate('/dashboard')}
          >
            ← Back
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
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
            <p className="text-xs text-slate-500 font-mono">{bot.buyerID} / {bot.botID}</p>
          </div>
          <span className={`text-sm font-semibold ${statusColor}`}>
            {bot.live?.status ?? 'unknown'}
          </span>
        </div>

        {/* ── System Resources ────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          {[
            { label: 'CPU',      value: `${bot.live?.cpu ?? 0}%` },
            { 
              label: 'RAM',      
              value: fmt(bot.live?.memory),
              subtext: getMemoryPercent(bot.live?.memory, bot.maxMemory) ? `${getMemoryPercent(bot.live?.memory, bot.maxMemory)} of max` : null
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
        <div className="flex border-b border-slate-700 gap-1">
          {TABS.map((t) => (
            <button
              key={t}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
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
