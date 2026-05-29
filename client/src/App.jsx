import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { DataProvider } from "./context/DataContext";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import BotDetail from "./pages/BotDetail";
import GroupsPage from "./pages/GroupsPage";
import MultiManage from "./pages/MultiManage";
import PanelManage from "./pages/PanelManage";
import SystemPage from "./pages/SystemPage";
import ProxyPage from "./pages/ProxyPage";
import TagsPage from "./pages/TagsPage";
import Layout from "./components/Layout";

// ── Auth Guard ─────────────────────────────────────────────────────────────
function PrivateRoute({ children }) {
    const { user, loading } = useAuth();

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center" style={{ background: "var(--bg-base)" }}>
                <div className="flex flex-col items-center gap-4">
                    <div className="relative w-14 h-14">
                        <div className="absolute inset-0 rounded-full" style={{ border: "3px solid rgba(124,58,237,0.12)" }} />
                        <div className="absolute inset-0 rounded-full animate-spin" style={{ border: "3px solid transparent", borderTopColor: "#7C3AED" }} />
                        {/* Inner dot */}
                        <div className="absolute inset-[18px] rounded-full animate-pulse" style={{ background: "rgba(124,58,237,0.5)" }} />
                    </div>
                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-600 animate-pulse">
                        Initializing
                    </p>
                </div>
            </div>
        );
    }

    return user ? children : <Navigate to="/login" replace />;
}

export default function App() {
    return (
        <AuthProvider>
            <DataProvider>
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
                            <Route index element={<Navigate to="/dashboard" replace />} />
                            <Route path="dashboard"    element={<Dashboard />} />
                            <Route path="bots/:id"     element={<BotDetail />} />
                            <Route path="groups"       element={<GroupsPage />} />
                            <Route path="multi-manage" element={<MultiManage />} />
                            <Route path="panel-manage" element={<PanelManage />} />
                            <Route path="proxy"        element={<ProxyPage />} />
                            <Route path="tags"         element={<TagsPage />} />
                            <Route path="system"       element={<SystemPage />} />
                        </Route>

                        {/* Fallback */}
                        <Route path="*" element={<Navigate to="/dashboard" replace />} />
                    </Routes>
                </BrowserRouter>
            </DataProvider>
        </AuthProvider>
    );
}
