import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { NodeProvider } from "./context/NodeContext";
import { DataProvider } from "./context/DataContext";
import Login from "./pages/Login";
import OverviewPage from "./pages/OverviewPage";
import SystemsPage from "./pages/SystemsPage";
import Dashboard from "./pages/Dashboard";
import SitesPage from "./pages/SitesPage";
import DomainsPage from "./pages/DomainsPage";
import BotDetail from "./pages/BotDetail";
import GroupsPage from "./pages/GroupsPage";
import MultiManage from "./pages/MultiManage";
import PanelManage from "./pages/PanelManage";
import TerminalPage from "./pages/TerminalPage";
import ProxyPage from "./pages/ProxyPage";
import TagsPage from "./pages/TagsPage";
import AdminUsersPage from "./pages/AdminUsersPage";
import NodeDetailPage from "./pages/NodeDetailPage";
import OrdersPage from "./pages/OrdersPage";
import DecorsPage from "./pages/DecorsPage";
import QuestsPage from "./pages/QuestsPage";
import QuestAccountDetail from "./pages/QuestAccountDetail";
import Layout from "./components/Layout";

function Spinner() {
    return (
        <div style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", background: "var(--bg)", flexDirection: "column", gap: 12 }}>
            <div style={{ width: 32, height: 32, borderRadius: "50%", border: "3px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 0.8s linear infinite" }} />
            <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading…</p>
        </div>
    );
}

function PrivateRoute({ children }) {
    const { user, loading } = useAuth();
    if (loading) return <Spinner />;
    return user ? children : <Navigate to="/login" replace />;
}

/**
 * Where "home" is depends on who you are. Admins land on the fleet view;
 * regular users have no access to it, so they land on their own overview
 * (slot, quota, projects). Everything that used to point at /overview points
 * here instead — sending admins to /overview and bouncing them onward would
 * flash the wrong page, and pointing everyone at /systems would bounce a
 * regular user back into a redirect loop.
 */
/** /overview: admins are sent to the fleet view, everyone else sees the page. */
function OverviewHome() {
    const { user, loading } = useAuth();
    if (loading) return <Spinner />;
    if (user?.role === "admin") return <Navigate to="/systems" replace />;
    return <OverviewPage />;
}

function Home() {
    const { user, loading } = useAuth();
    if (loading) return <Spinner />;
    if (!user) return <Navigate to="/login" replace />;
    return <Navigate to={user.role === "admin" ? "/systems" : "/overview"} replace />;
}

function AdminRoute({ children }) {
    const { user, loading } = useAuth();
    if (loading) return <Spinner />;
    if (!user) return <Navigate to="/login" replace />;
    if (user.role !== "admin") return <Navigate to="/overview" replace />;
    return children;
}

export default function App() {
    return (
        <AuthProvider>
            <NodeProvider>
            <DataProvider>
                <BrowserRouter>
                    <Routes>
                        <Route path="/login" element={<Login />} />
                        <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
                            <Route index element={<Home />} />
                            {/* Admins get the fleet view; the overview page exists for
                                regular users, whose slot and quota live only here. */}
                            <Route path="overview"      element={<OverviewHome />} />
                            <Route path="bots"          element={<Dashboard />} />
                            <Route path="bots/:id"      element={<BotDetail />} />
                            <Route path="sites"         element={<SitesPage />} />
                            <Route path="sites/:id"     element={<BotDetail />} />
                            <Route path="domains"       element={<DomainsPage />} />
                            <Route path="groups"        element={<GroupsPage />} />
                            <Route path="multi-manage"  element={<MultiManage />} />
                            <Route path="tags"          element={<TagsPage />} />
                            {/* Admin-only routes */}
                            <Route path="panel-manage"  element={<AdminRoute><PanelManage /></AdminRoute>} />
                            <Route path="proxy"         element={<AdminRoute><ProxyPage /></AdminRoute>} />
                            <Route path="systems"      element={<AdminRoute><SystemsPage /></AdminRoute>} />
                            {/* /system was the single-node monitor; /systems + a node's
                                Metrics tab replace it. Redirect so old links still land. */}
                            <Route path="system"        element={<Navigate to="/systems" replace />} />
                            <Route path="terminal"      element={<AdminRoute><TerminalPage /></AdminRoute>} />
                            {/* The node list lived here; /systems shows the same fleet with
                                live metrics, and each node's own page manages it. */}
                            <Route path="nodes"         element={<Navigate to="/systems" replace />} />
                            <Route path="nodes/:id"     element={<AdminRoute><NodeDetailPage /></AdminRoute>} />
                            <Route path="admin/users"   element={<AdminRoute><AdminUsersPage /></AdminRoute>} />
                            <Route path="orders"        element={<AdminRoute><OrdersPage /></AdminRoute>} />
                            <Route path="decors"        element={<AdminRoute><DecorsPage /></AdminRoute>} />
                            <Route path="quests"        element={<AdminRoute><QuestsPage /></AdminRoute>} />
                            <Route path="quests/:accountId" element={<AdminRoute><QuestAccountDetail /></AdminRoute>} />
                            {/* Legacy redirect */}
                            <Route path="dashboard"     element={<Navigate to="/bots" replace />} />
                        </Route>
                        <Route path="*" element={<Home />} />
                    </Routes>
                </BrowserRouter>
            </DataProvider>
            </NodeProvider>
        </AuthProvider>
    );
}
