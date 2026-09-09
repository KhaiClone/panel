import { createContext, useContext, useState, useEffect } from "react";
import api from "../api/client";

// The panel has a single account (the admin from the server's .env). There are no
// roles and no other accounts, so "logged in" is the only distinction there is.
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null); // { username } | null
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const token = localStorage.getItem("token");
        if (!token) { setLoading(false); return; }

        api.get("/auth/verify")
            .then((res) => setUser({ username: res.data.username }))
            .catch(() => localStorage.removeItem("token"))
            .finally(() => setLoading(false));
    }, []);

    const login = async (username, password) => {
        const res = await api.post("/auth/login", { username, password });
        localStorage.setItem("token", res.data.token);
        setUser({ username: res.data.username });
    };

    const logout = () => {
        localStorage.removeItem("token");
        setUser(null);
    };

    return (
        <AuthContext.Provider value={{ user, loading, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
}

export const useAuth = () => useContext(AuthContext);
