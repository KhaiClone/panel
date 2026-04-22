import { createContext, useContext, useState, useEffect } from "react";
import api from "../api/client";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null); // { username } | null
    const [loading, setLoading] = useState(true); // Checking token on first load

    // On mount: verify the stored token with the server
    useEffect(() => {
        const token = localStorage.getItem("token");
        if (!token) {
            setLoading(false);
            return;
        }

        api.get("/auth/verify")
            .then((res) => setUser({ username: res.data.username }))
            .catch(() => localStorage.removeItem("token"))
            .finally(() => setLoading(false));
    }, []);

    /** Log in with username + password, store JWT on success */
    const login = async (username, password) => {
        const res = await api.post("/auth/login", { username, password });
        localStorage.setItem("token", res.data.token);
        setUser({ username: res.data.username });
    };

    /** Clear session */
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

/** Hook to consume auth state in any component */
export const useAuth = () => useContext(AuthContext);
