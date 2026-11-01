import { useState, useEffect, useCallback } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import api from "../api/client";
import { Icon, Notice, PageHeader } from "../components/ui";

// One transcript, in a frame (server/services/transcriptService.js). /open asks
// the shop bot for its files and answers with a view ticket good for 15 minutes;
// the frame loads /api/transcripts/view/<ticket>. That answer carries
// `Content-Security-Policy: sandbox …`, so the transcript runs with no origin of
// its own — its scripts can never reach the panel's login or this page, in the
// frame or in a new tab alike. No `sandbox` attribute on the frame: it would say
// the same, and some embedded browsers refuse sandboxed frames outright (the
// Claude desktop browser pane did, 2026-11-02).

const when = (ts) => (ts ? new Date(ts).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—");

export default function TranscriptView() {
    const { id } = useParams();
    const known = useLocation().state?.transcript || null; // the row it was opened from, if any
    const [view, setView] = useState(null); // { ticket, name, expiresAt }
    const [error, setError] = useState("");

    const open = useCallback(async () => {
        setView(null);
        setError("");
        try {
            const { data } = await api.get(`/transcripts/${id}/open`);
            setView(data);
        } catch (err) {
            setError(err.response?.data?.error || "Could not open this transcript");
        }
    }, [id]);

    useEffect(() => {
        open();
    }, [open]);

    const src = view ? `${api.defaults.baseURL}/transcripts/view/${view.ticket}` : null;
    const title = view?.name || known?.name || "Transcript";
    const facts = known
        ? [known.ownerTag || known.ownerId, known.reason, `Closed ${when(known.closedAt)}`].filter(Boolean).join(" · ")
        : "";

    return (
        <div className="page fade-in" style={{ maxWidth: 1400, display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <Link to="/transcripts" className="btn-ghost btn-icon" title="Back to transcripts" style={{ marginTop: 1 }}>
                    <Icon name="chevronLeft" />
                </Link>
                <div className="min-w-0" style={{ flex: 1 }}>
                    <PageHeader
                        title={title}
                        description={facts || undefined}
                        actions={
                            <>
                                <button className="btn-ghost btn-sm" onClick={open} title="Fetch the files again (the link lasts 15 minutes)">
                                    <Icon name="refresh" size={14} /> Reload
                                </button>
                                {src && (
                                    <a className="btn-ghost btn-sm" href={src} target="_blank" rel="noopener noreferrer" title="Open in a new tab (the link lasts 15 minutes)">
                                        <Icon name="externalLink" size={14} /> New tab
                                    </a>
                                )}
                            </>
                        }
                    />
                </div>
            </div>

            {error && <Notice tone="danger">{error}</Notice>}
            {!view && !error && (
                <div className="card" style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
                    Fetching the transcript from Discord through the shop bot…
                </div>
            )}
            {src && (
                <iframe
                    key={view.ticket}
                    title={title}
                    src={src}
                    referrerPolicy="no-referrer"
                    style={{ width: "100%", height: "calc(100vh - 200px)", minHeight: 480, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-card)" }}
                />
            )}
        </div>
    );
}
