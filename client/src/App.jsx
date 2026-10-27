import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { pageForPath, homeFor } from "./context/access";
import { DataProvider } from "./context/DataContext";
import Login from "./pages/Login";
import DiscordCallback from "./pages/DiscordCallback";
import NoAccess from "./pages/NoAccess";
import SystemsPage from "./pages/SystemsPage";
import Dashboard from "./pages/Dashboard";
import SitesPage from "./pages/SitesPage";
import DomainsPage from "./pages/DomainsPage";
import BotDetail from "./pages/BotDetail";
import PanelManage from "./pages/PanelManage";
import GitKeysPage from "./pages/GitKeysPage";
import TerminalPage from "./pages/TerminalPage";
import ProxyPage from "./pages/ProxyPage";
import ProxiesPage from "./pages/ProxiesPage";
import NodeDetailPage from "./pages/NodeDetailPage";
import OrdersPage from "./pages/OrdersPage";
import StockPage from "./pages/StockPage";
import VouchersPage from "./pages/VouchersPage";
import SupportersPage from "./pages/SupportersPage";
import ResellersPage from "./pages/ResellersPage";
import TicketMenusPage from "./pages/TicketMenusPage";
import FormsPage from "./pages/FormsPage";
import MessagesPage from "./pages/MessagesPage";
import WebhooksPage from "./pages/WebhooksPage";
import DecorsPage from "./pages/DecorsPage";
import QuestsPage from "./pages/QuestsPage";
import PricingPage from "./pages/PricingPage";
import BadgesPage from "./pages/BadgesPage";
import LavalinkPage from "./pages/LavalinkPage";
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
 * Logged in, and allowed here. The owner goes everywhere. Staff only reach the
 * pages they were given (context/access.js): any other URL — Servers, Bots,
 * Terminal, Settings… — sends them to their first page. The server enforces
 * the same thing on every request; this only keeps them off dead ends.
 */
function PrivateRoute({ children }) {
    const { user, loading } = useAuth();
    const { pathname } = useLocation();
    if (loading) return <Spinner />;
    if (!user) return <Navigate to="/login" replace />;
    if (user.kind === "staff") {
        const page = pageForPath(pathname);
        if (!page || !user.perms[page]) return <Navigate to={homeFor(user)} replace />;
    }
    return children;
}

/** Signed in, but no page given yet (staff). */
function SignedIn({ children }) {
    const { user, loading } = useAuth();
    if (loading) return <Spinner />;
    if (!user) return <Navigate to="/login" replace />;
    if (user.kind === "owner" || homeFor(user) !== "/no-access") return <Navigate to={homeFor(user)} replace />;
    return children;
}

export default function App() {
    return (
        <AuthProvider>
            <DataProvider>
                <BrowserRouter>
                    <Routes>
                        <Route path="/login" element={<Login />} />
                        {/* Discord → the launcher → here, with ?code&state (staff sign-in). */}
                        <Route path="/auth/discord/callback" element={<DiscordCallback />} />
                        <Route path="/no-access" element={<SignedIn><NoAccess /></SignedIn>} />
                        <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
                            <Route index element={<Navigate to="/systems" replace />} />
                            <Route path="bots"          element={<Dashboard />} />
                            <Route path="bots/:id"      element={<BotDetail />} />
                            <Route path="sites"         element={<SitesPage />} />
                            <Route path="sites/:id"     element={<BotDetail />} />
                            <Route path="domains"       element={<DomainsPage />} />
                            {/* Groups, Tags and Bulk Ops are part of the Bots page now:
                                its Groups and Tags tabs, and its select mode. */}
                            <Route path="groups"        element={<Navigate to="/bots?view=groups" replace />} />
                            <Route path="tags"          element={<Navigate to="/bots?view=tags" replace />} />
                            <Route path="multi-manage"  element={<Navigate to="/bots?select=1" replace />} />
                            {/* Panel Settings has one URL per tab; the bare path opens Overview. */}
                            <Route path="panel-manage"  element={<Navigate to="/panel-manage/overview" replace />} />
                            <Route path="panel-manage/:tab" element={<PanelManage />} />
                            <Route path="git-keys"      element={<GitKeysPage />} />
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
                            <Route path="stock"         element={<StockPage />} />
                            <Route path="vouchers"      element={<VouchersPage />} />
                            <Route path="supporters"    element={<SupportersPage />} />
                            <Route path="resellers"     element={<ResellersPage />} />
                            <Route path="ticket-menus"  element={<TicketMenusPage />} />
                            <Route path="forms"         element={<FormsPage />} />
                            <Route path="messages"      element={<MessagesPage />} />
                            <Route path="webhooks"      element={<WebhooksPage />} />
                            <Route path="decors"        element={<DecorsPage />} />
                            <Route path="quests"        element={<QuestsPage />} />
                            <Route path="pricing"       element={<PricingPage />} />
                            <Route path="badges"        element={<BadgesPage />} />
                            <Route path="lavalink"      element={<LavalinkPage />} />
                            <Route path="quests/:accountId" element={<QuestAccountDetail />} />
                            {/* Legacy redirects — /overview and /admin/users are gone
                                along with the old multi-user panel (staff are Panel
                                Settings → Staff now). */}
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
