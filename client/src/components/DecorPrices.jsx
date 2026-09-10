import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../api/client";

// ─────────────────────────────────────────────────────────────────────────────
//  Decor price table — the assistant's `prices` lookup, edited from the panel.
//
//  A row says "a decor whose Discord price is `original` sells for `price`".
//  Three types:
//    login       — selling an account that already owns the decor
//    gift        — gifting the decor (looked up by the Nitro original price)
//    gift-bundle — gifting a whole bundle; here `original` is the SUM of its
//                  members' gift prices, not a Discord price. That is why
//                  bundles get their own table.
//
//  A missing row makes the decor show 0đ on the shop site, so tiers that decors
//  actually use but have no price are called out at the top.
// ─────────────────────────────────────────────────────────────────────────────

const money = (n) =>
    typeof n === "number" ? n.toLocaleString("vi-VN") + "đ" : "—";

const th = {
    padding: "6px 8px",
    fontWeight: 500,
    textAlign: "left",
    whiteSpace: "nowrap",
};
const td = { padding: "6px 8px", verticalAlign: "middle" };

// Accepts "111000", "111.000", "111,000" — panel users paste all three.
const parseAmount = (raw) => {
    const cleaned = String(raw).replace(/[.,\s]/g, "");
    if (cleaned === "") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
};

/**
 * One editable price cell. Saves on blur or Enter, and only when the value
 * actually changed — so tabbing through the table does not fire writes.
 */
function PriceCell({ type, original, value, onSave, onClear }) {
    const [draft, setDraft] = useState(value === null ? "" : String(value));
    const [state, setState] = useState(null); // "saving" | "saved" | "error"

    useEffect(() => {
        setDraft(value === null ? "" : String(value));
    }, [value]);

    const commit = async () => {
        const parsed = parseAmount(draft);
        if (Number.isNaN(parsed)) {
            setState("error");
            return;
        }
        if (parsed === value) {
            setState(null);
            return;
        }
        setState("saving");
        try {
            if (parsed === null) await onClear(type, original);
            else await onSave(type, original, parsed);
            setState("saved");
            setTimeout(() => setState(null), 1200);
        } catch (err) {
            setState("error");
            alert(
                err.response?.data?.message ||
                    err.response?.data?.error ||
                    "Could not save this price",
            );
        }
    };

    const border =
        state === "error"
            ? "var(--danger)"
            : state === "saved"
              ? "var(--success)"
              : value === null
                ? "var(--warning, #f59e0b)"
                : "var(--border)";

    return (
        <input
            className="input mono"
            inputMode="numeric"
            placeholder="not set"
            value={draft}
            disabled={state === "saving"}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === "Enter") e.target.blur();
                if (e.key === "Escape")
                    setDraft(value === null ? "" : String(value));
            }}
            title="Leave empty to remove this tier"
            style={{
                width: 120,
                padding: "5px 8px",
                fontSize: 12,
                borderColor: border,
            }}
        />
    );
}

function AddTierForm({ onSave }) {
    const [type, setType] = useState("login");
    const [original, setOriginal] = useState("");
    const [price, setPrice] = useState("");
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        const o = parseAmount(original);
        const p = parseAmount(price);
        if (o === null || p === null || Number.isNaN(o) || Number.isNaN(p)) {
            alert("Enter both the original amount and the selling price.");
            return;
        }
        setBusy(true);
        try {
            await onSave(type, o, p);
            setOriginal("");
            setPrice("");
        } catch (err) {
            alert(
                err.response?.data?.message ||
                    err.response?.data?.error ||
                    "Could not add this tier",
            );
        } finally {
            setBusy(false);
        }
    };

    return (
        <div
            style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 8,
                padding: "10px 16px",
                borderTop: "1px solid var(--border-light)",
            }}
        >
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                Add tier
            </span>
            <select
                className="input"
                style={{ width: "auto", padding: "5px 8px", fontSize: 12 }}
                value={type}
                onChange={(e) => setType(e.target.value)}
            >
                <option value="login">login</option>
                <option value="gift">gift</option>
                <option value="gift-bundle">gift-bundle</option>
            </select>
            <input
                className="input mono"
                style={{ width: 130, padding: "5px 8px", fontSize: 12 }}
                placeholder={type === "gift-bundle" ? "gift total" : "original"}
                value={original}
                onChange={(e) => setOriginal(e.target.value)}
            />
            <span style={{ color: "var(--text-dim)" }}>→</span>
            <input
                className="input mono"
                style={{ width: 130, padding: "5px 8px", fontSize: 12 }}
                placeholder="selling price"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") submit();
                }}
            />
            <button
                type="button"
                className="btn-primary"
                style={{ padding: "5px 12px", fontSize: 12 }}
                disabled={busy}
                onClick={submit}
            >
                {busy ? "Saving…" : "Add"}
            </button>
        </div>
    );
}

export default function DecorPrices({ onChange }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [onlyMissing, setOnlyMissing] = useState(false);

    const fetchPrices = useCallback(async () => {
        try {
            const res = await api.get("/decors/prices");
            setData(res.data);
            setError("");
        } catch (err) {
            setError(
                err.response?.data?.message ||
                    err.response?.data?.error ||
                    "Could not load the price table",
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchPrices();
    }, [fetchPrices]);

    // Every write changes what the shop charges, so refresh both this table
    // (bundle totals shift when a member's gift price changes) and the decor
    // list next to it.
    const afterWrite = async () => {
        await fetchPrices();
        onChange?.();
    };
    const save = async (type, original, price) => {
        await api.put("/decors/prices", { type, original, price });
        await afterWrite();
    };
    const clear = async (type, original) => {
        await api.delete(`/decors/prices/${type}/${original}`);
        await afterWrite();
    };

    // A tier is a problem when decors use it but it has no price: those decors
    // are being served at 0đ right now.
    const gaps = useMemo(() => {
        if (!data) return { decor: [], bundle: [], decorCount: 0 };
        const decor = data.decorTiers.filter(
            (t) => t.decorCount > 0 && (t.login === null || t.gift === null),
        );
        const bundle = data.bundleTiers.filter(
            (t) => t.bundleCount > 0 && t.giftBundle === null,
        );
        return {
            decor,
            bundle,
            decorCount: decor.reduce((n, t) => n + t.decorCount, 0),
        };
    }, [data]);

    if (loading)
        return (
            <div
                className="card"
                style={{
                    padding: 24,
                    textAlign: "center",
                    color: "var(--text-muted)",
                    fontSize: 13,
                }}
            >
                Loading price table…
            </div>
        );

    if (error)
        return (
            <div
                className="card"
                style={{
                    padding: "12px 16px",
                    color: "var(--danger)",
                    fontSize: 13,
                }}
            >
                {error}
            </div>
        );

    const decorTiers = onlyMissing ? gaps.decor : data.decorTiers;
    const bundleTiers = onlyMissing ? gaps.bundle : data.bundleTiers;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div
                style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 12,
                }}
            >
                <div style={{ flex: 1, minWidth: 260 }}>
                    <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>
                        Price table
                    </h3>
                    <p
                        style={{
                            fontSize: 12,
                            color: "var(--text-muted)",
                            margin: "4px 0 0",
                        }}
                    >
                        Maps a Discord original price to what the shop charges.
                        Replaces <code>/decor-price</code>. Empty a field to
                        remove that tier.
                    </p>
                </div>
                <label
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 12,
                        color: "var(--text-muted)",
                        cursor: "pointer",
                    }}
                >
                    <input
                        type="checkbox"
                        checked={onlyMissing}
                        onChange={(e) => setOnlyMissing(e.target.checked)}
                    />
                    Only unpriced tiers
                </label>
            </div>

            {(gaps.decor.length > 0 || gaps.bundle.length > 0) && (
                <div
                    style={{
                        padding: "10px 14px",
                        borderRadius: 8,
                        fontSize: 13,
                        background: "var(--danger-bg)",
                        color: "var(--danger)",
                        border: "1px solid var(--danger-border)",
                    }}
                >
                    {gaps.decor.length} decor tier(s) and {gaps.bundle.length}{" "}
                    bundle tier(s) have no price — {gaps.decorCount} decor(s)
                    are showing 0đ on the shop right now.
                </div>
            )}

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div
                    style={{
                        padding: "12px 16px",
                        borderBottom: "1px solid var(--border-light)",
                    }}
                >
                    <h4 style={{ fontSize: 13, fontWeight: 700, margin: 0 }}>
                        Decor tiers ({data.decorTiers.length})
                    </h4>
                    <p
                        style={{
                            fontSize: 11,
                            color: "var(--text-dim)",
                            margin: "3px 0 0",
                        }}
                    >
                        <code>login</code> is looked up with both the Nitro and
                        the non-Nitro original; <code>gift</code> only with the
                        Nitro one.
                    </p>
                </div>
                <div style={{ maxHeight: 460, overflow: "auto" }}>
                    <table
                        style={{
                            width: "100%",
                            borderCollapse: "collapse",
                            fontSize: 13,
                            minWidth: 620,
                        }}
                    >
                        <thead>
                            <tr
                                style={{
                                    color: "var(--text-dim)",
                                    fontSize: 11,
                                }}
                            >
                                <th style={th}>ORIGINAL</th>
                                <th style={th}>LOGIN</th>
                                <th style={th}>GIFT</th>
                                <th style={th}>USED BY</th>
                            </tr>
                        </thead>
                        <tbody>
                            {decorTiers.length === 0 ? (
                                <tr>
                                    <td
                                        colSpan={4}
                                        style={{
                                            ...td,
                                            textAlign: "center",
                                            color: "var(--text-dim)",
                                            padding: 20,
                                        }}
                                    >
                                        Nothing here.
                                    </td>
                                </tr>
                            ) : (
                                decorTiers.map((t) => (
                                    <tr
                                        key={t.original}
                                        style={{
                                            borderTop:
                                                "1px solid var(--border-light)",
                                        }}
                                    >
                                        <td
                                            className="mono"
                                            style={{ ...td, fontWeight: 600 }}
                                        >
                                            {money(t.original)}
                                        </td>
                                        <td style={td}>
                                            <PriceCell
                                                type="login"
                                                original={t.original}
                                                value={t.login}
                                                onSave={save}
                                                onClear={clear}
                                            />
                                        </td>
                                        <td style={td}>
                                            <PriceCell
                                                type="gift"
                                                original={t.original}
                                                value={t.gift}
                                                onSave={save}
                                                onClear={clear}
                                            />
                                        </td>
                                        <td
                                            style={{
                                                ...td,
                                                color: "var(--text-muted)",
                                                fontSize: 12,
                                            }}
                                        >
                                            {t.decorCount === 0 ? (
                                                <span
                                                    style={{
                                                        color: "var(--text-dim)",
                                                    }}
                                                >
                                                    unused
                                                </span>
                                            ) : (
                                                <span
                                                    title={t.samples.join(", ")}
                                                >
                                                    {t.decorCount} decor
                                                    {t.samples.length > 0 && (
                                                        <span
                                                            style={{
                                                                color: "var(--text-dim)",
                                                            }}
                                                        >
                                                            {" "}
                                                            · {t.samples[0]}
                                                        </span>
                                                    )}
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
                <AddTierForm onSave={save} />
            </div>

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div
                    style={{
                        padding: "12px 16px",
                        borderBottom: "1px solid var(--border-light)",
                    }}
                >
                    <h4 style={{ fontSize: 13, fontWeight: 700, margin: 0 }}>
                        Bundle gift tiers ({data.bundleTiers.length})
                    </h4>
                    <p
                        style={{
                            fontSize: 11,
                            color: "var(--text-dim)",
                            margin: "3px 0 0",
                        }}
                    >
                        Keyed by the sum of the members&apos; gift prices — so
                        raising a member&apos;s gift price moves its bundle to a
                        different tier, which then needs a price of its own.
                    </p>
                </div>
                <div style={{ maxHeight: 400, overflow: "auto" }}>
                    <table
                        style={{
                            width: "100%",
                            borderCollapse: "collapse",
                            fontSize: 13,
                            minWidth: 560,
                        }}
                    >
                        <thead>
                            <tr
                                style={{
                                    color: "var(--text-dim)",
                                    fontSize: 11,
                                }}
                            >
                                <th style={th}>GIFT TOTAL</th>
                                <th style={th}>BUNDLE PRICE</th>
                                <th style={th}>USED BY</th>
                            </tr>
                        </thead>
                        <tbody>
                            {bundleTiers.length === 0 ? (
                                <tr>
                                    <td
                                        colSpan={3}
                                        style={{
                                            ...td,
                                            textAlign: "center",
                                            color: "var(--text-dim)",
                                            padding: 20,
                                        }}
                                    >
                                        Nothing here.
                                    </td>
                                </tr>
                            ) : (
                                bundleTiers.map((t) => (
                                    <tr
                                        key={t.total}
                                        style={{
                                            borderTop:
                                                "1px solid var(--border-light)",
                                        }}
                                    >
                                        <td
                                            className="mono"
                                            style={{ ...td, fontWeight: 600 }}
                                        >
                                            {money(t.total)}
                                        </td>
                                        <td style={td}>
                                            <PriceCell
                                                type="gift-bundle"
                                                original={t.total}
                                                value={t.giftBundle}
                                                onSave={save}
                                                onClear={clear}
                                            />
                                        </td>
                                        <td
                                            style={{
                                                ...td,
                                                color: "var(--text-muted)",
                                                fontSize: 12,
                                            }}
                                        >
                                            {t.bundleCount === 0 ? (
                                                <span
                                                    style={{
                                                        color: "var(--text-dim)",
                                                    }}
                                                >
                                                    unused
                                                </span>
                                            ) : (
                                                <span
                                                    title={t.samples.join(", ")}
                                                >
                                                    {t.bundleCount} bundle
                                                    {t.samples.length > 0 && (
                                                        <span
                                                            style={{
                                                                color: "var(--text-dim)",
                                                            }}
                                                        >
                                                            {" "}
                                                            · {t.samples[0]}
                                                        </span>
                                                    )}
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
