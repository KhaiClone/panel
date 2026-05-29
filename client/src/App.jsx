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

function PrivateRoute({ children }) {
    const { user, loading } = useAuth();
    if (loading) {
        return (
            <div style={{
                display: "flex", height: "100vh", alignItems: "center", justifyContent: "center",
                background: "var(--bg)", flexDirection: "column", gap: 12
            }}>
                <div style={{
                    width: 32, height: 32, borderRadius: "50%",
                    border: "3px solid var(--border)", borderTopColor: "var(--accent)",
                    animation: "spin 0.8s linear infinite",
                }}/>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading…</p>
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
                        <Route path="/login" element={<Login />} />
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
                        <Route path="*" element={<Navigate to="/dashboard" replace />} />
                    </Routes>
                </BrowserRouter>
            </DataProvider>
        </AuthProvider>
    );
}
