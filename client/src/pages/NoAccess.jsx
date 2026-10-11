import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

// A staff member signed in, but the owner has not given them any page yet.
export default function NoAccess() {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    return (
        <>
            <title>No access — NexusPanel</title>
            <div className="fade-in" style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 20px", background: "var(--bg-base)" }}>
                <div className="card" style={{ width: "100%", maxWidth: 360, padding: 24, textAlign: "center", display: "flex", flexDirection: "column", gap: 14 }}>
                    <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: "var(--text)" }}>No pages yet</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                        You are signed in as <b>{user?.username}</b>, but the owner has not given you any page of the panel yet.
                    </p>
                    <button className="btn-ghost" style={{ justifyContent: "center" }} onClick={() => { logout(); navigate("/login"); }}>
                        Sign out
                    </button>
                </div>
            </div>
        </>
    );
}
