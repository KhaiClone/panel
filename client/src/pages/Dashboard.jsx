import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import StatsWidget from '../components/StatsWidget';
import BotCard from '../components/BotCard';
import CreateBotModal from '../components/CreateBotModal';

export default function Dashboard() {
  const [bots, setBots]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch]     = useState('');
  const [filter, setFilter]     = useState('all'); // 'all' | 'online' | 'stopped'

  // ── Fetch all bots ─────────────────────────────────────────────────────────
  const fetchBots = useCallback(async () => {
    try {
      const { data } = await api.get('/bots');
      setBots(data);
    } catch {
      // handled by axios interceptor (401 → redirect)
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBots();
    // Auto-refresh bot list every 10s
    const interval = setInterval(fetchBots, 10_000);
    return () => clearInterval(interval);
  }, [fetchBots]);

  // ── Derived counts ─────────────────────────────────────────────────────────
  const online  = bots.filter((b) => b.live?.status === 'online').length;
  const errored = bots.filter((b) => b.live?.status === 'errored').length;
  const expiringSoon = bots.filter((b) => {
    if (!b.expiresAt) return false;
    const d = (b.expiresAt - Date.now()) / 86_400_000;
    return d >= 0 && d <= 3;
  }).length;

  // ── Filtered + searched list ───────────────────────────────────────────────
  const visible = bots.filter((b) => {
    const matchSearch =
      b.name.toLowerCase().includes(search.toLowerCase()) ||
      b.botID.toLowerCase().includes(search.toLowerCase()) ||
      b.buyerID.toLowerCase().includes(search.toLowerCase());
    const matchFilter =
      filter === 'all' ||
      (filter === 'online' && b.live?.status === 'online') ||
      (filter === 'stopped' && b.live?.status !== 'online');
    return matchSearch && matchFilter;
  });

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Dashboard</h1>
          <p className="text-sm text-slate-500 mt-0.5">Manage all your hosted bots</p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          ➕ New Bot
        </button>
      </div>

      {/* ── Summary cards ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Total Bots',     value: bots.length,   color: 'text-indigo-400'  },
          { label: 'Online',         value: online,         color: 'text-emerald-400' },
          { label: 'Errored',        value: errored,        color: 'text-orange-400'  },
          { label: 'Expiring Soon',  value: expiringSoon,   color: 'text-amber-400'   },
        ].map(({ label, value, color }) => (
          <div key={label} className="card">
            <p className="text-xs text-slate-500 uppercase tracking-wider">{label}</p>
            <p className={`text-3xl font-bold mt-1 ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* ── System stats ────────────────────────────────────────────────────── */}
      <StatsWidget />

      {/* ── Bot list ────────────────────────────────────────────────────────── */}
      <div>
        {/* Toolbar: search + filter */}
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <input
            className="input max-w-xs"
            placeholder="🔍 Search bots…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex gap-2">
            {['all', 'online', 'stopped'].map((f) => (
              <button
                key={f}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  filter === f
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-700 text-slate-400 hover:text-slate-200'
                }`}
                onClick={() => setFilter(f)}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <span className="text-xs text-slate-500 ml-auto">
            {visible.length} / {bots.length} bots
          </span>
        </div>

        {/* Grid */}
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <div className="animate-spin h-8 w-8 border-4 border-indigo-500 border-t-transparent rounded-full" />
          </div>
        ) : visible.length === 0 ? (
          <div className="card text-center py-16 text-slate-500">
            <div className="text-4xl mb-3">🤖</div>
            <p className="font-medium">
              {bots.length === 0 ? 'No bots yet — click "New Bot" to get started.' : 'No bots match your search.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {visible.map((bot) => (
              <BotCard key={bot._id} bot={bot} onRefresh={fetchBots} />
            ))}
          </div>
        )}
      </div>

      {/* ── Create bot modal ─────────────────────────────────────────────────── */}
      {showCreate && (
        <CreateBotModal
          onClose={() => setShowCreate(false)}
          onCreated={() => fetchBots()}
        />
      )}
    </div>
  );
}
