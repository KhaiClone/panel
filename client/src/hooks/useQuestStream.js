import { useState, useEffect, useCallback } from "react";
import api from "../api/client";

/**
 * Shared quest realtime state: the account list + per-account live quest progress
 * (with media), kept in sync via the /api/quests/stream SSE. Used by both the
 * overview and the account-detail pages.
 */
export default function useQuestStream() {
    const [accounts, setAccounts] = useState([]);
    const [live, setLive] = useState({}); // accountId -> { [questId]: {...media, percent, state} }

    const mergeLive = (list) =>
        setLive((prev) => {
            const n = { ...prev };
            for (const a of list || [])
                n[a.accountId] = { ...(n[a.accountId] || {}), ...(a.quests || {}) };
            return n;
        });

    const reload = useCallback(async () => {
        try {
            const { data } = await api.get("/quests");
            setAccounts(data);
            mergeLive(data);
        } catch {}
    }, []);

    useEffect(() => {
        reload();
    }, [reload]);

    useEffect(() => {
        const tok = localStorage.getItem("token");
        if (!tok) return;
        const es = new EventSource(`/api/quests/stream?token=${encodeURIComponent(tok)}`);
        es.onmessage = (e) => {
            let evt;
            try {
                evt = JSON.parse(e.data);
            } catch {
                return;
            }
            if (evt.type === "snapshot") {
                setAccounts(evt.accounts || []);
                mergeLive(evt.accounts || []);
                return;
            }
            const aid = evt.accountId;
            if (evt.type === "status") {
                setAccounts((prev) =>
                    prev.map((a) =>
                        a.accountId === aid
                            ? { ...a, status: evt.status, error: evt.error ?? a.error, running: evt.status === "running" }
                            : a,
                    ),
                );
            } else if (evt.type === "removed") {
                setAccounts((prev) => prev.filter((a) => a.accountId !== aid));
                setLive((prev) => {
                    const n = { ...prev };
                    delete n[aid];
                    return n;
                });
            } else if (["quest_start", "quest_progress", "quest_done"].includes(evt.type)) {
                setLive((prev) => {
                    const acc = { ...(prev[aid] || {}) };
                    const q = { ...(acc[evt.questId] || {}) };
                    if (evt.name) q.name = evt.name;
                    if (evt.taskType) q.taskType = evt.taskType;
                    if (evt.needed != null) q.needed = evt.needed;
                    if (evt.done != null) q.done = evt.done;
                    if (evt.percent != null) q.percent = evt.percent;
                    if (evt.media) q.media = evt.media;
                    q.state = evt.type === "quest_done" ? "done" : "running";
                    if (evt.type === "quest_done") q.percent = 100;
                    acc[evt.questId] = q;
                    return { ...prev, [aid]: acc };
                });
            }
        };
        es.onerror = () => {};
        return () => es.close();
    }, []);

    return { accounts, live, reload, setAccounts };
}
