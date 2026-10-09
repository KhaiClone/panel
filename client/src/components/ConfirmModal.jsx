import { createPortal } from "react-dom";
import Icon from "./ui/Icon";

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
                className="card slide-up modal-card-mobile"
                style={{ maxWidth: 420, width: "100%", padding: 24, position: "relative", zIndex: 1001, boxShadow: "var(--shadow-popover)" }}
                onClick={e => e.stopPropagation()}
            >
                <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 20 }}>
                    <span style={{
                        width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        background: danger ? "var(--danger-bg)" : "var(--accent-dim)",
                        color: danger ? "var(--danger)" : "var(--accent-hover)",
                    }}>
                        <Icon name={danger ? "alert" : "info"} />
                    </span>
                    <div style={{ minWidth: 0 }}>
                        <h3 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", margin: "4px 0 8px", wordBreak: "break-word" }}>
                            {title}
                        </h3>
                        <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6, whiteSpace: "pre-line", margin: 0 }}>
                            {message}
                        </p>
                    </div>
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button className="btn-ghost" onClick={onCancel}>
                        Cancel
                    </button>
                    <button
                        className={danger ? "btn-danger" : "btn-primary"}
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
