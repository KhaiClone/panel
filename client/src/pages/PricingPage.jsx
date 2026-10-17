import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../api/client";
import { usePageAccess } from "../context/AuthContext";
import { DataTable, Field, Notice, PageHeader, StatusBadge, Toggle } from "../components/ui";

// ─────────────────────────────────────────────────────────────────────────────
//  Pricing — the price list of the auto systems.
//
//  Flat prices per tier: each tier has one fixed price that does NOT depend on
//  the tier the customer already has, nor on Nitro. Game Time / Game Variety are
//  sold to Nitro accounts only (the panel reads progress with the customer's own
//  token).
//
//  Each tier's threshold is a Discord value, hard-coded in pricingStore.js and
//  not editable here — this page only sets prices and turns them on or off.
// ─────────────────────────────────────────────────────────────────────────────

const RARITY_COLOR = {
    common: "var(--text-muted)",
    rare: "var(--info)",
    epic: "var(--violet)",
    mythic: "var(--warning)",
};

const unitLabel = (u) => (u === "hours" ? "hours" : u === "house" ? "house" : "games");

// A "choice" badge (HypeSquad) has no threshold — never print NaN.
const fmtUnit = (n, unit) =>
    n === null || n === undefined
        ? "—"
        : `${Number(n).toLocaleString("vi-VN")} ${unitLabel(unit)}`;

// ── Building blocks ──────────────────────────────────────────────────────────

function Card({ children, style }) {
    return (
        <div className="card" style={style}>
            {children}
        </div>
    );
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ── Badge pricing table ──────────────────────────────────────────────────────

function BadgeTable({ badgeKey, badge, drafts, setDraft, onSave, saving }) {
    const { canEdit } = usePageAccess("pricing");
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
                                ? "pick an option · applies instantly"
                                : `${unitLabel(badge.unit)} · shows up in ~1 day`}
                            {badge.requiresNitro ? " · Nitro accounts only" : ""}
                        </span>
                    </div>
                    {!badge.supported && (
                        <div style={{ fontSize: 12, color: "var(--warning)", marginTop: 4 }}>
                            Not supported yet — the /science event stream is not reverse-engineered yet
                        </div>
                    )}
                </div>
                {canEdit && (
                    <button
                        type="button"
                        disabled={!dirty || saving || !badge.supported}
                        onClick={() => onSave(badgeKey)}
                        className={dirty && badge.supported ? "btn-primary" : "btn-ghost"}
                    >
                        {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
                    </button>
                )}
            </div>

            <DataTable
                flush
                minWidth={560}
                columns={["#", "Tier / option", "Threshold", "Rarity", { label: "Price (VND)", width: 150 }, { label: "On sale", width: 70 }]}
            >
                {badge.tiers.map((t, i) => {
                    const d = drafts[t.key] ?? { price: "", enabled: false };
                    const priced = d.price !== "" && Number(d.price) > 0;
                    return (
                        <tr key={t.key}>
                            <td style={{ color: "var(--text-dim)" }}>{i + 1}</td>
                            <td>
                                <div style={{ fontWeight: 500 }}>{t.name}</div>
                                <div className="cell-sub">{t.key}</div>
                            </td>
                            <td style={{ color: "var(--text-muted)" }}>
                                {fmtUnit(t.threshold, badge.unit)}
                            </td>
                            <td>
                                <StatusBadge color={RARITY_COLOR[t.rarityName]}>{capitalize(t.rarityName)}</StatusBadge>
                            </td>
                            <td>
                                <input
                                    className="input"
                                    type="number"
                                    min="0"
                                    step="1000"
                                    placeholder="not set"
                                    value={d.price}
                                    disabled={!badge.supported}
                                    onChange={(e) =>
                                        setDraft(badgeKey, t.key, { price: e.target.value })
                                    }
                                    style={{ padding: "6px 8px", fontSize: 13 }}
                                />
                            </td>
                            <td>
                                <Toggle
                                    checked={d.enabled}
                                    disabled={!priced || !badge.supported}
                                    title={priced ? "" : "Set a price before selling"}
                                    onChange={(v) =>
                                        setDraft(badgeKey, t.key, { enabled: v })
                                    }
                                />
                            </td>
                        </tr>
                    );
                })}
            </DataTable>
        </Card>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PricingPage() {
    const { canEdit } = usePageAccess("pricing");
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
            setToast(`Saved the ${pricing.autoBadge.badges[badgeKey].label} prices`);
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
                overshoot: Number(settings.overshoot),
                forfeitOnWrongTier: settings.forfeitOnWrongTier,
            });
            hydrate(data);
            setToast("Settings saved");
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
            setToast("Saved the other systems' prices");
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setSaving("");
        }
    };

    if (!pricing || !settings) {
        return (
            <div className="page" style={{ color: "var(--text-muted)" }}>
                {error ? <Notice tone="danger">{error}</Notice> : "Loading…"}
            </div>
        );
    }

    const sellable = Object.values(pricing.autoBadge.badges).reduce(
        (n, b) => n + b.tiers.filter((t) => t.enabled).length,
        0,
    );

    return (
        <div className="page fade-in" style={{ maxWidth: 1100 }}>
            <div style={{ marginBottom: 20 }}>
                <PageHeader
                    title="Pricing"
                    description="Flat prices per tier — each tier has one fixed price, whatever tier the buyer is on now. Thresholds are Discord's numbers and cannot be changed here."
                />
            </div>

            {error && (
                <div style={{ marginBottom: 16 }}>
                    <Notice tone="danger">{error}</Notice>
                </div>
            )}
            {toast && (
                <div style={{ marginBottom: 16 }}>
                    <Notice tone="success">{toast}</Notice>
                </div>
            )}

            {/* View-only staff: every field and switch below is read-only. */}
            <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            {/* ── General settings ── */}
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
                            {sellable} tier(s) on sale
                        </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                            {settings.enabled ? "Selling" : "Off"}
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
                    <Field label="Overshoot multiplier" hint="Makes up for the ~94% credit rate of /science. 1.1 = send 10% extra.">
                        <input
                            type="number"
                            min="1"
                            step="0.05"
                            value={settings.overshoot}
                            onChange={(e) => setSettings((s) => ({ ...s, overshoot: e.target.value }))}
                            className="input"
                        />
                    </Field>
                    <Field label="Forfeit on an owned tier" hint="Checked after payment: if the account already reached the tier, the payment is kept.">
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

                {canEdit && (
                    <button
                        type="button"
                        onClick={saveSettings}
                        disabled={saving === "settings"}
                        className="btn-primary"
                    >
                        {saving === "settings" ? "Saving…" : "Save settings"}
                    </button>
                )}
            </Card>

            {/* ── Price table per badge ── */}
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

            {/* ── Other auto systems ── */}
            <Card>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Other systems</div>
                <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 14 }}>
                    ArnTo-Auto reads these prices from /api/external/pricing and caches them for 60 seconds. If the
                    panel is down the bot uses the cached prices, then the ones in .env — so a change here needs no
                    bot restart.
                </div>
                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
                        gap: 14,
                        marginBottom: 14,
                    }}
                >
                    <Field label="Auto Quest — per quest">
                        <input
                            type="number"
                            min="0"
                            step="500"
                            value={others.questPricePerItem}
                            onChange={(e) =>
                                setOthers((o) => ({ ...o, questPricePerItem: e.target.value }))
                            }
                            className="input"
                        />
                    </Field>
                    <Field label="Auto Quest — monthly plan">
                        <input
                            type="number"
                            min="0"
                            step="5000"
                            value={others.questMonthlyPrice}
                            onChange={(e) =>
                                setOthers((o) => ({ ...o, questMonthlyPrice: e.target.value }))
                            }
                            className="input"
                        />
                    </Field>
                </div>

                {canEdit && (
                    <button
                        type="button"
                        onClick={saveOthers}
                        disabled={saving === "others"}
                        className="btn-primary"
                    >
                        {saving === "others" ? "Saving…" : "Save prices"}
                    </button>
                )}
            </Card>
            </fieldset>
        </div>
    );
}
