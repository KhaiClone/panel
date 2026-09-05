import { createContext, useContext, useState, useEffect, useCallback } from "react";
import api from "../api/client";
import { useAuth } from "./AuthContext";

// Global node selection. The chosen node id is persisted to localStorage
// (bp_selected_node) where the axios interceptor picks it up and stamps
// X-Panel-Node on every request; the server then scopes bot lists and system
// stats to that node. Admin-only: /api/nodes is admin-only and the server
// ignores the header for regular users anyway.
//
// Every node is equal now — there is no "local" entry. A browser may still hold
// the pre-split value "local" in localStorage, so it is discarded on read and
// the panel's own node is selected instead. Without that, the old value would
// match no node and the switcher would sit on an id that does not exist.

const STORAGE_KEY = "bp_selected_node";
const LEGACY_LOCAL = "local";

const readStored = () => {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        return v && v !== LEGACY_LOCAL ? v : null;
    } catch {
        return null; // private mode / storage disabled
    }
};

const NodeContext = createContext(null);

export function NodeProvider({ children }) {
    const { user, isAdmin } = useAuth();
    const [nodeId, setNodeId] = useState(readStored);
    const [nodes, setNodes] = useState([]); // from GET /nodes — panel's own node first

    // Non-admins (and logged-out sessions) never scope the view
    useEffect(() => {
        if (user && !isAdmin) {
            try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
            setNodeId(null);
        }
    }, [user, isAdmin]);

    // Node list + status poll (drives the switcher options and offline banner)
    useEffect(() => {
        if (!user || !isAdmin) {
            setNodes([]);
            return;
        }
        const fetchNodes = () => api.get("/nodes").then((r) => setNodes(r.data)).catch(() => {});
        fetchNodes();
        const int = setInterval(fetchNodes, 30_000);
        return () => clearInterval(int);
    }, [user, isAdmin]);

    // Settle the selection once the node list arrives: an unknown or missing id
    // falls back to the panel's own node, then to the first node in the list.
    useEffect(() => {
        if (!nodes.length) return;
        if (nodeId && nodes.some((n) => n._id === nodeId)) return;

        const fallback = nodes.find((n) => n.isPanelNode) || nodes[0];
        try {
            if (fallback) localStorage.setItem(STORAGE_KEY, fallback._id);
        } catch { /* ignore */ }
        setNodeId(fallback ? fallback._id : null);
    }, [nodes, nodeId]);

    const setNode = useCallback((id) => {
        const next = id && id !== LEGACY_LOCAL ? id : null;
        try {
            if (next) localStorage.setItem(STORAGE_KEY, next);
            else localStorage.removeItem(STORAGE_KEY);
        } catch { /* ignore */ }
        setNodeId(next);
    }, []);

    const selectedNode = nodes.find((n) => n._id === nodeId) || null;

    return (
        <NodeContext.Provider
            value={{
                nodeId,
                setNode,
                nodes,
                selectedNode,
                // True while viewing a node other than the one the panel runs on.
                isRemote: !!selectedNode && !selectedNode.isPanelNode,
                nodeStatus: selectedNode?.status ?? "unknown",
            }}
        >
            {children}
        </NodeContext.Provider>
    );
}

export const useNode = () => useContext(NodeContext);
