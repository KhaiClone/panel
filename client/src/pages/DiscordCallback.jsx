import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { homeFor } from "../context/access";

// Discord sends staff back to the launcher's /auth/discord/callback, which
// forwards here with ?code&state (or ?error when they cancelled). A code works
// once: StrictMode runs effects twice in development, so it is handed over once
// per page load.
const handled = new Set();

export default function DiscordCallback() {
    const { finishDiscordLogin } = useAuth();
    const navigate = useNavigate();
    const [error, setError] = useState("");

    useEffect(() => {
        const q = new URLSearchParams(window.location.search);
        const code = q.get("code");
        const state = q.get("state");
        if (q.get("error")) {
            setError(q.get("error") === "access_denied" ? "Discord sign-in was cancelled." : `Discord said: ${q.get("error_description") || q.get("error")}`);
            return;
        }
        if (!code) {
            setError("Discord did not send a sign-in code.");
            return;
        }
        if (handled.has(code)) return;
        handled.add(code);
        finishDiscordLogin(code, state)
            .then((u) => navigate(homeFor(u), { replace: true }))
            .catch((err) => setError(err.response?.data?.error || err.message || "Sign-in failed."));
    }, [finishDiscordLogin, navigate]);

    return (
        <>
            <title>Signing in — NexusPanel</title>
            <div className="fade-in" style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 20px", background: "var(--bg-base)" }}>
                <div style={{ width: "100%", maxWidth: 360, textAlign: "center" }}>
                    <img src="/logo.png" alt="NexusPanel" style={{ width: 36, height: 36, borderRadius: 8, objectFit: "contain", margin: "0 auto 16px", display: "block" }} />
                    {error ? (
                        <div className="card" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
                            <p style={{ margin: 0, fontSize: 14, color: "var(--danger)" }}>{error}</p>
                            <Link to="/login" className="btn-primary" style={{ justifyContent: "center", textDecoration: "none" }}>Back to sign in</Link>
                        </div>
                    ) : (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                            <div style={{ width: 32, height: 32, borderRadius: "50%", border: "3px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 0.8s linear infinite" }} />
                            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>Signing you in with Discord…</p>
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
