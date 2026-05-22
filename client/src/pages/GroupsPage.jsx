import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import api from '../api/client';
import { motion, AnimatePresence } from 'framer-motion';

const PRESET_COLORS = [
  '#7C3AED','#4F46E5','#2563EB','#0891B2','#059669',
  '#D97706','#DC2626','#DB2777','#9333EA','#64748B',
];

function GroupCard({ group, bots, onEdit, onDelete }) {
  const [open, setOpen] = useState(false);
  const onlineCount = bots.filter((b) => b.live?.status === 'online').length;
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="card"
      style={{ background: "linear-gradient(135deg, rgba(17,24,39,0.95) 0%, rgba(13,21,37,0.95) 100%)" }}
    >
      <div className="flex items-center gap-3">
        {/* Color dot */}
        <div className="w-3 h-3 rounded-full shrink-0" style={{ background: group.color || '#64748b', boxShadow: `0 0 10px ${group.color}55` }} />
        {/* Name + stats */}
        <div className="flex-1 min-w-0">
          <span className="font-bold text-sm text-slate-100 truncate">{group.name}</span>
        </div>
        {/* Online badge */}
        <span className="text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-full"
          style={{ background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.2)", color: "#34d399" }}>
          {onlineCount} online
        </span>
        <span className="text-[9px] font-mono text-slate-500">{bots.length} bot{bots.length !== 1 ? 's' : ''}</span>
        {/* Actions */}
        <button onClick={() => onEdit(group)} className="btn-ghost text-[10px] px-2.5 py-1">Edit</button>
        <button onClick={() => onDelete(group)}
          className="text-[10px] px-2.5 py-1 rounded-lg font-bold transition-all"
          style={{ background: "rgba(220,38,38,0.08)", color: "#f87171", border: "1px solid rgba(239,68,68,0.15)" }}>
          Delete
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          className="w-6 h-6 rounded-lg flex items-center justify-center text-slate-500 hover:text-slate-300 transition-colors"
          style={{ background: "rgba(255,255,255,0.04)" }}
        >
          <motion.svg animate={{ rotate: open ? 180 : 0 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <polyline points="6 9 12 15 18 9"/>
          </motion.svg>
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-4 pt-4" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
              {bots.length === 0 ? (
                <p className="text-xs text-slate-600 pl-2">No bots in this group.</p>
              ) : (
                <ul className="space-y-2">
                  {bots.map((b) => (
                    <li key={b._id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg"
                      style={{ background: "rgba(6,11,20,0.5)" }}>
                      <span className={`w-2 h-2 rounded-full shrink-0 ${b.live?.status === 'online' ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                      <span className="text-sm text-slate-300 font-medium truncate">{b.name}</span>
                      <span className="text-[10px] text-slate-600 font-mono ml-auto shrink-0">{b.buyerID}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default function GroupsPage() {
  const [groups, setGroups]   = useState([]);
  const [bots, setBots]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [name, setName]       = useState('');
  const [color, setColor]     = useState(PRESET_COLORS[0]);
  const [saving, setSaving]   = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const fetchAll = useCallback(async () => {
    try {
      const [gr, br] = await Promise.all([api.get('/groups'), api.get('/bots')]);
      setGroups(gr.data); setBots(br.data);
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const openNew  = () => { setName(''); setColor(PRESET_COLORS[0]); setEditing('new'); };
  const openEdit = (g) => { setName(g.name); setColor(g.color || PRESET_COLORS[0]); setEditing(g); };

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (editing === 'new') await api.post('/groups', { name: name.trim(), color });
      else await api.put(`/groups/${editing._id}`, { name: name.trim(), color });
      setEditing(null); fetchAll();
    } catch {} finally { setSaving(false); }
  };

  const deleteGroup = async (g) => {
    try { await api.delete(`/groups/${g._id}`); fetchAll(); } catch {}
    setDeleteTarget(null);
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center pt-32 gap-4">
        <div className="relative w-12 h-12">
          <div className="absolute inset-0 rounded-full" style={{ border: "3px solid rgba(124,58,237,0.15)" }} />
          <div className="absolute inset-0 rounded-full animate-spin" style={{ border: "3px solid transparent", borderTopColor: "#7C3AED" }} />
        </div>
      </div>
    );
  }

  return (
    <div className="p-5 lg:p-7 max-w-3xl mx-auto space-y-6">

      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl lg:text-3xl font-black text-slate-100 tracking-tight">Groups</h1>
          <p className="text-xs text-slate-500 mt-1 font-medium">Organise your bots into labelled collections</p>
        </div>
        <button id="btn-new-group" className="btn-primary text-xs" onClick={openNew}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          New Group
        </button>
      </motion.div>

      {/* Edit/Create form */}
      <AnimatePresence>
        {editing && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            className="card space-y-5"
            style={{ background: "linear-gradient(135deg, rgba(17,24,39,0.95), rgba(13,21,37,0.95))", border: "1px solid rgba(124,58,237,0.15)" }}>
            <h2 className="text-[10px] font-black uppercase tracking-[0.12em] text-violet-400">
              {editing === 'new' ? '✦ Create Group' : `✦ Edit — ${editing.name}`}
            </h2>
            <div>
              <label className="label">Group Name</label>
              <input id="group-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Premium Bots" />
            </div>
            <div>
              <label className="label">Colour</label>
              <div className="flex items-center gap-2 flex-wrap mt-2">
                {PRESET_COLORS.map((c) => (
                  <button key={c} onClick={() => setColor(c)}
                    className="w-7 h-7 rounded-full transition-all duration-150 relative"
                    style={{ background: c, boxShadow: color === c ? `0 0 0 2px rgba(255,255,255,0.9), 0 0 12px ${c}88` : 'none',
                      transform: color === c ? 'scale(1.2)' : 'scale(1)' }} />
                ))}
                <input type="color" className="w-8 h-8 rounded-lg cursor-pointer border-0 bg-transparent"
                  value={color} onChange={(e) => setColor(e.target.value)} title="Custom colour" />
              </div>
            </div>
            <div>
              <label className="label">Preview</label>
              <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border font-bold"
                style={{ background: `${color}14`, borderColor: `${color}33`, color }}>
                <span className="w-2 h-2 rounded-full" style={{ background: color }} />
                {name || 'Group Name'}
              </span>
            </div>
            <div className="flex gap-2 pt-1">
              <button className="btn-primary" onClick={save} disabled={saving || !name.trim()}>
                {saving ? '⏳ Saving…' : '💾 Save Group'}
              </button>
              <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Group list */}
      {groups.length === 0 ? (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          className="flex flex-col items-center justify-center py-24 rounded-2xl"
          style={{ border: "1px dashed rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.01)" }}>
          <div className="text-5xl mb-4 opacity-30">🗂️</div>
          <p className="text-slate-500 font-medium text-sm">No groups yet — create one to start organising.</p>
          <button className="btn-primary mt-5 text-xs" onClick={openNew}>Create Group</button>
        </motion.div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <GroupCard key={g._id} group={g} bots={bots.filter((b) => b.groupId === g._id)}
              onEdit={openEdit} onDelete={setDeleteTarget} />
          ))}
        </div>
      )}

      {/* Delete confirm */}
      {deleteTarget && createPortal(
        <AnimatePresence>
          <motion.div key="backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9999] flex items-center justify-center px-4"
            style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)" }}
            onClick={() => setDeleteTarget(null)}>
            <motion.div key="dialog" initial={{ opacity: 0, scale: 0.9, y: 16 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9 }}
              className="w-full max-w-sm rounded-2xl p-6 space-y-4"
              style={{ background: "rgba(17,24,39,0.98)", border: "1px solid rgba(239,68,68,0.2)", boxShadow: "0 30px 80px rgba(0,0,0,0.6)" }}
              onClick={(e) => e.stopPropagation()}>
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "rgba(220,38,38,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
                <span className="text-lg">⚠️</span>
              </div>
              <div>
                <h2 className="text-lg font-black text-slate-100">Delete "{deleteTarget.name}"?</h2>
                <p className="text-sm text-slate-400 mt-2">Bots in this group will become ungrouped. This cannot be undone.</p>
              </div>
              <div className="flex gap-2">
                <button className="btn-danger flex-1 py-2.5" onClick={() => deleteGroup(deleteTarget)}>Delete</button>
                <button className="btn-ghost flex-1 py-2.5" onClick={() => setDeleteTarget(null)}>Cancel</button>
              </div>
            </motion.div>
          </motion.div>
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
}
