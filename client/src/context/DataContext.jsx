import { createContext, useContext, useState, useEffect, useCallback } from "react";
import api from "../api/client";
import { useAuth } from "./AuthContext";

const DataContext = createContext(null);

// Bots, groups, tags and the panel host's stats — the owner's pages only.
// Staff can't read any of it (owner-only routes), so nothing is fetched for them.
export function DataProvider({ children }) {
    const { user } = useAuth();
    const owner = user?.kind === "owner";
    const [bots, setBots] = useState([]);
    const [groups, setGroups] = useState([]);
    const [tags, setTags] = useState([]);
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);

    const fetchBots = useCallback(async () => {
        if (!owner) return;
        try {
            const [botsRes, groupsRes, tagsRes] = await Promise.allSettled([
                api.get("/bots"),
                api.get("/groups"),
                api.get("/tags"),
            ]);
            if (botsRes.status === "fulfilled") setBots(botsRes.value.data);
            if (groupsRes.status === "fulfilled") setGroups(groupsRes.value.data);
            if (tagsRes.status === "fulfilled") setTags(tagsRes.value.data);
        } catch (err) {
            console.error("Data fetch error:", err);
        } finally {
            setLoading(false);
        }
    }, [owner]);

    // Stats of the machine the panel runs on — the server defaults to
    // PANEL_NODE_ID when no node is named. Per-node figures live on /systems.
    const fetchStats = useCallback(async () => {
        if (!owner) return;
        try {
            const res = await api.get("/system/stats");
            setStats(res.data);
        } catch {}
    }, [owner]);

    useEffect(() => {
        if (owner) {
            setLoading(true);
            fetchBots();
            fetchStats();
            const botInterval   = setInterval(fetchBots,  10000);
            const statsInterval = setInterval(fetchStats, 5000);
            return () => {
                clearInterval(botInterval);
                clearInterval(statsInterval);
            };
        } else {
            setBots([]);
            setGroups([]);
            setTags([]);
            setStats(null);
            setLoading(true);
        }
    }, [owner, fetchBots, fetchStats]);

    return (
        <DataContext.Provider value={{ bots, groups, tags, stats, loading, refresh: fetchBots }}>
            {children}
        </DataContext.Provider>
    );
}

export const useData = () => useContext(DataContext);
