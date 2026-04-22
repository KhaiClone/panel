import axios from "axios";

// Base URL — empty string because Vite proxies /api in dev,
// and in production Express serves everything from the same origin.
const api = axios.create({
    baseURL: "/api",
    timeout: 30_000,
});

// ── Request interceptor ────────────────────────────────────────────────────
// Automatically attach the JWT token from localStorage to every request.
api.interceptors.request.use((config) => {
    const token = localStorage.getItem("token");
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

// ── Response interceptor ───────────────────────────────────────────────────
// Redirect to login if the server returns 401 (expired/invalid token).
api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401) {
            localStorage.removeItem("token");
            window.location.href = "/login";
        }
        return Promise.reject(error);
    },
);

export default api;
