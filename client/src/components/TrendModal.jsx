import { createPortal } from "react-dom";

export default function TrendModal({ title, color, data, valueKey, onClose }) {
    const values = data.map((s) => valueKey === "cpu" ? s.cpu.usagePercent : s.memory.usedPercent);
    const timestamps = data.map((s) => s._ts);

    if (values.length < 2) {
        return (
            <Overlay onClose={onClose}>
                <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontStyle: "italic" }}>
                    Not enough data points yet. Please wait a few moments.
                </div>
            </Overlay>
        );
    }

    const W = 560, H = 200, PAD = 36, PAD_BOTTOM = 52;
    const max = Math.max(...values, 10);
    const pts = values.map((v, i) => {
        const x = PAD + (i / (values.length - 1)) * (W - PAD * 2);
        const y = PAD + (1 - v / max) * (H - PAD * 2);
        return { x, y, v };
    });
    const polyline = pts.map((p) => `${p.x},${p.y}`).join(" ");

    const minIdx = values.indexOf(Math.min(...values));
    const maxIdx = values.indexOf(Math.max(...values));
    const labelSet = new Set([0, values.length - 1, minIdx, maxIdx]);

    return (
        <Overlay onClose={onClose}>
            <div style={{ padding: 24, paddingBottom: 0 }}>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 16 }}>{title}</h3>
                
                <div style={{ background: "var(--bg-base)", borderRadius: 12, border: "1px solid var(--border)", padding: 12, marginBottom: 20 }}>
                    <svg viewBox={`0 0 ${W} ${H + 16}`} style={{ width: "100%", height: "auto", display: "block" }}>
                        {[0, 25, 50, 75, 100].map((pct) => {
                            const y = PAD + (1 - pct / max) * (H - PAD * 2);
                            if (y < PAD || y > H - PAD) return null;
                            return (
                                <g key={pct}>
                                    <line x1={PAD} y1={y} x2={W - PAD} y2={y} stroke="var(--border-light)" strokeWidth="1" strokeDasharray="4 4" />
                                    <text x={PAD - 8} y={y + 4} textAnchor="end" fontSize="10" fill="var(--text-dim)" fontWeight="500">{pct}%</text>
                                </g>
                            );
                        })}
                        
                        <polyline points={polyline} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" />
                        
                        {(() => {
                            const count = Math.min(5, data.length);
                            const step = Math.floor((data.length - 1) / (count - 1)) || 1;
                            const indices = Array.from({ length: count }, (_, i) => Math.min(i * step, data.length - 1));
                            return indices.map((idx) => {
                                const s = data[idx];
                                const x = PAD + (idx / (data.length - 1)) * (W - PAD * 2);
                                const label = s._ts ? new Date(s._ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
                                return (
                                    <g key={idx}>
                                        <line x1={x} y1={H - PAD_BOTTOM + 8} x2={x} y2={H - PAD_BOTTOM + 14} stroke="var(--border-light)" strokeWidth="2" />
                                        <text x={x} y={H - PAD_BOTTOM + 28} textAnchor={idx === 0 ? "start" : idx === data.length - 1 ? "end" : "middle"} fontSize="11" fill="var(--text-dim)" fontWeight="500">{label}</text>
                                    </g>
                                );
                            });
                        })()}
                        
                        {pts.map((p, i) => (
                            <g key={i}>
                                <circle cx={p.x} cy={p.y} r={labelSet.has(i) ? 4 : 2} fill={labelSet.has(i) ? color : "var(--bg-input)"} stroke={color} strokeWidth="2" />
                                {labelSet.has(i) && (
                                    <text x={p.x} y={p.y - 10} textAnchor="middle" fontSize="11" fontWeight="700" fill={color}>{p.v}%</text>
                                )}
                            </g>
                        ))}
                    </svg>
                </div>

                <div className="no-scrollbar" style={{ maxHeight: 250, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead style={{ position: "sticky", top: 0, background: "var(--bg-input)", zIndex: 1 }}>
                            <tr>
                                <th style={{ textAlign: "left", padding: "10px 16px", color: "var(--text-muted)", fontWeight: 600, borderBottom: "1px solid var(--border)" }}>#</th>
                                <th style={{ textAlign: "left", padding: "10px 16px", color: "var(--text-muted)", fontWeight: 600, borderBottom: "1px solid var(--border)" }}>Time</th>
                                <th style={{ textAlign: "right", padding: "10px 16px", color: "var(--text-muted)", fontWeight: 600, borderBottom: "1px solid var(--border)" }}>Usage</th>
                            </tr>
                        </thead>
                        <tbody>
                            {[...data].reverse().map((s, i) => {
                                const val = valueKey === "cpu" ? s.cpu.usagePercent : s.memory.usedPercent;
                                const rowColor = val > 80 ? "var(--danger)" : val > 50 ? "var(--warning)" : color;
                                return (
                                    <tr key={i} style={{ borderBottom: "1px solid var(--border-light)" }} onMouseOver={e => e.currentTarget.style.background = "var(--bg-input)"} onMouseOut={e => e.currentTarget.style.background = "transparent"}>
                                        <td style={{ padding: "8px 16px", color: "var(--text-dim)" }}>{data.length - i}</td>
                                        <td className="mono" style={{ padding: "8px 16px", color: "var(--text)" }}>{s._ts ? new Date(s._ts).toLocaleTimeString() : "—"}</td>
                                        <td style={{ padding: "8px 16px", textAlign: "right", fontWeight: 700, color: rowColor }}>{val}%</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                
                <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", paddingBottom: 24 }}>
                    <button className="btn-ghost" style={{ padding: "8px 24px" }} onClick={onClose}>Close</button>
                </div>
            </div>
        </Overlay>
    );
}

function Overlay({ children, onClose }) {
    return createPortal(
        <div className="modal-overlay" onClick={(e) => { e.stopPropagation(); onClose(); }}>
            <div className="card slide-up modal-card-mobile" style={{ width: "100%", maxWidth: 640, padding: 0 }} onClick={(e) => e.stopPropagation()}>
                {children}
            </div>
        </div>,
        document.body
    );
}
