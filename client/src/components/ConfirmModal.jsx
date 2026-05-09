// Reusable confirm dialog for destructive actions (delete, stop, etc.)
export default function ConfirmModal({
    title,
    message,
    confirmText = "Confirm",
    danger = true,
    onConfirm,
    onCancel,
}) {
    return (
        // Backdrop
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
            <div className="bg-slate-900/90 border border-slate-800 backdrop-blur-xl rounded-2xl w-full max-w-md shadow-2xl p-5 lg:p-6 mx-4">
                {/* Header */}
                <h3 className="text-lg lg:text-xl font-black text-slate-100 mb-2 tracking-tight">
                    {title}
                </h3>
                <p className="text-xs lg:text-sm text-slate-500 mb-6 font-medium leading-relaxed whitespace-pre-line">{message}</p>

                {/* Actions */}
                <div className="flex flex-col sm:flex-row gap-2 lg:gap-3 justify-end">
                    <button className="btn-ghost order-2 sm:order-1" onClick={onCancel}>
                        Cancel
                    </button>
                    <button
                        className={`${danger ? "btn-danger" : "btn-primary"} order-1 sm:order-2 py-2.5`}
                        onClick={onConfirm}
                    >
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>
    );
}
