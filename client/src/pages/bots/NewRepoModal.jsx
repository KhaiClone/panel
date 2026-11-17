import { useEffect, useState } from "react";
import api from "../../api/client";
import { Field, Icon, Modal, Notice } from "../../components/ui";

// Bots → Repos → New repo (server/services/customerRepoNames.js): an empty
// private repo in the customers' org, named by the template from the
// customer's and the bot's Discord ids — or a name typed here, which is then
// the repo's own and never renamed by the weekly check.

const SNOWFLAKE = /^\d{15,25}$/;
const DIM = { fontSize: 12, color: "var(--text-dim)" };

const copy = async (text) => {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
};

function CopyRow({ label, value, hint }) {
    const [copied, setCopied] = useState(false);
    return (
        <Field label={label} hint={hint}>
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input className="input mono" readOnly value={value} onFocus={(e) => e.target.select()} />
                <button type="button" className="btn-ghost btn-icon btn-sm" title="Copy"
                    onClick={async () => { if (await copy(value)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}>
                    <Icon name={copied ? "check" : "copy"} size={14} />
                </button>
            </span>
        </Field>
    );
}

export default function NewRepoModal({ onClose, onCreated }) {
    const [form, setForm] = useState({ buyerID: "", botUserId: "", label: "", own: false, name: "" });
    const [preview, setPreview] = useState(null); // { name, username, botName } | { error }
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [made, setMade] = useState(null);
    const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

    const body = () => ({
        buyerID: form.buyerID.trim(),
        botUserId: form.botUserId.trim() || undefined,
        label: form.botUserId.trim() ? undefined : form.label.trim() || undefined,
        name: form.own ? form.name.trim() || undefined : undefined,
    });

    // The name the panel would give, a moment after typing stops.
    useEffect(() => {
        setPreview(null);
        if (!SNOWFLAKE.test(form.buyerID.trim())) return undefined;
        if (form.botUserId.trim() && !SNOWFLAKE.test(form.botUserId.trim())) return undefined;
        if (form.own && !form.name.trim()) return undefined;
        let live = true;
        const t = setTimeout(() => {
            api.post("/customer-projects/repos/preview", body(), { timeout: 60_000 })
                .then((r) => live && setPreview(r.data))
                .catch((err) => live && setPreview({ error: err.response?.data?.error || "Could not work out the name" }));
        }, 600);
        return () => {
            live = false;
            clearTimeout(t);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [form]);

    const create = async () => {
        setBusy(true);
        setError("");
        try {
            const { data } = await api.post("/customer-projects/repos", body(), { timeout: 60_000 });
            setMade(data);
            onCreated?.(data);
        } catch (err) {
            setError(err.response?.data?.error || "Could not make the repo");
        } finally {
            setBusy(false);
        }
    };

    if (made) {
        return (
            <Modal title="Repo made" onClose={onClose}>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <Notice tone="success">
                        <a href={made.url} target="_blank" rel="noreferrer" className="mono">{made.fullName}</a> is ready — private and empty.
                        Push the bot's code to it, then create the project from it.
                    </Notice>
                    <CopyRow label="Push your code (SSH)" value={made.sshUrl} hint={`git remote add origin ${made.sshUrl}`} />
                    <CopyRow label="Repo URL for Create Project" value={made.cloneUrl} />
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <button type="button" className="btn-primary btn-sm" onClick={onClose}>Done</button>
                    </div>
                </div>
            </Modal>
        );
    }

    const ready = SNOWFLAKE.test(form.buyerID.trim()) && preview?.name && !busy;
    return (
        <Modal title="New repo" onClose={onClose}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <p style={{ ...DIM, margin: 0 }}>
                    An empty private repo in the customers' org, named by the name template from the customer's and the bot's Discord accounts.
                    The weekly name check renames it when those names change.
                </p>
                <Field label="Customer's Discord ID">
                    <input className="input mono" placeholder="e.g. 427399742906040333" value={form.buyerID} onChange={set("buyerID")} disabled={busy} autoFocus />
                </Field>
                <Field label="Bot's Discord ID" hint="Leave empty for a website or a service with no bot.">
                    <input className="input mono" placeholder="The customer's bot's Discord ID" value={form.botUserId} onChange={set("botUserId")} disabled={busy} />
                </Field>
                {!form.botUserId.trim() && (
                    <Field label="Project name" hint="Stands in for {botname} when there is no bot.">
                        <input className="input" placeholder="e.g. Shop website" value={form.label} onChange={set("label")} disabled={busy} />
                    </Field>
                )}
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                    <input type="checkbox" checked={form.own} onChange={set("own")} disabled={busy} />
                    Give it a name of its own (never renamed by the weekly check)
                </label>
                {form.own && (
                    <Field label="Repo name" hint={'Letters, digits, ".", "_" and "-", up to 100 characters.'}>
                        <input className="input mono" placeholder="my-repo" value={form.name} onChange={set("name")} disabled={busy} />
                    </Field>
                )}

                <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>Repo name</span>
                    {preview?.name ? (
                        <>
                            <span className="mono" style={{ fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>{preview.org}/{preview.name}</span>
                            {!preview.custom && (
                                <span style={DIM}>
                                    Customer @{preview.username || "—"} · {form.botUserId.trim() ? "bot" : "project"} {preview.botName || "—"}
                                </span>
                            )}
                        </>
                    ) : preview?.error ? (
                        <span style={{ fontSize: 12, color: "var(--danger)" }}>{preview.error}</span>
                    ) : (
                        <span style={DIM}>{SNOWFLAKE.test(form.buyerID.trim()) ? "Working it out…" : "Enter the customer's Discord ID."}</span>
                    )}
                </div>

                {error && <Notice tone="danger">{error}</Notice>}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button type="button" className="btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
                    <button type="button" className="btn-primary btn-sm" onClick={create} disabled={!ready}>
                        <Icon name="plus" size={14} /> {busy ? "Making…" : "Make repo"}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
