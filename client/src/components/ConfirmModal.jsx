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
            style={{
                position: "fixed", inset: 0, zIndex: 9999,
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: 16, background: "rgba(0,0,0,0.65)",
            }}
            onClick={onCancel}
        >
            <div
                className="card"
                style={{ maxWidth: 420, width: "100%", padding: 24 }}
                onClick={e => e.stopPropagation()}
            >
                <div style={{ marginBottom: 16 }}>
                    <span style={{ fontSize: 24 }}>{danger ? "⚠️" : "ℹ️"}</span>
                </div>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
                    {title}
                </h3>
                <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6, whiteSpace: "pre-line", marginBottom: 20 }}>
                    {message}
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn-ghost" style={{ flex: 1 }} onClick={onCancel}>
                        Cancel
                    </button>
                    <button
                        className={danger ? "btn-danger" : "btn-primary"}
                        style={{ flex: 1 }}
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
