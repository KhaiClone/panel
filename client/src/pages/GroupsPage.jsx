import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';

const PRESET_COLORS = [
  '#6366f1','#8b5cf6','#ec4899','#f43f5e','#f97316',
  '#eab308','#22c55e','#14b8a6','#06b6d4','#3b82f6',
];

function GroupCard({ group, bots, onEdit, onDelete }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-3">
        <span className="w-4 h-4 rounded-full shrink-0" style={{ background: group.color || '#64748b' }} />
        <span className="flex-1 font-semibold text-slate-100">{group.name}</span>
        <span className="text-xs text-slate-500">{bots.length} bot{bots.length !== 1 ? 's' : ''}</span>
        <button
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '▲' : '▼'}
        </button>
        <button className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors" onClick={() => onEdit(group)}>Edit</button>
        <button className="text-xs text-red-400 hover:text-red-300 transition-colors" onClick={() => onDelete(group)}>Delete</button>
      </div>
      {open && bots.length > 0 && (
        <ul className="pl-7 space-y-1">
          {bots.map((b) => (
            <li key={b._id} className="text-sm text-slate-400 flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${b.live?.status === 'online' ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              {b.name}
              <span className="text-xs text-slate-600">{b.buyerID}</span>
            </li>
          ))}
        </ul>
      )}
      {open && bots.length === 0 && (
        <p className="pl-7 text-sm text-slate-600">No bots in this group.</p>
      )}
    </div>
  );
}

export default function GroupsPage() {
  const [groups, setGroups] = useState([]);
  const [bots, setBots]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | group object | 'new'
  const [name, setName]     = useState('');
  const [color, setColor]   = useState(PRESET_COLORS[0]);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const fetchAll = useCallback(async () => {
    try {
      const [gr, br] = await Promise.all([api.get('/groups'), api.get('/bots')]);
      setGroups(gr.data);
      setBots(br.data);
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const openNew = () => { setName(''); setColor(PRESET_COLORS[0]); setEditing('new'); };
  const openEdit = (g) => { setName(g.name); setColor(g.color || PRESET_COLORS[0]); setEditing(g); };

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (editing === 'new') {
        await api.post('/groups', { name: name.trim(), color });
      } else {
        await api.put(`/groups/${editing._id}`, { name: name.trim(), color });
      }
      setEditing(null);
      fetchAll();
    } catch {}
    finally { setSaving(false); }
  };

  const deleteGroup = async (g) => {
    try { await api.delete(`/groups/${g._id}`); fetchAll(); }
    catch {}
    setDeleteTarget(null);
  };

  if (loading) {
    return (
      <div className="flex h-full justify-center pt-32">
        <div className="animate-spin h-8 w-8 border-4 border-indigo-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Groups</h1>
          <p className="text-sm text-slate-500 mt-0.5">Organise your bots into labelled groups</p>
        </div>
        <button className="btn-primary" onClick={openNew}>➕ New Group</button>
      </div>

      {/* Edit / create form */}
      {editing && (
        <div className="card space-y-4">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
            {editing === 'new' ? 'Create Group' : `Edit — ${editing.name}`}
          </h2>
          <div>
            <label className="label">Group Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Premium Bots" />
          </div>
          <div>
            <label className="label">Color</label>
            <div className="flex items-center gap-2 flex-wrap mt-1">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  className={`w-7 h-7 rounded-full border-2 transition-transform ${color === c ? 'scale-125 border-white' : 'border-transparent'}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
              <input
                type="color"
                className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                title="Custom colour"
              />
            </div>
          </div>
          {/* Preview */}
          <div>
            <label className="label">Preview</label>
            <span
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border font-medium"
              style={{ background: `${color}22`, borderColor: `${color}66`, color }}
            >
              <span className="w-2 h-2 rounded-full" style={{ background: color }} />
              {name || 'Group Name'}
            </span>
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" onClick={save} disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : '💾 Save'}
            </button>
            <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Group list */}
      {groups.length === 0 ? (
        <div className="card text-center py-12 text-slate-500">
          <div className="text-4xl mb-3">🗂️</div>
          <p className="font-medium">No groups yet — create one to start organising your bots.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <GroupCard
              key={g._id}
              group={g}
              bots={bots.filter((b) => b.groupId === g._id)}
              onEdit={openEdit}
              onDelete={setDeleteTarget}
            />
          ))}
        </div>
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4">
          <div className="card w-full max-w-sm space-y-4">
            <h2 className="text-lg font-bold text-slate-100">Delete "{deleteTarget.name}"?</h2>
            <p className="text-sm text-slate-400">Bots in this group will become ungrouped. This cannot be undone.</p>
            <div className="flex gap-2">
              <button className="btn-danger flex-1" onClick={() => deleteGroup(deleteTarget)}>Delete</button>
              <button className="btn-ghost flex-1" onClick={() => setDeleteTarget(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
