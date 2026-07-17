import { createContext, useContext, useState, useEffect, useCallback } from "react";
import api from "../api/client";
import { useAuth } from "./AuthContext";
import { useNode } from "./NodeContext";

const DataContext = createContext(null);

export function DataProvider({ children }) {
    const { user, isAdmin } = useAuth();
    const { nodeId } = useNode();
    const [bots, setBots] = useState([]);
    const [groups, setGroups] = useState([]);
    const [tags, setTags] = useState([]);
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);

    const fetchBots = useCallback(async () => {
        if (!user) return;
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
    }, [user, nodeId]);

    const fetchStats = useCallback(async () => {
        if (!user || !isAdmin) return; // system stats are admin-only
        try {
            const res = await api.get("/system/stats");
            setStats(res.data);
        } catch {}
    }, [user, isAdmin, nodeId]);

    useEffect(() => {
        if (user) {
            // Node switch: show loading and drop the previous node's stats so
            // stale data never flashes as the newly selected node's.
            setLoading(true);
            setStats(null);
            fetchBots();
            fetchStats();
            const botInterval   = setInterval(fetchBots,  10000);
            const statsInterval = isAdmin ? setInterval(fetchStats, 5000) : null;
            return () => {
                clearInterval(botInterval);
                if (statsInterval) clearInterval(statsInterval);
            };
        } else {
            setBots([]);
            setGroups([]);
            setTags([]);
            setStats(null);
            setLoading(true);
        }
    }, [user, isAdmin, fetchBots, fetchStats]);

    return (
        <DataContext.Provider value={{ bots, groups, tags, stats, loading, refresh: fetchBots }}>
            {children}
        </DataContext.Provider>
    );
}

export const useData = () => useContext(DataContext);
