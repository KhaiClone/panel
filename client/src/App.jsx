import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import BotDetail from "./pages/BotDetail";
import Layout from "./components/Layout";

// ── Auth Guard ─────────────────────────────────────────────────────────────
// Wraps any route that requires the admin to be logged in.
function PrivateRoute({ children }) {
    const { user, loading } = useAuth();

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center bg-slate-900">
                <div className="animate-spin h-8 w-8 border-4 border-indigo-500 border-t-transparent rounded-full" />
            </div>
        );
    }

    return user ? children : <Navigate to="/login" replace />;
}

export default function App() {
    return (
        <AuthProvider>
            <BrowserRouter>
                <Routes>
                    {/* Public */}
                    <Route path="/login" element={<Login />} />

                    {/* Protected — wrapped in sidebar layout */}
                    <Route
                        path="/"
                        element={
                            <PrivateRoute>
                                <Layout />
                            </PrivateRoute>
                        }
                    >
                        <Route
                            index
                            element={<Navigate to="/dashboard" replace />}
                        />
                        <Route path="dashboard" element={<Dashboard />} />
                        <Route path="bots/:id" element={<BotDetail />} />
                    </Route>

                    {/* Fallback */}
                    <Route
                        path="*"
                        element={<Navigate to="/dashboard" replace />}
                    />
                </Routes>
            </BrowserRouter>
        </AuthProvider>
    );
}
