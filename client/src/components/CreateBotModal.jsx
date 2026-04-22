import { useState } from "react";
import api from "../api/client";

const defaultForm = {
    buyerID: "",
    botID: "",
    name: "",
    repoUrl: "",
    branch: "main",
    startScript: "index.js",
    expiresAt: "",
};

export default function CreateBotModal({ onClose, onCreated }) {
    const [form, setForm] = useState(defaultForm);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const set = (field) => (e) =>
        setForm((f) => ({ ...f, [field]: e.target.value }));

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        setLoading(true);

        try {
            const payload = {
                ...form,
                // Convert local datetime string to ISO — empty string becomes null
                expiresAt: form.expiresAt
                    ? new Date(form.expiresAt).toISOString()
                    : null,
            };
            const { data } = await api.post("/bots", payload);
            onCreated(data);
            onClose();
        } catch (err) {
            setError(err.response?.data?.error || "Failed to create bot");
        } finally {
            setLoading(false);
        }
    };

    return (
        // Backdrop
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
            <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-lg shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
                    <h2 className="text-lg font-semibold text-slate-100">
                        ➕ Create New Bot
                    </h2>
                    <button
                        onClick={onClose}
                        className="text-slate-500 hover:text-slate-300 text-xl leading-none"
                    >
                        ✕
                    </button>
                </div>

                {/* Form */}
                <form onSubmit={handleSubmit} className="p-6 space-y-4">
                    {/* Row 1 */}
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="label">Buyer Discord ID *</label>
                            <input
                                className="input"
                                placeholder="123456789012345678"
                                value={form.buyerID}
                                onChange={set("buyerID")}
                                required
                            />
                        </div>
                        <div>
                            <label className="label">
                                Bot Slug (unique ID) *
                            </label>
                            <input
                                className="input"
                                placeholder="my-bot"
                                value={form.botID}
                                onChange={set("botID")}
                                required
                                pattern="[a-zA-Z0-9_-]+"
                                title="Letters, numbers, hyphens, underscores only"
                            />
                        </div>
                    </div>

                    {/* Display name */}
                    <div>
                        <label className="label">Display Name *</label>
                        <input
                            className="input"
                            placeholder="My Awesome Bot"
                            value={form.name}
                            onChange={set("name")}
                            required
                        />
                    </div>

                    {/* Repo */}
                    <div>
                        <label className="label">Git Repository URL *</label>
                        <input
                            className="input"
                            placeholder="https://github.com/user/repo.git"
                            value={form.repoUrl}
                            onChange={set("repoUrl")}
                            required
                        />
                    </div>

                    {/* Row 2 */}
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="label">Branch</label>
                            <input
                                className="input"
                                placeholder="main"
                                value={form.branch}
                                onChange={set("branch")}
                            />
                        </div>
                        <div>
                            <label className="label">Start Script</label>
                            <input
                                className="input"
                                placeholder="index.js"
                                value={form.startScript}
                                onChange={set("startScript")}
                            />
                        </div>
                    </div>

                    {/* Expiry */}
                    <div>
                        <label className="label">Expiry Date (optional)</label>
                        <input
                            type="datetime-local"
                            className="input"
                            value={form.expiresAt}
                            onChange={set("expiresAt")}
                        />
                        <p className="text-xs text-slate-500 mt-1">
                            Leave empty for no expiry.
                        </p>
                    </div>

                    {/* Error */}
                    {error && (
                        <div className="bg-red-900/40 border border-red-700 text-red-400 text-sm rounded-lg px-3 py-2">
                            {error}
                        </div>
                    )}

                    {/* Note: git clone + npm install can take a moment */}
                    {loading && (
                        <div className="bg-indigo-900/40 border border-indigo-700 text-indigo-300 text-sm rounded-lg px-3 py-2">
                            ⏳ Cloning repo and installing dependencies — this
                            may take a moment…
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex gap-3 justify-end pt-2">
                        <button
                            type="button"
                            className="btn-ghost"
                            onClick={onClose}
                            disabled={loading}
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            className="btn-primary"
                            disabled={loading}
                        >
                            {loading ? "Creating…" : "Create Bot"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
