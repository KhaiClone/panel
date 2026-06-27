import { createContext, useContext, useState, useEffect } from "react";
import api from "../api/client";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null); // { username, role, userId } | null
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const token = localStorage.getItem("token");
        if (!token) { setLoading(false); return; }

        api.get("/auth/verify")
            .then((res) => setUser({
                username: res.data.username,
                role: res.data.role,
                userId: res.data.userId,
            }))
            .catch(() => localStorage.removeItem("token"))
            .finally(() => setLoading(false));
    }, []);

    const login = async (username, password) => {
        const res = await api.post("/auth/login", { username, password });
        localStorage.setItem("token", res.data.token);
        setUser({ username: res.data.username, role: res.data.role, userId: res.data.userId });
    };

    const logout = () => {
        localStorage.removeItem("token");
        setUser(null);
    };

    const isAdmin = user?.role === "admin";

    return (
        <AuthContext.Provider value={{ user, loading, login, logout, isAdmin }}>
            {children}
        </AuthContext.Provider>
    );
}

export const useAuth = () => useContext(AuthContext);
