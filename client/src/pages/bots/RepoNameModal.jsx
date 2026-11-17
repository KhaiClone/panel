import { useState } from "react";
import api from "../../api/client";
import { Field, Modal, Notice } from "../../components/ui";

// Bots → Repos → Name: a repo's name of its own (kept — the weekly check
// never renames it), or back to the name template. Either way the repo is
// renamed right away and the projects using it follow
// (server/services/customerRepoNames.js setName).

const DIM = { fontSize: 12, color: "var(--text-dim)" };

export default function RepoNameModal({ repo, template, onClose, onDone }) {
    const [mode, setMode] = useState(repo.naming?.custom ? "own" : "template");
    const [name, setName] = useState(repo.name);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const unchanged = mode === "template" ? !repo.naming?.custom : name.trim() === repo.name && repo.naming?.custom;

    const save = async () => {
        setBusy(true);
        setError("");
        try {
            const { data } = await api.put(`/customer-projects/repos/${encodeURIComponent(repo.name)}/name`,
                { customName: mode === "own" ? name.trim() : null }, { timeout: 120_000 });
            onDone(data);
        } catch (err) {
            setError(err.response?.data?.error || "Could not rename the repo");
            setBusy(false);
        }
    };

    return (
        <Modal title={`Name of ${repo.fullName}`} onClose={busy ? undefined : onClose} width={500}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
                    <input type="radio" checked={mode === "template"} onChange={() => setMode("template")} disabled={busy} style={{ marginTop: 3 }} />
                    <span>
                        Follow the name template <span className="mono">{template}</span>
                        <span style={{ ...DIM, display: "block" }}>Renamed now if it does not match, and again whenever the names change (checked weekly).</span>
                    </span>
                </label>
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
                    <input type="radio" checked={mode === "own"} onChange={() => setMode("own")} disabled={busy} style={{ marginTop: 3 }} />
                    <span>
                        A name of its own
                        <span style={{ ...DIM, display: "block" }}>Renamed now; the weekly check leaves it alone.</span>
                    </span>
                </label>
                {mode === "own" && (
                    <Field label="Repo name" hint={'Letters, digits, ".", "_" and "-", up to 100 characters.'}>
                        <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} autoFocus />
                    </Field>
                )}
                <p style={{ ...DIM, margin: 0 }}>
                    GitHub keeps the old name working as a redirect. The projects using this repo get the new URL, and their checkouts on the
                    nodes are pointed at it.
                </p>
                {error && <Notice tone="danger">{error}</Notice>}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button type="button" className="btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
                    <button type="button" className="btn-primary btn-sm" onClick={save} disabled={busy || unchanged || (mode === "own" && !name.trim())}>
                        {busy ? "Renaming…" : "Save"}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
