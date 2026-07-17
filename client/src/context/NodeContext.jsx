import { createContext, useContext, useState, useEffect, useCallback } from "react";
import api from "../api/client";
import { useAuth } from "./AuthContext";

// Global "remote view" node selection. The chosen node id is persisted to
// localStorage (bp_selected_node) where the axios interceptor picks it up and
// stamps X-Panel-Node on every request — the server then scopes bot lists and
// system stats to that node. Admin-only: /api/nodes is admin-only and the
// server ignores the header for regular users anyway.

const STORAGE_KEY = "bp_selected_node";

const NodeContext = createContext(null);

export function NodeProvider({ children }) {
    const { user, isAdmin } = useAuth();
    const [nodeId, setNodeId] = useState(() =>
        localStorage.getItem(STORAGE_KEY) || "local",
    );
    const [nodes, setNodes] = useState([]); // from GET /nodes — "local" entry first

    // Non-admins (and logged-out sessions) are always pinned to local
    useEffect(() => {
        if (user && !isAdmin) {
            localStorage.removeItem(STORAGE_KEY);
            setNodeId("local");
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

    // If the selected node disappears from the registry, fall back to local
    useEffect(() => {
        if (nodeId !== "local" && nodes.length > 0 && !nodes.some((n) => n._id === nodeId)) {
            localStorage.removeItem(STORAGE_KEY);
            setNodeId("local");
        }
    }, [nodes, nodeId]);

    const setNode = useCallback((id) => {
        if (!id || id === "local") localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, id);
        setNodeId(id || "local");
    }, []);

    const selectedNode = nodes.find((n) => n._id === nodeId) || null;

    return (
        <NodeContext.Provider
            value={{
                nodeId,
                setNode,
                nodes,
                selectedNode,
                isRemote: nodeId !== "local",
                nodeStatus: selectedNode?.status ?? "online",
            }}
        >
            {children}
        </NodeContext.Provider>
    );
}

export const useNode = () => useContext(NodeContext);
