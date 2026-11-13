import { useState } from "react";
import { Modal } from "./ui";

/**
 * A confirm for what cannot be undone from the panel (deleting a repo): the
 * button only works once `word` is typed back exactly.
 */
export default function TypeToConfirm({ title, message, word, confirmText = "Delete", busy = false, onConfirm, onCancel }) {
    const [typed, setTyped] = useState("");
    const ok = typed === word;
    return (
        <Modal title={title} onClose={busy ? undefined : onCancel} width={480}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0, whiteSpace: "pre-line" }}>{message}</p>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        Type <span className="mono" style={{ color: "var(--text)" }}>{word}</span> to confirm
                    </span>
                    <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus disabled={busy} />
                </label>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
                    <button type="button" className="btn-danger" onClick={() => onConfirm(typed)} disabled={!ok || busy}>
                        {busy ? "Working…" : confirmText}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
