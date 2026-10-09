import { useState } from "react";
import api from "../../api/client";
import ConfirmModal from "../../components/ConfirmModal";
import { Icon, Modal } from "../../components/ui";

// What /multi-manage used to do, as the Bots page's select mode: the bar sits
// over the list while bots are being picked, and runs one action on them all.
const ACTIONS = [
    { key: "start",   label: "Start",   icon: "play" },
    { key: "stop",    label: "Stop",    icon: "stop" },
    { key: "restart", label: "Restart", icon: "restart" },
    { key: "install", label: "Install", icon: "download" },
    { key: "update",  label: "Update",  icon: "refresh" },
    { key: "remove",  label: "Remove",  icon: "trash", danger: true },
];

function MiniSpinner() {
    return <span style={{ width: 12, height: 12, borderRadius: "50%", border: "2px solid currentColor", borderTopColor: "transparent", animation: "spin 0.8s linear infinite", display: "inline-block" }} />;
}

export default function BulkBar({ selected, visibleIds, onSelectAll, onClear, onExit, onRemoved, refresh }) {
    const [busy, setBusy] = useState(null);
    const [results, setResults] = useState(null);
    const [lastAction, setLastAction] = useState("");
    const [confirmRemove, setConfirmRemove] = useState(false);

    const count = selected.size;
    const allVisible = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

    const run = async (action) => {
        if (!count) return;
        setBusy(action);
        setLastAction(ACTIONS.find((a) => a.key === action)?.label || action);
        try {
            const { data } = await api.post(`/bulk/${action}`, { botIds: [...selected] });
            setResults(data.results);
            if (action === "remove") onRemoved(data.results.filter((r) => r.status === "ok").map((r) => r.botId));
            refresh();
        } catch (err) {
            setResults([{ botId: "-", name: "Request failed", status: "error", message: err.response?.data?.error || err.message }]);
        } finally {
            setBusy(null);
        }
    };

    const ok = results?.filter((r) => r.status === "ok").length || 0;

    return (
        <>
            <div
                className="card"
                style={{
                    position: "sticky", top: 12, zIndex: 10,
                    padding: "10px 12px",
                    display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                    borderColor: count ? "var(--accent)" : undefined,
                    boxShadow: "var(--shadow-popover)",
                }}
            >
                <span style={{ fontSize: 13, fontWeight: 500, color: count ? "var(--text)" : "var(--text-dim)", minWidth: 84 }}>
                    {count} selected
                </span>
                <button className="btn-ghost btn-sm" onClick={allVisible ? onClear : onSelectAll} disabled={!visibleIds.length}>
                    {allVisible ? "Clear" : `Select all ${visibleIds.length}`}
                </button>
                {count > 0 && !allVisible && (
                    <button className="btn-ghost btn-sm" onClick={onClear}>Clear</button>
                )}

                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginLeft: "auto" }}>
                    {ACTIONS.map((a) => (
                        <button
                            key={a.key}
                            className={`btn-ghost btn-sm${a.danger ? " is-danger" : ""}`}
                            disabled={!count || !!busy}
                            onClick={() => (a.key === "remove" ? setConfirmRemove(true) : run(a.key))}
                        >
                            {busy === a.key ? <MiniSpinner /> : <Icon name={a.icon} size={14} />}
                            {a.label}
                        </button>
                    ))}
                    <span style={{ width: 1, height: 20, background: "var(--border)", margin: "0 4px" }} />
                    <button className="btn-primary btn-sm" onClick={onExit}>Done</button>
                </div>
            </div>

            {confirmRemove && (
                <ConfirmModal
                    title={`Delete ${count} bot${count === 1 ? "" : "s"}?`}
                    message="Their PM2 processes stop and their project folders are deleted. This cannot be undone."
                    confirmText="Delete selected"
                    onConfirm={() => { setConfirmRemove(false); run("remove"); }}
                    onCancel={() => setConfirmRemove(false)}
                />
            )}

            {results && (
                <Modal title={`${lastAction}: ${ok} done, ${results.length - ok} failed`} onClose={() => setResults(null)} width={600}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "60vh", overflowY: "auto" }}>
                        {results.map((r, i) => (
                            <div key={r.botId + i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-input)" }}>
                                <Icon
                                    name={r.status === "ok" ? "checkCircle" : "xCircle"}
                                    style={{ color: r.status === "ok" ? "var(--success)" : "var(--danger)", marginTop: 1 }}
                                />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <p style={{ fontSize: 13, fontWeight: 500, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</p>
                                    <p className="mono" style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0", overflowWrap: "anywhere" }}>{r.message}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
                        <button className="btn-primary" onClick={() => setResults(null)}>OK</button>
                    </div>
                </Modal>
            )}
        </>
    );
}
