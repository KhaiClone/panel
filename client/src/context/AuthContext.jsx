import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { useLocation } from "react-router-dom";
import api from "../api/client";
import { accessTo, pageForPath } from "./access";

// Two kinds of user (server: middleware/auth.js):
//   owner  { kind: "owner", username }                         the .env account, everything
//   staff  { kind: "staff", username, userId, avatar, perms }  Discord login, only their pages
const AuthContext = createContext(null);

const STATE_KEY = "bp_oauth_state";
const DEVICE_KEY = "bp_device";

const shape = (d) =>
    d.kind === "staff"
        ? { kind: "staff", username: d.username, userId: d.userId, avatar: d.avatar || null, perms: d.perms || {} }
        : { kind: "owner", username: d.username };

/** A random id this browser keeps, so the owner hears about logins from a new device. */
const deviceId = () => {
    try {
        let id = localStorage.getItem(DEVICE_KEY);
        if (!id) {
            id = (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");
            localStorage.setItem(DEVICE_KEY, id);
        }
        return id;
    } catch {
        return null;
    }
};

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const token = localStorage.getItem("token");
        // The Discord callback page signs in itself; an old token checked here
        // in parallel could only get in its way.
        if (!token || window.location.pathname === "/auth/discord/callback") { setLoading(false); return; }

        api.get("/auth/verify")
            .then((res) => setUser(shape(res.data)))
            .catch(() => { if (localStorage.getItem("token") === token) localStorage.removeItem("token"); })
            .finally(() => setLoading(false));
    }, []);

    // Permissions can change while a staff member is signed in: pick them up
    // now and then, so the menu follows what the server already enforces.
    useEffect(() => {
        if (user?.kind !== "staff") return;
        const t = setInterval(() => {
            api.get("/auth/verify").then((res) => setUser(shape(res.data))).catch(() => {});
        }, 60_000);
        return () => clearInterval(t);
    }, [user?.kind]);

    const login = async (username, password) => {
        const res = await api.post("/auth/login", { username, password });
        localStorage.setItem("token", res.data.token);
        setUser({ kind: "owner", username: res.data.username });
    };

    /** Off to Discord; it comes back to /auth/discord/callback (through the launcher). */
    const startDiscordLogin = async () => {
        const { data } = await api.post("/auth/discord/start");
        sessionStorage.setItem(STATE_KEY, data.state);
        window.location.assign(data.url);
    };

    /** The callback page hands over what Discord sent back. Returns the user. */
    const finishDiscordLogin = async (code, state) => {
        const expected = sessionStorage.getItem(STATE_KEY);
        sessionStorage.removeItem(STATE_KEY);
        if (!expected || expected !== state) {
            throw new Error("This sign-in did not start in this browser tab — start again from the login page.");
        }
        const { data } = await api.post("/auth/discord", { code, state, device: deviceId() });
        localStorage.setItem("token", data.token);
        const u = shape(data);
        setUser(u);
        return u;
    };

    const logout = () => {
        // Ends a staff session on the server too; an owner token just expires.
        // The token goes along explicitly: it is gone from storage before
        // axios's (async) request interceptor would read it.
        const token = localStorage.getItem("token");
        if (token) api.post("/auth/logout", null, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
        localStorage.removeItem("token");
        setUser(null);
    };

    const can = useCallback((page, level = "view") => {
        const a = accessTo(user, page);
        return level === "edit" ? a === "edit" : !!a;
    }, [user]);

    return (
        <AuthContext.Provider value={{ user, loading, isOwner: user?.kind === "owner", can, login, startDiscordLogin, finishDiscordLogin, logout }}>
            {children}
        </AuthContext.Provider>
    );
}

export const useAuth = () => useContext(AuthContext);

/**
 * May the current user change things on this page? `page` defaults to the one
 * the URL belongs to. View-only staff get the page without its buttons that
 * write — the server refuses those writes anyway.
 */
export const usePageAccess = (page) => {
    const { user } = useAuth();
    const { pathname } = useLocation();
    const level = accessTo(user, page || pageForPath(pathname));
    return { canEdit: level === "edit", readOnly: level === "view" };
};
