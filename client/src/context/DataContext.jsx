import { createContext, useContext, useState, useEffect, useCallback } from "react";
import api from "../api/client";
import { useAuth } from "./AuthContext";

const DataContext = createContext(null);

export function DataProvider({ children }) {
    const { user } = useAuth();
    const [bots, setBots] = useState([]);
    const [groups, setGroups] = useState([]);
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);

    const fetchAll = useCallback(async () => {
        if (!user) return;
        try {
            const [botsRes, groupsRes, statsRes] = await Promise.allSettled([
                api.get("/bots"),
                api.get("/groups"),
                api.get("/system/stats"),
            ]);
            
            if (botsRes.status === 'fulfilled') setBots(botsRes.value.data);
            if (groupsRes.status === 'fulfilled') setGroups(groupsRes.value.data);
            if (statsRes.status === 'fulfilled') setStats(statsRes.value.data);
        } catch (err) {
            console.error("Data fetch error:", err);
        } finally {
            setLoading(false);
        }
    }, [user]);

    useEffect(() => {
        if (user) {
            fetchAll();
            // Bots and Groups: 10s
            const botInterval = setInterval(fetchAll, 10000);
            // System Stats: 5s (more frequent)
            const statsInterval = setInterval(async () => {
                try {
                    const res = await api.get("/system/stats");
                    setStats(res.data);
                } catch {}
            }, 5000);
            
            return () => {
                clearInterval(botInterval);
                clearInterval(statsInterval);
            };
        } else {
            setBots([]);
            setGroups([]);
            setStats(null);
            setLoading(true);
        }
    }, [user, fetchAll]);

    return (
        <DataContext.Provider value={{ bots, groups, stats, loading, refresh: fetchAll }}>
            {children}
        </DataContext.Provider>
    );
}

export const useData = () => useContext(DataContext);
