import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useData } from '../context/DataContext';
import api from '../api/client';
import { motion, AnimatePresence } from 'framer-motion';
import ConfirmModal from '../components/ConfirmModal';

// ── Status helpers ─────────────────────────────────────────────────────────
const STATUS_DOT = {
  online:    'bg-emerald-400',
  stopped:   'bg-rose-400',
  errored:   'bg-orange-400',
  launching: 'bg-yellow-400',
};
const STATUS_LABEL = {
  online:    'Online',
  stopped:   'Stopped',
  errored:   'Errored',
  launching: 'Launching',
};

// ── Action definitions ─────────────────────────────────────────────────────
const ACTIONS = [
  { key: 'start',   label: '▶ Start',    style: 'btn-success',  icon: '▶',  danger: false },
  { key: 'stop',    label: '⏹ Stop',     style: 'btn-danger',   icon: '⏹',  danger: false },
  { key: 'restart', label: '🔄 Restart',  style: 'btn-warning',  icon: '🔄', danger: false },
  { key: 'install', label: '📦 Install',  style: 'btn-primary',  icon: '📦', danger: false },
  { key: 'update',  label: '⬆️ Update',  style: 'btn-primary',  icon: '⬆️', danger: false },
  { key: 'remove',  label: '🗑️ Remove',  style: 'btn-danger',   icon: '🗑️', danger: true  },
];

// ── Compact bot row ────────────────────────────────────────────────────────
function BotRow({ bot, selected, onToggle, groupColor }) {
  const status = bot.live?.status || 'stopped';
  const dotClass = STATUS_DOT[status] || 'bg-slate-400';
  const isExpired = bot.expiresAt && bot.expiresAt <= Date.now();

  return (
    <motion.label
      layout
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      className={`flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer transition-all duration-200 group select-none ${
        selected
          ? 'bg-indigo-500/10 border border-indigo-500/30 shadow-lg shadow-indigo-500/5'
          : 'bg-slate-900/30 border border-slate-800/40 hover:bg-slate-800/40 hover:border-slate-700/50'
      }`}
    >
      {/* Checkbox */}
      <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all shrink-0 ${
        selected
          ? 'bg-indigo-500 border-indigo-500 shadow-md shadow-indigo-500/30'
          : 'border-slate-600 group-hover:border-slate-500'
      }`}>
        {selected && (
          <motion.svg
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="w-3 h-3 text-white"
            viewBox="0 0 12 12"
            fill="none"
          >
            <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </motion.svg>
        )}
      </div>
      <input type="checkbox" checked={selected} onChange={onToggle} className="sr-only" />

      {/* Status dot */}
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        {status === 'online' && (
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${dotClass}`} />
        )}
        <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${dotClass}`} />
      </span>

      {/* Bot info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold text-slate-100 truncate">{bot.name}</span>
          {isExpired && (
            <span className="text-[9px] font-black uppercase tracking-wider bg-rose-500/10 border border-rose-500/20 text-rose-400 px-1.5 py-0.5 rounded-full">
              Expired
            </span>
          )}
        </div>
        <p className="text-[10px] text-slate-500 font-mono truncate">{bot.buyerID} / {bot.botID}</p>
      </div>

      {/* Status label */}
      <span className={`text-[9px] font-black uppercase tracking-widest ${
        status === 'online' ? 'text-emerald-400' :
        status === 'errored' ? 'text-orange-400' :
        'text-slate-500'
      }`}>
        {STATUS_LABEL[status] || 'Unknown'}
      </span>
    </motion.label>
  );
}

// ── Group section with select-all ──────────────────────────────────────────
function GroupSection({ label, color, bots, selected, onToggleBot, onToggleGroup }) {
  const [open, setOpen] = useState(true);
  const allSelected = bots.length > 0 && bots.every((b) => selected.has(b._id));
  const someSelected = bots.some((b) => selected.has(b._id));

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        {/* Group select-all checkbox */}
        <button
          onClick={() => onToggleGroup(bots.map((b) => b._id), !allSelected)}
          className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all shrink-0 ${
            allSelected
              ? 'bg-indigo-500 border-indigo-500 shadow-md shadow-indigo-500/30'
              : someSelected
              ? 'bg-indigo-500/30 border-indigo-500/50'
              : 'border-slate-600 hover:border-slate-500'
          }`}
        >
          {allSelected && (
            <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
              <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {someSelected && !allSelected && (
            <div className="w-2 h-0.5 bg-white rounded-full" />
          )}
        </button>

        <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 flex-1 text-left group">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 10px ${color}44` }} />
          <span className="text-sm font-bold text-slate-400 group-hover:text-slate-100 transition-colors uppercase tracking-wider">
            {label}
          </span>
          <span className="text-xs text-slate-600 font-mono ml-1">[{bots.length}]</span>
          {someSelected && (
            <span className="text-[9px] font-black text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded-full border border-indigo-500/20">
              {bots.filter((b) => selected.has(b._id)).length} selected
            </span>
          )}
          <motion.span animate={{ rotate: open ? 0 : -90 }} className="ml-auto text-slate-600 text-xs">▾</motion.span>
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            key="group-bots"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-1.5 pl-4 border-l-2 ml-2" style={{ borderLeftColor: `${color}33` }}>
              {bots.map((bot) => (
                <BotRow
                  key={bot._id}
                  bot={bot}
                  selected={selected.has(bot._id)}
                  onToggle={() => onToggleBot(bot._id)}
                  groupColor={color}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Results Modal ──────────────────────────────────────────────────────────
function ResultsModal({ results, actionLabel, onClose }) {
  const okCount = results.filter((r) => r.status === 'ok').length;
  const errCount = results.filter((r) => r.status === 'error').length;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="card w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col bg-slate-900 border-slate-700/50"
      >
        <div className="flex items-center justify-between pb-4 border-b border-slate-800/50">
          <div>
            <h2 className="text-lg font-black text-slate-100">Bulk {actionLabel} Results</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              <span className="text-emerald-400 font-bold">{okCount} succeeded</span>
              {errCount > 0 && <span className="text-rose-400 font-bold ml-2">· {errCount} failed</span>}
            </p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-100 hover:bg-slate-800 transition-colors">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto mt-4 space-y-2 pr-1">
          {results.map((r, i) => (
            <motion.div
              key={r.botId}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.03 }}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border text-sm ${
                r.status === 'ok'
                  ? 'bg-emerald-500/5 border-emerald-500/20'
                  : 'bg-rose-500/5 border-rose-500/20'
              }`}
            >
              <span className={`text-lg shrink-0 ${r.status === 'ok' ? '' : ''}`}>
                {r.status === 'ok' ? '✅' : '❌'}
              </span>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-slate-200 truncate">{r.name}</p>
                <p className={`text-[10px] font-mono truncate ${
                  r.status === 'ok' ? 'text-emerald-400/70' : 'text-rose-400/70'
                }`}>{r.message}</p>
              </div>
            </motion.div>
          ))}
        </div>

        <div className="pt-4 border-t border-slate-800/50 mt-4">
          <button onClick={onClose} className="btn-primary w-full py-2.5 font-black uppercase tracking-widest text-[10px]">
            Close
          </button>
        </div>
      </motion.div>
    </div>,
    document.body
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────
export default function MultiManage() {
  const { bots, groups, refresh } = useData();
  const [selected, setSelected] = useState(new Set());
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [busy, setBusy] = useState(null);
  const [results, setResults] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [lastAction, setLastAction] = useState('');

  // ── Filtering ────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    return bots.filter((b) => {
      const matchSearch =
        !search.trim() ||
        b.name.toLowerCase().includes(search.toLowerCase()) ||
        b.botID.toLowerCase().includes(search.toLowerCase()) ||
        b.buyerID.toLowerCase().includes(search.toLowerCase());
      const matchStatus =
        statusFilter === 'all' ||
        (statusFilter === 'online' && b.live?.status === 'online') ||
        (statusFilter === 'stopped' && b.live?.status !== 'online');
      return matchSearch && matchStatus;
    });
  }, [bots, search, statusFilter]);

  // ── Grouped view ─────────────────────────────────────────────────────────
  const groupMap = useMemo(() => Object.fromEntries(groups.map((g) => [g._id, g])), [groups]);

  const botsByGroup = useMemo(() => {
    return groups
      .map((g) => ({ group: g, bots: filtered.filter((b) => b.groupId === g._id) }))
      .filter((s) => s.bots.length > 0);
  }, [groups, filtered]);

  const ungrouped = useMemo(() => {
    return filtered.filter((b) => !b.groupId || !groupMap[b.groupId]);
  }, [filtered, groupMap]);

  // ── Selection helpers ────────────────────────────────────────────────────
  const toggleBot = (botId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(botId)) next.delete(botId);
      else next.add(botId);
      return next;
    });
  };

  const toggleGroup = (botIds, add) => {
    setSelected((prev) => {
      const next = new Set(prev);
      botIds.forEach((id) => {
        if (add) next.add(id);
        else next.delete(id);
      });
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(filtered.map((b) => b._id)));
  };

  const deselectAll = () => {
    setSelected(new Set());
  };

  // Clean up selection when filtered list changes (remove IDs not in filtered set)
  useEffect(() => {
    const filteredIds = new Set(filtered.map((b) => b._id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => filteredIds.has(id)));
      if (next.size !== prev.size) return next;
      return prev;
    });
  }, [filtered]);

  // ── Execute bulk action ──────────────────────────────────────────────────
  const executeBulk = async (action) => {
    if (selected.size === 0) return;
    setBusy(action);
    setLastAction(ACTIONS.find((a) => a.key === action)?.label || action);
    try {
      const { data } = await api.post(`/bulk/${action}`, { botIds: [...selected] });
      setResults(data.results);
      // Deselect successfully processed bots for remove action
      if (action === 'remove') {
        const removedIds = new Set(data.results.filter((r) => r.status === 'ok').map((r) => r.botId));
        setSelected((prev) => new Set([...prev].filter((id) => !removedIds.has(id))));
      }
      refresh();
    } catch (err) {
      setResults([{ botId: '-', name: 'System Error', status: 'error', message: err.response?.data?.error || err.message }]);
    } finally {
      setBusy(null);
    }
  };

  const handleAction = (action) => {
    if (action === 'remove') {
      setConfirm({ action: 'remove' });
    } else {
      executeBulk(action);
    }
  };

  const selectedCount = selected.size;
  const allFilteredSelected = filtered.length > 0 && filtered.every((b) => selected.has(b._id));

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="p-5 lg:p-7 max-w-5xl mx-auto space-y-6 pb-40 lg:pb-8"
    >
      {/* ── Header ── */}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl lg:text-3xl font-black text-slate-100 tracking-tight">Multi Manage</h1>
          <p className="text-xs text-slate-500 mt-1 font-medium">
            Bulk operations on <span className="text-violet-400 font-bold">{bots.length}</span> instances
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <button onClick={allFilteredSelected ? deselectAll : selectAll} className="btn-ghost text-xs">
            {allFilteredSelected ? 'Deselect All' : 'Select All'}
          </button>
          {selectedCount > 0 && (
            <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }}
              className="text-[10px] font-black px-3 py-1.5 rounded-full"
              style={{ background: "rgba(124,58,237,0.12)", border: "1px solid rgba(124,58,237,0.25)", color: "#a78bfa" }}>
              {selectedCount} selected
            </motion.span>
          )}
        </div>
      </motion.div>

      {/* ── Filters ── */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        className="flex flex-col lg:flex-row lg:items-center gap-3 rounded-2xl p-3 lg:p-4"
        style={{ background: "rgba(13,21,37,0.7)", border: "1px solid rgba(255,255,255,0.05)", backdropFilter: "blur(12px)" }}>
        <div className="relative w-full lg:max-w-xs">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </div>
          <input className="input pl-9" placeholder="Search bots…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1 p-1 rounded-xl" style={{ background: "rgba(6,11,20,0.6)", border: "1px solid rgba(255,255,255,0.05)" }}>
          {['all', 'online', 'stopped'].map((f) => (
            <button key={f}
              className="relative px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-[0.08em] transition-all duration-200"
              style={{ color: statusFilter === f ? '#fff' : '#64748b' }}
              onClick={() => setStatusFilter(f)}>
              {statusFilter === f && (
                <motion.div layoutId="multiManageFilter" className="absolute inset-0 rounded-lg"
                  style={{ background: "linear-gradient(135deg,#7C3AED,#4F46E5)", boxShadow: "0 4px 12px rgba(124,58,237,0.3)" }}
                  transition={{ type: 'spring', bounce: 0.25, duration: 0.5 }} />
              )}
              <span className="relative z-10">{f}</span>
            </button>
          ))}
        </div>
        <span className="text-[10px] font-mono text-slate-600 ml-auto hidden lg:inline">
          {filtered.length} / {bots.length} bots
        </span>
      </motion.div>

      {/* ── Bot List ────────────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="card text-center py-20 border-dashed border-slate-700 bg-transparent"
        >
          <div className="text-5xl mb-4 grayscale opacity-50">⚡</div>
          <p className="text-slate-400 font-medium">
            {bots.length === 0 ? 'No bots found. Create some bots first.' : 'No bots match your filters.'}
          </p>
        </motion.div>
      ) : (
        <div className="space-y-6">
          {botsByGroup.map(({ group, bots: gb }) => (
            <GroupSection
              key={group._id}
              label={group.name}
              color={group.color}
              bots={gb}
              selected={selected}
              onToggleBot={toggleBot}
              onToggleGroup={toggleGroup}
            />
          ))}
          {ungrouped.length > 0 && (
            <GroupSection
              label="Ungrouped"
              color="#64748b"
              bots={ungrouped}
              selected={selected}
              onToggleBot={toggleBot}
              onToggleGroup={toggleGroup}
            />
          )}
        </div>
      )}

      {/* ── Sticky Action Bar ── */}
      <AnimatePresence>
        {selectedCount > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 40, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 40, scale: 0.95 }}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.5 }}
            className="fixed bottom-24 lg:bottom-6 left-1/2 -translate-x-1/2 z-40 w-[calc(100%-2rem)] max-w-3xl"
          >
            <div className="rounded-2xl p-3" style={{ background: "rgba(10,15,28,0.96)", backdropFilter: "blur(24px)", border: "1px solid rgba(124,58,237,0.2)", boxShadow: "0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(124,58,237,0.08)" }}>
              <div className="flex items-center gap-2 mb-3 px-1">
                <span className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-400">
                  ⚡ Actions for {selectedCount} bot{selectedCount !== 1 ? 's' : ''}
                </span>
                <div className="flex-1" />
                <button onClick={deselectAll} className="text-[9px] font-bold text-slate-600 hover:text-slate-300 transition-colors uppercase tracking-wider">Clear</button>
              </div>
              <div className="flex flex-wrap gap-2">
                {ACTIONS.map(({ key, label, style }) => (
                  <button key={key}
                    className={`${style} flex-1 min-w-[90px] py-2.5 font-black uppercase tracking-widest text-[9px]`}
                    disabled={!!busy} onClick={() => handleAction(key)}>
                    {busy === key ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        Processing…
                      </span>
                    ) : label}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Results modal ───────────────────────────────────────────────── */}
      {results && (
        <ResultsModal
          results={results}
          actionLabel={lastAction}
          onClose={() => setResults(null)}
        />
      )}

      {/* ── Confirm remove modal ────────────────────────────────────────── */}
      {confirm?.action === 'remove' && (
        <ConfirmModal
          title={`Remove ${selectedCount} bot${selectedCount !== 1 ? 's' : ''}?`}
          message={`This will permanently stop and delete ${selectedCount} bot${selectedCount !== 1 ? 's' : ''}. Local-sourced bots will keep their files. This cannot be undone.`}
          confirmText="Remove All"
          onConfirm={() => {
            setConfirm(null);
            executeBulk('remove');
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </motion.div>
  );
}
