import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { DataProvider } from "./context/DataContext";
import Login from "./pages/Login";
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
import ProxiesPage from "./pages/ProxiesPage";
import TagsPage from "./pages/TagsPage";
import NodeDetailPage from "./pages/NodeDetailPage";
import OrdersPage from "./pages/OrdersPage";
import DecorsPage from "./pages/DecorsPage";
import QuestsPage from "./pages/QuestsPage";
import PricingPage from "./pages/PricingPage";
import BadgesPage from "./pages/BadgesPage";
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

/**
 * The panel has one account, so there is exactly one gate: logged in or not.
 * No roles, no per-route guards, no separate landing page — home is the fleet view.
 */
function PrivateRoute({ children }) {
    const { user, loading } = useAuth();
    if (loading) return <Spinner />;
    return user ? children : <Navigate to="/login" replace />;
}

export default function App() {
    return (
        <AuthProvider>
            <DataProvider>
                <BrowserRouter>
                    <Routes>
                        <Route path="/login" element={<Login />} />
                        <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
                            <Route index element={<Navigate to="/systems" replace />} />
                            <Route path="bots"          element={<Dashboard />} />
                            <Route path="bots/:id"      element={<BotDetail />} />
                            <Route path="sites"         element={<SitesPage />} />
                            <Route path="sites/:id"     element={<BotDetail />} />
                            <Route path="domains"       element={<DomainsPage />} />
                            <Route path="groups"        element={<GroupsPage />} />
                            <Route path="multi-manage"  element={<MultiManage />} />
                            <Route path="tags"          element={<TagsPage />} />
                            <Route path="panel-manage"  element={<PanelManage />} />
                            <Route path="proxy"         element={<ProxyPage />} />
                            {/* /proxy pins a bot's IP to a VPS; /proxies is the panel's own egress pool. */}
                            <Route path="proxies"       element={<ProxiesPage />} />
                            <Route path="systems"       element={<SystemsPage />} />
                            {/* /system was the single-node monitor; /systems + a node's
                                Metrics tab replace it. Redirect so old links still land. */}
                            <Route path="system"        element={<Navigate to="/systems" replace />} />
                            <Route path="terminal"      element={<TerminalPage />} />
                            {/* The node list lived here; /systems shows the same fleet with
                                live metrics, and each node's own page manages it. */}
                            <Route path="nodes"         element={<Navigate to="/systems" replace />} />
                            <Route path="nodes/:id"     element={<NodeDetailPage />} />
                            <Route path="orders"        element={<OrdersPage />} />
                            <Route path="decors"        element={<DecorsPage />} />
                            <Route path="quests"        element={<QuestsPage />} />
                            <Route path="pricing"       element={<PricingPage />} />
                            <Route path="badges"        element={<BadgesPage />} />
                            <Route path="quests/:accountId" element={<QuestAccountDetail />} />
                            {/* Legacy redirects — /overview and /admin/users are gone
                                along with the multi-user panel. */}
                            <Route path="dashboard"     element={<Navigate to="/bots" replace />} />
                            <Route path="overview"      element={<Navigate to="/systems" replace />} />
                            <Route path="admin/users"   element={<Navigate to="/systems" replace />} />
                        </Route>
                        <Route path="*" element={<Navigate to="/systems" replace />} />
                    </Routes>
                </BrowserRouter>
            </DataProvider>
        </AuthProvider>
    );
}
