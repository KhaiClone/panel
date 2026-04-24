import { useState, useEffect } from 'react';
import api from '../api/client';

// ── Reusable ring ──────────────────────────────────────────────────────────
function Ring({ percent, color, label, sub }) {
  const r = 52;
  const circ = 2 * Math.PI * r;
  const offset = circ - (Math.min(percent, 100) / 100) * circ;
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative w-36 h-36">
        <svg className="w-full h-full -rotate-90 overflow-visible" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r={r} fill="none" stroke="#1e293b" strokeWidth="12" />
          <circle
            cx="60" cy="60" r={r} fill="none"
            stroke={color} strokeWidth="12" strokeLinecap="round"
            strokeDasharray={circ} strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.7s cubic-bezier(0.4,0,0.2,1)', filter: `drop-shadow(0 0 8px ${color}99)` }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold text-slate-100">{percent}%</span>
        </div>
      </div>
      <div className="text-center">
        <p className="text-base font-semibold text-slate-200">{label}</p>
        {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ── Stat row ───────────────────────────────────────────────────────────────
function StatRow({ label, value, accent }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-700/60 last:border-0">
      <span className="text-sm text-slate-400">{label}</span>
      <span className={`text-sm font-semibold ${accent ?? 'text-slate-200'}`}>{value}</span>
    </div>
  );
}

const fmt = (bytes) => {
  if (!bytes && bytes !== 0) return '—';
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  return `${bytes} B`;
};

export default function SystemPage() {
  const [stats, setStats] = useState(null);
  const [history, setHistory] = useState([]);

  const fetchStats = () => {
    api.get('/system/stats').then((r) => {
      setStats(r.data);
      setHistory((h) => [...h.slice(-29), r.data]);
    }).catch(() => {});
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 4_000);
    return () => clearInterval(interval);
  }, []);

  if (!stats) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-indigo-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  const cpuColor = stats.cpu.usagePercent > 80 ? '#f87171' : stats.cpu.usagePercent > 50 ? '#fb923c' : '#34d399';
  const ramColor = stats.memory.usedPercent > 80 ? '#f87171' : stats.memory.usedPercent > 50 ? '#fb923c' : '#818cf8';
  const diskColor = stats.disk
    ? stats.disk.usedPercent > 85 ? '#f87171' : stats.disk.usedPercent > 65 ? '#fb923c' : '#38bdf8'
    : '#64748b';

  // Mini sparkline (last 30 samples)
  const sparklinePath = (key) => {
    if (history.length < 2) return '';
    const vals = history.map((s) => key === 'cpu' ? s.cpu.usagePercent : s.memory.usedPercent);
    const max = 100;
    const W = 200, H = 40;
    const pts = vals.map((v, i) => {
      const x = (i / (vals.length - 1)) * W;
      const y = H - (v / max) * H;
      return `${x},${y}`;
    });
    return `M${pts.join('L')}`;
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-100">System Monitor</h1>
        <p className="text-sm text-slate-500 mt-0.5">Live server resource usage — refreshes every 4 s</p>
      </div>

      {/* Big rings */}
      <div className="card">
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-6">
          Resource Overview
        </h2>
        <div className="flex flex-wrap items-center justify-around gap-10 py-4">
          <Ring percent={stats.cpu.usagePercent} color={cpuColor} label="CPU Load"
            sub={stats.cpu.temperature ? `${stats.cpu.temperature}°C` : 'No temp sensor'} />
          <Ring percent={stats.memory.usedPercent} color={ramColor} label="RAM"
            sub={`${fmt(stats.memory.usedBytes)} / ${fmt(stats.memory.totalBytes)}`} />
          {stats.disk ? (
            <Ring percent={stats.disk.usedPercent} color={diskColor} label={`Disk (${stats.disk.mount})`}
              sub={`${fmt(stats.disk.usedBytes)} / ${fmt(stats.disk.totalBytes)}`} />
          ) : (
            <div className="flex flex-col items-center gap-3 opacity-40">
              <div className="w-36 h-36 rounded-full border-[12px] border-slate-700 flex items-center justify-center">
                <span className="text-slate-500 text-sm">N/A</span>
              </div>
              <p className="text-base font-semibold text-slate-500">Disk</p>
            </div>
          )}
        </div>
      </div>

      {/* Detail cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* CPU details */}
        <div className="card">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">CPU Details</h3>
          <StatRow label="Usage" value={`${stats.cpu.usagePercent}%`} accent={cpuColor !== '#34d399' ? 'text-amber-400' : 'text-emerald-400'} />
          <StatRow label="Temperature" value={stats.cpu.temperature ? `${stats.cpu.temperature}°C` : 'Unavailable'} />
          {/* Mini sparkline */}
          {history.length > 1 && (
            <div className="mt-3 rounded bg-slate-900/60 p-2">
              <svg viewBox="0 0 200 40" className="w-full h-8">
                <path d={sparklinePath('cpu')} fill="none" stroke={cpuColor} strokeWidth="2" strokeLinecap="round" />
              </svg>
              <p className="text-xs text-slate-600 text-center mt-1">CPU trend (last {history.length} samples)</p>
            </div>
          )}
        </div>

        {/* RAM details */}
        <div className="card">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Memory Details</h3>
          <StatRow label="Used" value={fmt(stats.memory.usedBytes)} />
          <StatRow label="Free" value={fmt(stats.memory.freeBytes)} />
          <StatRow label="Total" value={fmt(stats.memory.totalBytes)} />
          {history.length > 1 && (
            <div className="mt-3 rounded bg-slate-900/60 p-2">
              <svg viewBox="0 0 200 40" className="w-full h-8">
                <path d={sparklinePath('mem')} fill="none" stroke={ramColor} strokeWidth="2" strokeLinecap="round" />
              </svg>
              <p className="text-xs text-slate-600 text-center mt-1">RAM trend (last {history.length} samples)</p>
            </div>
          )}
        </div>

        {/* Disk details */}
        <div className="card">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Disk Details</h3>
          {stats.disk ? (
            <>
              <StatRow label="Mount" value={stats.disk.mount} />
              <StatRow label="Filesystem" value={stats.disk.fs} />
              <StatRow label="Used" value={fmt(stats.disk.usedBytes)} />
              <StatRow label="Free" value={fmt(stats.disk.freeBytes)} />
              <StatRow label="Total" value={fmt(stats.disk.totalBytes)} />
            </>
          ) : (
            <p className="text-sm text-slate-500 text-center py-4">Disk info unavailable</p>
          )}
        </div>
      </div>
    </div>
  );
}
