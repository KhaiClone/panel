import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../api/client";

// ─────────────────────────────────────────────────────────────────────────────
//  Pricing — bảng giá của các hệ thống auto.
//
//  Giá phẳng theo mốc: mỗi mốc một giá cố định, KHÔNG phụ thuộc mốc khách đang
//  có. Chỉ hệ số non-Nitro làm đổi con số cuối cùng.
//
//  Ngưỡng của từng mốc là thông số Discord, nằm cứng trong pricingStore.js và
//  không sửa được ở đây — trang này chỉ đặt giá và bật/tắt.
// ─────────────────────────────────────────────────────────────────────────────

const RARITY_COLOR = {
    common: "var(--text-muted)",
    rare: "#3b82f6",
    epic: "#a855f7",
    mythic: "#f59e0b",
};

const UNIT_VI = (u) => (u === "hours" ? "giờ" : u === "house" ? "nhà" : "game");

// Badge "choice" (HypeSquad) không có ngưỡng — đừng in ra NaN.
const fmtUnit = (n, unit) =>
    n === null || n === undefined
        ? "—"
        : `${Number(n).toLocaleString("vi-VN")} ${UNIT_VI(unit)}`;

// ── Building blocks ──────────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled, title }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            title={title}
            onClick={() => onChange(!checked)}
            style={{
                width: 40,
                height: 22,
                borderRadius: 999,
                border: "1px solid var(--border)",
                background: checked ? "var(--accent)" : "var(--bg-input)",
                position: "relative",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.4 : 1,
                transition: "background 0.15s",
                flexShrink: 0,
            }}
        >
            <span
                style={{
                    position: "absolute",
                    top: 2,
                    left: checked ? 20 : 2,
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    background: "#fff",
                    transition: "left 0.15s",
                }}
            />
        </button>
    );
}

function Card({ children, style }) {
    return (
        <div
            style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: 20,
                backdropFilter: "var(--glass-blur)",
                ...style,
            }}
        >
            {children}
        </div>
    );
}

function Field({ label, hint, children }) {
    return (
        <label style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</span>
            {children}
            {hint && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{hint}</span>}
        </label>
    );
}

const inputStyle = {
    background: "var(--bg-input)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "8px 10px",
    color: "var(--text)",
    fontSize: 13,
    outline: "none",
    width: "100%",
};

// ── Badge pricing table ──────────────────────────────────────────────────────

function BadgeTable({ badgeKey, badge, drafts, setDraft, onSave, saving }) {
    const dirty = useMemo(
        () =>
            badge.tiers.some((t) => {
                const d = drafts[t.key];
                if (!d) return false;
                const priceNow = t.price === null ? "" : String(t.price);
                return d.price !== priceNow || d.enabled !== t.enabled;
            }),
        [badge.tiers, drafts],
    );

    return (
        <Card style={{ marginBottom: 20, opacity: badge.supported ? 1 : 0.55 }}>
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    marginBottom: 16,
                    flexWrap: "wrap",
                }}
            >
                <div>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>
                        {badge.label}
                        <span style={{ color: "var(--text-dim)", fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                            badge_id {badge.badgeId} ·{" "}
                            {badge.kind === "choice"
                                ? "chọn phương án · ăn ngay"
                                : `${UNIT_VI(badge.unit)} · lên sau ~1 ngày`}
                            {badge.usesReader === false ? " · không dùng reader" : ""}
                        </span>
                    </div>
                    {!badge.supported && (
                        <div style={{ fontSize: 12, color: "var(--warning)", marginTop: 4 }}>
                            Chưa hỗ trợ — event stream trên /science chưa reverse xong
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    disabled={!dirty || saving || !badge.supported}
                    onClick={() => onSave(badgeKey)}
                    style={{
                        background: dirty && badge.supported ? "var(--accent)" : "var(--bg-input)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        padding: "8px 16px",
                        color: "var(--text)",
                        fontSize: 13,
                        fontWeight: 500,
                        cursor: dirty && badge.supported && !saving ? "pointer" : "not-allowed",
                        opacity: dirty && badge.supported ? 1 : 0.5,
                    }}
                >
                    {saving ? "Đang lưu…" : dirty ? "Lưu thay đổi" : "Đã lưu"}
                </button>
            </div>

            <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 560 }}>
                    <thead>
                        <tr style={{ color: "var(--text-dim)", fontSize: 11, textAlign: "left" }}>
                            <th style={{ padding: "6px 8px", fontWeight: 500 }}>#</th>
                            <th style={{ padding: "6px 8px", fontWeight: 500 }}>MỐC / LỰA CHỌN</th>
                            <th style={{ padding: "6px 8px", fontWeight: 500 }}>NGƯỠNG</th>
                            <th style={{ padding: "6px 8px", fontWeight: 500 }}>ĐỘ HIẾM</th>
                            <th style={{ padding: "6px 8px", fontWeight: 500, width: 150 }}>GIÁ (VNĐ)</th>
                            <th style={{ padding: "6px 8px", fontWeight: 500, width: 70 }}>BÁN</th>
                        </tr>
                    </thead>
                    <tbody>
                        {badge.tiers.map((t, i) => {
                            const d = drafts[t.key] ?? { price: "", enabled: false };
                            const priced = d.price !== "" && Number(d.price) > 0;
                            return (
                                <tr key={t.key} style={{ borderTop: "1px solid var(--border-light)" }}>
                                    <td style={{ padding: "8px", color: "var(--text-dim)" }}>{i + 1}</td>
                                    <td style={{ padding: "8px" }}>
                                        <div style={{ fontWeight: 500 }}>{t.name}</div>
                                        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t.key}</div>
                                    </td>
                                    <td style={{ padding: "8px", color: "var(--text-muted)" }}>
                                        {fmtUnit(t.threshold, badge.unit)}
                                    </td>
                                    <td style={{ padding: "8px" }}>
                                        <span
                                            style={{
                                                color: RARITY_COLOR[t.rarityName],
                                                fontSize: 11,
                                                textTransform: "uppercase",
                                                letterSpacing: 0.4,
                                            }}
                                        >
                                            {t.rarityName}
                                        </span>
                                    </td>
                                    <td style={{ padding: "8px" }}>
                                        <input
                                            type="number"
                                            min="0"
                                            step="1000"
                                            placeholder="chưa đặt"
                                            value={d.price}
                                            disabled={!badge.supported}
                                            onChange={(e) =>
                                                setDraft(badgeKey, t.key, { price: e.target.value })
                                            }
                                            style={{ ...inputStyle, padding: "6px 8px" }}
                                        />
                                    </td>
                                    <td style={{ padding: "8px" }}>
                                        <Toggle
                                            checked={d.enabled}
                                            disabled={!priced || !badge.supported}
                                            title={priced ? "" : "Nhập giá trước khi bán"}
                                            onChange={(v) =>
                                                setDraft(badgeKey, t.key, { enabled: v })
                                            }
                                        />
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </Card>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PricingPage() {
    const [pricing, setPricing] = useState(null);
    const [drafts, setDrafts] = useState({}); // { [badgeKey]: { [tierKey]: {price, enabled} } }
    const [settings, setSettings] = useState(null);
    const [others, setOthers] = useState({
        questPricePerItem: "",
        questMonthlyPrice: "",
    });
    const [saving, setSaving] = useState("");
    const [error, setError] = useState("");
    const [toast, setToast] = useState("");

    const hydrate = useCallback((data) => {
        setPricing(data);
        const d = {};
        for (const [badgeKey, badge] of Object.entries(data.autoBadge.badges)) {
            d[badgeKey] = {};
            for (const t of badge.tiers) {
                d[badgeKey][t.key] = {
                    price: t.price === null ? "" : String(t.price),
                    enabled: t.enabled,
                };
            }
        }
        setDrafts(d);
        setOthers({
            questPricePerItem: String(data.autoQuest.pricePerItem ?? ""),
            questMonthlyPrice: String(data.autoQuest.monthlyPrice ?? ""),
        });
        setSettings({
            enabled: data.autoBadge.enabled,
            nonNitroSurcharge: String(data.autoBadge.nonNitroSurcharge),
            overshoot: String(data.autoBadge.overshoot),
            forfeitOnWrongTier: data.autoBadge.forfeitOnWrongTier,
        });
    }, []);

    const load = useCallback(async () => {
        try {
            const { data } = await api.get("/pricing");
            hydrate(data);
            setError("");
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        }
    }, [hydrate]);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        if (!toast) return undefined;
        const id = setTimeout(() => setToast(""), 2500);
        return () => clearTimeout(id);
    }, [toast]);

    const setDraft = (badgeKey, tierKey, patch) =>
        setDrafts((prev) => ({
            ...prev,
            [badgeKey]: {
                ...prev[badgeKey],
                [tierKey]: { ...prev[badgeKey][tierKey], ...patch },
            },
        }));

    const saveBadge = async (badgeKey) => {
        setSaving(badgeKey);
        setError("");
        try {
            const tiers = {};
            for (const [tierKey, d] of Object.entries(drafts[badgeKey])) {
                tiers[tierKey] = {
                    price: d.price === "" ? null : Number(d.price),
                    enabled: d.enabled,
                };
            }
            const { data } = await api.post(`/pricing/badge/${badgeKey}/bulk`, { tiers });
            hydrate(data);
            setToast(`Đã lưu giá ${pricing.autoBadge.badges[badgeKey].label}`);
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setSaving("");
        }
    };

    const saveSettings = async () => {
        setSaving("settings");
        setError("");
        try {
            const { data } = await api.patch("/pricing/autoBadge", {
                enabled: settings.enabled,
                nonNitroSurcharge: Number(settings.nonNitroSurcharge),
                overshoot: Number(settings.overshoot),
                forfeitOnWrongTier: settings.forfeitOnWrongTier,
            });
            hydrate(data);
            setToast("Đã lưu cài đặt");
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setSaving("");
        }
    };

    const saveOthers = async () => {
        setSaving("others");
        setError("");
        try {
            const { data } = await api.patch("/pricing/autoQuest", {
                pricePerItem: Number(others.questPricePerItem),
                monthlyPrice: Number(others.questMonthlyPrice),
            });
            hydrate(data);
            setToast("Đã lưu giá các hệ thống khác");
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setSaving("");
        }
    };

    if (!pricing || !settings) {
        return (
            <div style={{ padding: 24, color: "var(--text-muted)" }}>
                {error ? <span style={{ color: "var(--danger)" }}>{error}</span> : "Đang tải…"}
            </div>
        );
    }

    const sellable = Object.values(pricing.autoBadge.badges).reduce(
        (n, b) => n + b.tiers.filter((t) => t.enabled).length,
        0,
    );

    return (
        <div style={{ padding: 24, maxWidth: 1100 }}>
            <div style={{ marginBottom: 20 }}>
                <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Pricing</h1>
                <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "6px 0 0" }}>
                    Giá phẳng theo mốc — mỗi mốc một giá cố định, không phụ thuộc mốc khách đang có.
                    Ngưỡng là thông số của Discord, không sửa được ở đây.
                </p>
            </div>

            {error && (
                <div
                    style={{
                        background: "var(--danger-bg)",
                        border: "1px solid var(--danger-border)",
                        color: "var(--danger)",
                        borderRadius: 8,
                        padding: "10px 14px",
                        fontSize: 13,
                        marginBottom: 16,
                    }}
                >
                    {error}
                </div>
            )}
            {toast && (
                <div
                    style={{
                        background: "var(--success-bg)",
                        border: "1px solid var(--success-border)",
                        color: "var(--success)",
                        borderRadius: 8,
                        padding: "10px 14px",
                        fontSize: 13,
                        marginBottom: 16,
                    }}
                >
                    {toast}
                </div>
            )}

            {/* ── Cài đặt chung ── */}
            <Card style={{ marginBottom: 20 }}>
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 16,
                        gap: 12,
                        flexWrap: "wrap",
                    }}
                >
                    <div>
                        <div style={{ fontSize: 15, fontWeight: 600 }}>Auto Badge</div>
                        <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>
                            {sellable} mốc đang mở bán
                        </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                            {settings.enabled ? "Đang bán" : "Đang tắt"}
                        </span>
                        <Toggle
                            checked={settings.enabled}
                            onChange={(v) => setSettings((s) => ({ ...s, enabled: v }))}
                        />
                    </div>
                </div>

                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
                        gap: 14,
                        marginBottom: 16,
                    }}
                >
                    <Field
                        label="Hệ số khách không Nitro"
                        hint="Giá cuối = giá mốc × hệ số này. 1 = không phụ thu."
                    >
                        <input
                            type="number"
                            min="0.1"
                            step="0.1"
                            value={settings.nonNitroSurcharge}
                            onChange={(e) =>
                                setSettings((s) => ({ ...s, nonNitroSurcharge: e.target.value }))
                            }
                            style={inputStyle}
                        />
                    </Field>
                    <Field label="Hệ số overshoot" hint="Bù tỷ lệ credit ~94% của /science. 1.1 = gửi dư 10%.">
                        <input
                            type="number"
                            min="1"
                            step="0.05"
                            value={settings.overshoot}
                            onChange={(e) => setSettings((s) => ({ ...s, overshoot: e.target.value }))}
                            style={inputStyle}
                        />
                    </Field>
                    <Field label="Khai sai mốc thì mất tiền" hint="Áp dụng cho khách không Nitro khi kiểm tra sau thanh toán.">
                        <div style={{ paddingTop: 4 }}>
                            <Toggle
                                checked={settings.forfeitOnWrongTier}
                                onChange={(v) =>
                                    setSettings((s) => ({ ...s, forfeitOnWrongTier: v }))
                                }
                            />
                        </div>
                    </Field>
                </div>

                <button
                    type="button"
                    onClick={saveSettings}
                    disabled={saving === "settings"}
                    style={{
                        background: "var(--accent)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        padding: "8px 16px",
                        color: "var(--text)",
                        fontSize: 13,
                        fontWeight: 500,
                        cursor: saving === "settings" ? "not-allowed" : "pointer",
                    }}
                >
                    {saving === "settings" ? "Đang lưu…" : "Lưu cài đặt"}
                </button>
            </Card>

            {/* ── Bảng giá từng badge ── */}
            {Object.entries(pricing.autoBadge.badges).map(([badgeKey, badge]) => (
                <BadgeTable
                    key={badgeKey}
                    badgeKey={badgeKey}
                    badge={badge}
                    drafts={drafts[badgeKey] ?? {}}
                    setDraft={setDraft}
                    onSave={saveBadge}
                    saving={saving === badgeKey}
                />
            ))}

            {/* ── Các hệ thống auto khác ── */}
            <Card>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Hệ thống khác</div>
                <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 14 }}>
                    ArnTo-Auto đọc các giá này qua /api/external/pricing và cache 60 giây. Panel sập
                    thì bot dùng giá cache, rồi mới đến giá trong .env — nên sửa ở đây không cần
                    restart bot.
                </div>
                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
                        gap: 14,
                        marginBottom: 14,
                    }}
                >
                    <Field label="Auto Quest — mỗi quest">
                        <input
                            type="number"
                            min="0"
                            step="500"
                            value={others.questPricePerItem}
                            onChange={(e) =>
                                setOthers((o) => ({ ...o, questPricePerItem: e.target.value }))
                            }
                            style={inputStyle}
                        />
                    </Field>
                    <Field label="Auto Quest — gói tháng">
                        <input
                            type="number"
                            min="0"
                            step="5000"
                            value={others.questMonthlyPrice}
                            onChange={(e) =>
                                setOthers((o) => ({ ...o, questMonthlyPrice: e.target.value }))
                            }
                            style={inputStyle}
                        />
                    </Field>
                </div>

                <button
                    type="button"
                    onClick={saveOthers}
                    disabled={saving === "others"}
                    style={{
                        background: "var(--accent)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        padding: "8px 16px",
                        color: "var(--text)",
                        fontSize: 13,
                        fontWeight: 500,
                        cursor: saving === "others" ? "not-allowed" : "pointer",
                    }}
                >
                    {saving === "others" ? "Đang lưu…" : "Lưu giá"}
                </button>
            </Card>
        </div>
    );
}
