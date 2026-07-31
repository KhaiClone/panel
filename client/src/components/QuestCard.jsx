// Discord-style quest card. Renders the quest banner (image/video), logotype,
// publisher + end date, game tile, reward, and optional select checkbox / progress.

const fmtDate = (iso) => {
    try {
        return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    } catch {
        return null;
    }
};
const hexColor = (c) => (typeof c === "string" && c.startsWith("#") ? c : null);

export default function QuestCard({ q, selectable, selected, onToggle, progress }) {
    const m = q.media || {};
    const accent = hexColor(m.colors?.primary) || "#5865f2";
    const orbs = m.reward?.orbs;
    return (
        <div
            style={{
                borderRadius: 14,
                overflow: "hidden",
                border: "1px solid var(--border)",
                background: "var(--bg-card, #16171a)",
            }}
        >
            <div
                style={{
                    position: "relative",
                    aspectRatio: "16 / 6",
                    background: m.heroImage
                        ? `center/cover no-repeat url(${m.heroImage})`
                        : `linear-gradient(135deg, ${accent}, #111)`,
                }}
            >
                {m.heroVideo && (
                    <video
                        src={m.heroVideo}
                        autoPlay
                        muted
                        loop
                        playsInline
                        style={{
                            position: "absolute",
                            inset: 0,
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                        }}
                    />
                )}
                <div
                    style={{
                        position: "absolute",
                        inset: 0,
                        background: "linear-gradient(to top, rgba(0,0,0,.75), rgba(0,0,0,0) 55%)",
                    }}
                />
                {m.logotype && (
                    <img
                        src={m.logotype}
                        alt=""
                        style={{
                            position: "absolute",
                            left: 14,
                            bottom: 12,
                            height: 32,
                            maxWidth: "60%",
                            objectFit: "contain",
                            filter: "drop-shadow(0 2px 5px rgba(0,0,0,.6))",
                        }}
                    />
                )}
            </div>

            <div style={{ padding: 14 }}>
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 12,
                        color: "var(--text-muted)",
                        marginBottom: 12,
                    }}
                >
                    <span>
                        Promoted by{" "}
                        <b style={{ color: "var(--text)" }}>{m.gamePublisher || m.gameTitle || "—"}</b>
                    </span>
                    {m.expiresAt && <span>Ends {fmtDate(m.expiresAt)}</span>}
                </div>

                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    {m.gameTile && (
                        <img
                            src={m.gameTile}
                            alt=""
                            style={{ width: 52, height: 52, borderRadius: 14, objectFit: "cover", flexShrink: 0 }}
                        />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 10.5, color: "var(--text-dim)", letterSpacing: 0.5 }}>
                            QUEST {(m.gameTitle || q.name || "").toUpperCase()}
                        </div>
                        <div style={{ fontWeight: 700, fontSize: 15 }}>
                            {orbs ? `◈ Earn ${orbs} Orbs` : q.name}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                            {q.taskType || "—"}
                            {q.needed ? ` · ${q.needed}s` : ""}
                        </div>
                    </div>
                    {selectable && (
                        <input
                            type="checkbox"
                            checked={selected}
                            onChange={onToggle}
                            style={{ width: 20, height: 20, flexShrink: 0, cursor: "pointer" }}
                        />
                    )}
                </div>

                {progress && (
                    <div style={{ marginTop: 12 }}>
                        <div style={{ height: 6, borderRadius: 4, background: "var(--border)", overflow: "hidden" }}>
                            <div
                                style={{
                                    height: "100%",
                                    width: `${progress.percent || 0}%`,
                                    background: progress.state === "done" ? "#22c55e" : accent,
                                    transition: "width .3s",
                                }}
                            />
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                            {progress.state === "done" ? "✅ Completed" : `${progress.percent || 0}%`}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
