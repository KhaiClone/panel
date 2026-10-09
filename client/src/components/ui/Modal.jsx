import { createPortal } from "react-dom";
import Icon from "./Icon";

/** A dialog over the page: a title row with a close button, then the body. */
export default function Modal({ title, onClose, children, width = 560 }) {
    return createPortal(
        <div className="modal-overlay" onClick={onClose}>
            <div
                className="card slide-up modal-card-mobile"
                style={{ maxWidth: width, width: "100%", maxHeight: "90vh", overflowY: "auto", padding: 20, position: "relative", zIndex: 1001, boxShadow: "var(--shadow-popover)" }}
                onClick={(e) => e.stopPropagation()}
            >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 12 }}>
                    <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{title}</h3>
                    <button type="button" className="btn-ghost btn-icon" style={{ width: 28, height: 28, border: "none" }} title="Close" onClick={onClose}>
                        <Icon name="x" />
                    </button>
                </div>
                {children}
            </div>
        </div>,
        document.body,
    );
}
