import { useState, useEffect, useMemo, useRef } from "react";
import { Outlet, NavLink, Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useData } from "../context/DataContext";
import Icon from "./ui/Icon";

// ── Icons ── (the shared set in components/ui/Icon.jsx)
const I = {
    bots:       <Icon name="bots" />,
    sites:      <Icon name="sites" />,
    domains:    <Icon name="domains" />,
    proxy:      <Icon name="proxy" />,
    settings:   <Icon name="settings" />,
    servers:    <Icon name="servers" />,
    key:        <Icon name="key" />,
    proxyPool:  <Icon name="proxyPool" />,
    orders:     <Icon name="orders" />,
    stock:      <Icon name="stock" />,
    voucher:    <Icon name="voucher" />,
    supporters: <Icon name="supporters" />,
    menus:      <Icon name="menus" />,
    decors:     <Icon name="decors" />,
    quests:     <Icon name="quests" />,
    pricing:    <Icon name="pricing" />,
    badges:     <Icon name="badges" />,
    lavalink:   <Icon name="lavalink" />,
    bell:       <Icon name="bell" />,
    terminal:   <Icon name="terminal" />,
    logout:     <Icon name="logout" size={15} />,
    chevronL:   <Icon name="chevronLeft" />,
    menu:       <Icon name="menu" size={22} />,
    close:      <Icon name="x" size={14} strokeWidth={2.5} />,
};

// One account, one nav. Everything here is reachable to whoever is logged in.
// The shop comes first: it is what the admin opens every day.
const NAV_SECTIONS = [
    {
        id: "shop",
        label: "Shop",
        items: [
            { to: "/orders",       label: "Orders",       icon: I.orders },
            { to: "/stock",        label: "Stock",        icon: I.stock },
            { to: "/vouchers",     label: "Vouchers",     icon: I.voucher },
            { to: "/ticket-menus", label: "Ticket Menus", icon: I.menus },
            { to: "/supporters",   label: "Supporters",   icon: I.supporters },
        ],
    },
    {
        id: "auto",
        label: "Auto Services",
        items: [
            { to: "/quests",  label: "Auto Quest", icon: I.quests },
            { to: "/badges",  label: "Auto Badge", icon: I.badges },
            { to: "/decors",  label: "Decors",     icon: I.decors },
            { to: "/pricing", label: "Pricing",    icon: I.pricing },
        ],
    },
    {
        id: "infra",
        label: "Infrastructure",
        items: [
            { to: "/systems",  label: "Servers",  icon: I.servers },
            { to: "/bots",     label: "Bots",     icon: I.bots },
            { to: "/sites",    label: "Sites",    icon: I.sites },
            { to: "/lavalink", label: "Lavalink", icon: I.lavalink },
            { to: "/terminal", label: "Terminal", icon: I.terminal },
            { to: "/git-keys", label: "Git Keys", icon: I.key },
        ],
    },
    {
        id: "network",
        label: "Network",
        items: [
            { to: "/domains", label: "Domains",    icon: I.domains },
            // Two different things, deliberately side by side: "Bot Egress" pins a
            // BOT's public IP to a VPS; "Proxy Pool" is the panel's own egress pool.
            { to: "/proxy",   label: "Bot Egress", icon: I.proxy },
            { to: "/proxies", label: "Proxy Pool", icon: I.proxyPool },
        ],
    },
];

// Pinned under the sections, above the account.
const SETTINGS_ITEM = { to: "/panel-manage", label: "Panel Settings", icon: I.settings };

// Header titles come from the nav itself, so a new page cannot be left without one.
const NAV_PAGES = Object.fromEntries([
    ...NAV_SECTIONS.flatMap((s) => s.items.map((it) => [it.to, { section: s.label, title: it.label }])),
    [SETTINGS_ITEM.to, { section: null, title: SETTINGS_ITEM.label }],
]);

// Detail pages, shown under the list they open from.
const DETAIL_PAGES = [
    { prefix: "/bots/",   parent: "/bots",    title: "Bot Detail" },
    { prefix: "/sites/",  parent: "/sites",   title: "Site Detail" },
    { prefix: "/nodes/",  parent: "/systems", title: "Server Detail" },
    { prefix: "/quests/", parent: "/quests",  title: "Quest Account" },
];

const NOTIF_TYPE_COLOR = {
    start: "var(--success)", stop: "var(--warning)", restart: "var(--accent)",
    expired: "var(--danger)", reinstall: "var(--violet)", info: "var(--accent)",
};

/** { section, parent?: { to, title }, title } for the header. */
function getPageHeading(pathname) {
    const page = NAV_PAGES[pathname];
    if (page) return page;
    const detail = DETAIL_PAGES.find((d) => pathname.startsWith(d.prefix));
    if (detail) {
        const parent = NAV_PAGES[detail.parent];
        return { section: parent.section, parent: { to: detail.parent, title: parent.title }, title: detail.title };
    }
    // /panel-manage/<tab> and anything else nested under a nav entry.
    const base = Object.keys(NAV_PAGES).find((to) => pathname.startsWith(`${to}/`));
    return base ? NAV_PAGES[base] : { section: null, title: "NexusPanel" };
}

// Styled by .nav-item in index.css, so hover works without inline state.
function NavItem({ to, icon, label, expanded }) {
    return (
        <NavLink
            to={to}
            title={!expanded ? label : undefined}
            className={({ isActive }) => `nav-item${isActive ? " active" : ""}${expanded ? "" : " collapsed"}`}
        >
            <span className="nav-icon">{icon}</span>
            {expanded && <span>{label}</span>}
        </NavLink>
    );
}

export default function Layout() {
    const { user, logout } = useAuth();
    const { stats } = useData();
    const navigate = useNavigate();
    const location = useLocation();
    const [expanded, setExpanded] = useState(true);
    const [isMobile, setIsMobile] = useState(window.innerWidth < 1024);
    const [notifs, setNotifs] = useState([]);
    const [showNotifs, setShowNotifs] = useState(false);
    const notifRef = useRef(null);

    useEffect(() => {
        const fetchNotifs = () => {
            import("../api/client").then(({ default: api }) => {
                api.get("/notifications").then(r => setNotifs(r.data)).catch(() => {});
            });
        };
        fetchNotifs();
        const int = setInterval(fetchNotifs, 15000);
        return () => clearInterval(int);
    }, []);

    useEffect(() => {
        const handleResize = () => {
            const mobile = window.innerWidth < 1024;
            setIsMobile(mobile);
            if (!mobile) setExpanded(true);
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    useEffect(() => { if (isMobile) setExpanded(false); }, [location.pathname]);

    useEffect(() => {
        const handler = (e) => {
            if (showNotifs && notifRef.current && !notifRef.current.contains(e.target))
                setShowNotifs(false);
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [showNotifs]);

    const handleLogout = () => { logout(); navigate("/login"); };
    const unreadCount = notifs.filter(n => !n.read).length;

    const cpuPct = stats?.cpu?.usagePercent != null ? Math.round(stats.cpu.usagePercent) : null;
    const ramPct = stats?.memory?.usedPercent != null ? Math.round(stats.memory.usedPercent) : null;
    const cpuColor = cpuPct == null ? "var(--text-dim)" : cpuPct > 80 ? "var(--danger)" : cpuPct > 50 ? "var(--warning)" : "var(--success)";
    const ramColor = ramPct == null ? "var(--text-dim)" : ramPct > 85 ? "var(--danger)" : ramPct > 60 ? "var(--warning)" : "var(--info)";

    const heading = useMemo(() => getPageHeading(location.pathname), [location.pathname]);

    const SIDEBAR_W = expanded ? 220 : 56;

    const handleMarkRead = async () => {
        try {
            const { default: api } = await import("../api/client");
            await api.post("/notifications/read");
            setNotifs(prev => prev.map(n => ({ ...n, read: true })));
        } catch {}
    };
    const handleRemoveNotif = async (id) => {
        try {
            const { default: api } = await import("../api/client");
            await api.delete(`/notifications/${id}`);
            setNotifs(prev => prev.filter(n => n._id !== id));
        } catch {}
    };

    return (
        <div style={{ display: "flex", height: "100dvh", overflow: "hidden" }}>

            {/* Mobile overlay */}
            {isMobile && expanded && (
                <div className="fade-in" onClick={() => setExpanded(false)}
                    style={{ position: "fixed", inset: 0, background: "var(--overlay)", zIndex: 40 }} />
            )}

            {/* ── Sidebar ────────────────────────────────────────────── */}
            <aside style={{
                width: isMobile ? 220 : SIDEBAR_W,
                background: "var(--bg-surface)",
                borderRight: "1px solid var(--border)",
                display: "flex", flexDirection: "column", flexShrink: 0,
                transition: "width 0.25s cubic-bezier(0.4,0,0.2,1)",
                overflow: "hidden",
                position: isMobile ? "fixed" : "relative",
                zIndex: isMobile ? 50 : "auto",
                height: isMobile ? "100dvh" : "auto",
                transform: isMobile && !expanded ? "translateX(-100%)" : "translateX(0)",
            }}>
                {/* Brand — same height as the header, so their borders line up */}
                <div style={{
                    padding: expanded ? "0 10px 0 14px" : 0,
                    display: "flex", alignItems: "center", justifyContent: expanded ? "flex-start" : "center",
                    gap: 10, height: 52, flexShrink: 0, borderBottom: "1px solid var(--border)",
                }}>
                    <div
                        onClick={() => !expanded && setExpanded(true)}
                        style={{ width: 24, height: 24, borderRadius: 6, overflow: "hidden", flexShrink: 0, cursor: expanded ? "default" : "pointer" }}
                    >
                        <img src="/logo.png" alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                    </div>
                    {expanded && (
                        <span style={{ flex: 1, fontWeight: 600, fontSize: 14, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden" }}>NexusPanel</span>
                    )}
                    {expanded && (
                        <button onClick={() => setExpanded(false)} title="Collapse" className="btn-ghost" style={{ padding: 4, border: "none", color: "var(--text-dim)" }}>
                            {I.chevronL}
                        </button>
                    )}
                </div>

                {/* Nav sections */}
                <nav style={{ flex: 1, padding: "8px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 0 }} className="no-scrollbar">
                    {NAV_SECTIONS.map((section, si) => (
                        <div key={section.id} style={{ marginBottom: 4 }}>
                            {/* Section label */}
                            {expanded ? (
                                <p style={{ fontSize: 11, fontWeight: 500, color: "var(--text-dim)", padding: "12px 10px 4px", margin: 0 }}>
                                    {section.label}
                                </p>
                            ) : si > 0 ? (
                                <div style={{ height: 1, background: "var(--border)", margin: "8px 8px" }} />
                            ) : null}

                            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                                {section.items.map(item => (
                                    <NavItem key={item.to} {...item} expanded={expanded} />
                                ))}
                            </div>
                        </div>
                    ))}
                </nav>

                {/* Settings, pinned under the scrolling sections */}
                <div style={{ padding: "8px", borderTop: "1px solid var(--border)" }}>
                    <NavItem {...SETTINGS_ITEM} expanded={expanded} />
                </div>

                {/* User footer */}
                <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: expanded ? "flex-start" : "center", gap: 10 }}>
                    <div style={{ width: 26, height: 26, borderRadius: "50%", flexShrink: 0, background: "var(--bg-active)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                        {user?.username?.[0]?.toUpperCase()}
                    </div>
                    {expanded && (
                        <>
                            <div style={{ flex: 1, overflow: "hidden", lineHeight: 1.3 }}>
                                <p style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", margin: 0 }}>{user?.username}</p>
                                <p style={{ fontSize: 11, color: "var(--text-dim)", margin: 0 }}>Admin</p>
                            </div>
                            <button onClick={handleLogout} title="Log out" className="btn-ghost" style={{ padding: 6, border: "none", color: "var(--text-dim)" }}>
                                {I.logout}
                            </button>
                        </>
                    )}
                </div>
            </aside>

            {/* ── Main ───────────────────────────────────────────────── */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

                {/* Header */}
                <header style={{
                    height: 52, flexShrink: 0,
                    background: "var(--bg-base)",
                    borderBottom: "1px solid var(--border)",
                    display: "flex", alignItems: "center", padding: "0 20px", gap: 14,
                    position: "relative", zIndex: 10,
                }}>
                    {isMobile && (
                        <button onClick={() => setExpanded(true)} style={{ background: "none", border: "none", color: "var(--text)", cursor: "pointer", padding: 4, display: "flex" }}>
                            {I.menu}
                        </button>
                    )}

                    <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: 6, overflow: "hidden", whiteSpace: "nowrap", fontSize: 13 }}>
                        {heading.section && (
                            <span className="hide-mobile" style={{ color: "var(--text-dim)", flexShrink: 0 }}>{heading.section} /</span>
                        )}
                        {heading.parent && (
                            <Link to={heading.parent.to} style={{ color: "var(--text-muted)", textDecoration: "none", flexShrink: 0 }}>{heading.parent.title} /</Link>
                        )}
                        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis" }}>{heading.title}</h2>
                    </div>

                    {/* Header chips */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }} ref={notifRef}>
                        {/* The panel's own VPS only — every node is on Servers, where this leads */}
                        {cpuPct != null && (
                            <Link to="/systems" className="hide-mobile" title="CPU and RAM of the VPS that runs the panel — every server is on Servers"
                                style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none", fontSize: 12 }}>
                                <span style={{ color: "var(--text-dim)" }}>Panel host</span>
                                <ResourceChip label="CPU" value={`${cpuPct}%`} color={cpuColor} />
                                {ramPct != null && <ResourceChip label="RAM" value={`${ramPct}%`} color={ramColor} />}
                            </Link>
                        )}

                        {/* Notification bell */}
                        <button className="btn-ghost" title="Notifications" style={{ padding: 6, border: "none", position: "relative" }}
                            onClick={() => { setShowNotifs(!showNotifs); if (!showNotifs && unreadCount > 0) handleMarkRead(); }}>
                            {I.bell}
                            {unreadCount > 0 && (
                                <span style={{ position: "absolute", top: 4, right: 4, width: 7, height: 7, borderRadius: "50%", background: "var(--danger)", border: "2px solid var(--bg-base)" }} />
                            )}
                        </button>

                        {/* Notification dropdown */}
                        {showNotifs && (
                            <div className="card slide-up" style={{
                                position: "absolute", top: "calc(100% + 6px)", right: 16,
                                width: 340, maxHeight: 440, padding: 0, overflowY: "auto",
                                zIndex: 50, boxShadow: "var(--shadow-popover)",
                            }}>
                                <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--bg-card)", position: "sticky", top: 0, zIndex: 2 }}>
                                    <span style={{ fontSize: 13, fontWeight: 600 }}>Notifications</span>
                                    {unreadCount > 0 && <span className="badge" style={{ background: "var(--accent-dim)", color: "var(--accent-hover)" }}>{unreadCount} new</span>}
                                </div>
                                {notifs.length === 0 ? (
                                    <div style={{ padding: "32px 24px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>No notifications</div>
                                ) : (
                                    notifs.map(n => (
                                        <div key={n._id} style={{
                                            padding: "10px 14px", borderBottom: "1px solid var(--border-light)",
                                            display: "flex", gap: 10, alignItems: "flex-start",
                                            background: n.read ? "transparent" : "var(--bg-hover)",
                                        }}>
                                            <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, marginTop: 7, background: NOTIF_TYPE_COLOR[n.type] || "var(--accent)" }} />
                                            <div style={{ flex: 1 }}>
                                                <p style={{ margin: 0, fontSize: 13, color: "var(--text)", lineHeight: 1.4, fontWeight: n.read ? 400 : 500 }}>{n.message}</p>
                                                <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--text-dim)" }}>{new Date(n.createdAt).toLocaleString()}</p>
                                            </div>
                                            <button onClick={(e) => { e.stopPropagation(); handleRemoveNotif(n._id); }}
                                                style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 3, display: "flex", borderRadius: 4 }}>
                                                {I.close}
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>
                        )}
                    </div>
                </header>

                <PanelStateBanner />
                <main style={{ flex: 1, overflowY: "auto", position: "relative" }} className="fade-in">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}

const PANEL_STATE_TEXT = {
    starting: "The panel is starting — changes are briefly paused.",
    maintenance: "The panel is moving to another server — changes are paused for a few minutes. Bots keep running.",
    fenced: "This panel has been replaced by one on another server — nothing here runs any more.",
};

const originOf = (u) => {
    try { return new URL(u).origin; } catch { return null; }
};

/**
 * Shown whenever the panel is not simply "active" (see server/services/lifecycle.js),
 * or when this tab was opened under an address that is no longer the panel's.
 * Reads the public /api/health, so it keeps working while writes are refused.
 */
function PanelStateBanner() {
    const [state, setState] = useState("active");
    const [movedTo, setMovedTo] = useState(null);
    const [url, setUrl] = useState(null);

    useEffect(() => {
        let alive = true;
        const check = () =>
            fetch("/api/health")
                .then((r) => r.json())
                .then((d) => {
                    if (!alive || !d?.state) return;
                    setState(d.state);
                    setMovedTo(d.movedTo || null);
                    setUrl(d.url || null);
                })
                .catch(() => { /* unreachable — keep the last known state */ });
        check();
        const t = setInterval(check, 15_000);
        return () => { alive = false; clearInterval(t); };
    }, []);

    // A tab left open on an old address (before a move or a domain rename):
    // that address now redirects, the browser drops the login on the way, and
    // every change fails without a word. Send the admin to the current one.
    const here = window.location;
    const local = ["localhost", "127.0.0.1"].includes(here.hostname);
    if (state === "active" && url && !local && originOf(url) !== here.origin) {
        const target = originOf(url) + here.pathname + here.search;
        return (
            <div style={{
                padding: "8px 16px", fontSize: 13, fontWeight: 600,
                background: "var(--danger-bg)", color: "var(--danger)",
                borderBottom: "1px solid var(--border)",
            }}>
                The panel now answers at {originOf(url)} — this tab ({here.host}) can no longer save anything.{" "}
                <a href={target} style={{ color: "inherit", textDecoration: "underline" }}>Open it there</a> (you may need to log in again).
            </div>
        );
    }

    if (state === "active") return null;
    const bad = state === "fenced";
    return (
        <div style={{
            padding: "8px 16px", fontSize: 13, fontWeight: 600,
            background: bad ? "var(--danger-bg)" : "var(--warning-bg)",
            color: bad ? "var(--danger)" : "var(--warning)",
            borderBottom: "1px solid var(--border)",
        }}>
            {PANEL_STATE_TEXT[state] || `Panel state: ${state}`}
            {bad && movedTo && <> Open <a href={movedTo} style={{ color: "inherit", textDecoration: "underline" }}>{movedTo}</a>.</>}
        </div>
    );
}

/** "● CPU 23%" — the dot carries the colour, the text stays quiet. */
function ResourceChip({ label, value, color }) {
    return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-muted)" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, display: "inline-block" }} />
            {label} <span style={{ color: "var(--text)" }}>{value}</span>
        </span>
    );
}
