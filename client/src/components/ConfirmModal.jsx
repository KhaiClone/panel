import { createPortal } from "react-dom";

export default function ConfirmModal({
    title,
    message,
    confirmText = "Confirm",
    danger = true,
    onConfirm,
    onCancel,
}) {
    return createPortal(
        <div
            className="modal-overlay"
            onClick={onCancel}
        >
            <div
                className="card slide-up"
                style={{ maxWidth: 420, width: "100%", padding: 32, position: "relative", zIndex: 1001, boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5)" }}
                onClick={e => e.stopPropagation()}
            >
                <div style={{ marginBottom: 20 }}>
                    <div style={{ width: 48, height: 48, borderRadius: "50%", background: danger ? "var(--danger-bg)" : "var(--success-bg)", display: "flex", alignItems: "center", justifyContent: "center", color: danger ? "var(--danger)" : "var(--success)" }}>
                        <span style={{ fontSize: 24 }}>{danger ? "⚠️" : "ℹ️"}</span>
                    </div>
                </div>
                <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 12, letterSpacing: "-0.01em" }}>
                    {title}
                </h3>
                <p style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.6, whiteSpace: "pre-line", marginBottom: 32 }}>
                    {message}
                </p>
                <div style={{ display: "flex", gap: 12 }}>
                    <button className="btn-ghost" style={{ flex: 1, padding: "10px" }} onClick={onCancel}>
                        Cancel
                    </button>
                    <button
                        className={danger ? "btn-danger" : "btn-primary"}
                        style={{ flex: 1, padding: "10px" }}
                        onClick={onConfirm}
                    >
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}
