import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";

export default function ConfirmModal({
    title,
    message,
    confirmText = "Confirm",
    danger = true,
    onConfirm,
    onCancel,
}) {
    return createPortal(
        <AnimatePresence>
            <motion.div
                key="backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[9999] flex items-center justify-center px-4"
                style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)" }}
                onClick={onCancel}
            >
                <motion.div
                    key="panel"
                    initial={{ opacity: 0, scale: 0.92, y: 16 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.92, y: 16 }}
                    transition={{ type: "spring", stiffness: 340, damping: 28 }}
                    className="w-full max-w-md"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="gradient-border">
                        <div
                            className="rounded-2xl p-6 space-y-5"
                            style={{
                                background: "linear-gradient(135deg, rgba(17,24,39,0.98) 0%, rgba(13,21,37,0.98) 100%)",
                                border: "1px solid rgba(255,255,255,0.08)",
                                boxShadow: "0 30px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(124,58,237,0.08)",
                            }}
                        >
                            {/* Icon */}
                            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center mb-1 ${
                                danger
                                    ? "bg-rose-500/10 border border-rose-500/20"
                                    : "bg-violet-500/10 border border-violet-500/20"
                            }`}>
                                <span className="text-xl">{danger ? "⚠️" : "ℹ️"}</span>
                            </div>

                            <div>
                                <h3 className="text-lg font-black text-slate-100 tracking-tight leading-tight">
                                    {title}
                                </h3>
                                <p className="text-sm text-slate-400 mt-2 leading-relaxed whitespace-pre-line">
                                    {message}
                                </p>
                            </div>

                            <div className="flex gap-3 pt-1">
                                <button
                                    className="btn-ghost flex-1 py-2.5"
                                    onClick={onCancel}
                                >
                                    Cancel
                                </button>
                                <button
                                    className={`${danger ? "btn-danger" : "btn-primary"} flex-1 py-2.5 font-black`}
                                    onClick={onConfirm}
                                >
                                    {confirmText}
                                </button>
                            </div>
                        </div>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>,
        document.body
    );
}
