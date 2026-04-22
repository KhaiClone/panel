import { useState, useEffect, useRef } from 'react';
import api from '../api/client';

export default function LogViewer({ botId }) {
  const [lines, setLines]     = useState([]);
  const [live, setLive]       = useState(false);
  const [loading, setLoading] = useState(true);
  const bottomRef             = useRef(null);
  const esRef                 = useRef(null);   // EventSource ref

  // ── Snapshot load ──────────────────────────────────────────────────────────
  const fetchSnapshot = async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/logs/${botId}?lines=200`);
      const parsed = data.logs.split('\n').filter(Boolean);
      setLines(parsed);
    } catch {
      setLines(['[Error] Failed to fetch logs.']);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSnapshot();
    return () => stopLive(); // cleanup on unmount
  }, [botId]);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  // ── Live streaming ─────────────────────────────────────────────────────────
  const startLive = () => {
    if (esRef.current) return;

    const token = localStorage.getItem('token');
    const es = new EventSource(`/api/logs/${botId}/stream?token=${token}`);

    es.onmessage = (e) => {
      setLines((prev) => {
        const next = [...prev, e.data];
        // Cap at 500 lines in memory
        return next.length > 500 ? next.slice(-500) : next;
      });
    };

    es.onerror = () => {
      setLines((prev) => [...prev, '[Stream] Connection lost.']);
      stopLive();
    };

    esRef.current = es;
    setLive(true);
  };

  const stopLive = () => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setLive(false);
  };

  const toggleLive = () => (live ? stopLive() : startLive());

  // ── Color coding ──────────────────────────────────────────────────────────
  const colorLine = (line) => {
    if (/error|err|fail|fatal/i.test(line)) return 'text-red-400';
    if (/warn/i.test(line))                 return 'text-amber-400';
    if (/info|ready|online/i.test(line))    return 'text-emerald-400';
    if (/debug/i.test(line))               return 'text-slate-500';
    return 'text-slate-300';
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold text-slate-200">📋 Logs</span>
        <div className="flex items-center gap-2 ml-auto">
          <button className="btn-ghost text-xs py-1.5" onClick={fetchSnapshot} disabled={loading || live}>
            🔄 Refresh
          </button>
          <button
            className={`text-xs py-1.5 px-3 rounded-lg font-medium transition-colors ${
              live
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white'
            }`}
            onClick={toggleLive}
          >
            {live ? '⏹ Stop Live' : '▶ Live Stream'}
          </button>
        </div>
        {live && (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            LIVE
          </span>
        )}
      </div>

      {/* Log output */}
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-4 h-96 overflow-y-auto font-mono text-xs leading-relaxed">
        {loading && !lines.length ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin h-6 w-6 border-4 border-indigo-500 border-t-transparent rounded-full" />
          </div>
        ) : lines.length === 0 ? (
          <p className="text-slate-500 italic">No logs available.</p>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={`${colorLine(line)} whitespace-pre-wrap break-all`}>
              {line}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
