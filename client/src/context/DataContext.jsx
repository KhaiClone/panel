import { createContext, useContext, useState, useEffect, useCallback } from "react";
import api from "../api/client";
import { useAuth } from "./AuthContext";

const DataContext = createContext(null);

export function DataProvider({ children }) {
    const { user } = useAuth();
    const [bots, setBots] = useState([]);
    const [groups, setGroups] = useState([]);
    const [loading, setLoading] = useState(true);

    const fetchAll = useCallback(async () => {
        if (!user) return;
        try {
            const [botsRes, groupsRes] = await Promise.all([
                api.get("/bots"),
                api.get("/groups"),
            ]);
            setBots(botsRes.data);
            setGroups(groupsRes.data);
        } catch (err) {
            console.error("Data fetch error:", err);
        } finally {
            setLoading(false);
        }
    }, [user]);

    useEffect(() => {
        if (user) {
            fetchAll();
            const interval = setInterval(fetchAll, 10000);
            return () => clearInterval(interval);
        } else {
            setBots([]);
            setGroups([]);
            setLoading(true);
        }
    }, [user, fetchAll]);

    return (
        <DataContext.Provider value={{ bots, groups, loading, refresh: fetchAll }}>
            {children}
        </DataContext.Provider>
    );
}

export const useData = () => useContext(DataContext);
