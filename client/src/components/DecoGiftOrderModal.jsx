import { useEffect, useMemo, useState } from "react";
import api from "../api/client";
import { Field, Icon, Modal, Notice, SearchInput } from "./ui";

// A Deco Gift order for a buyer who paid in a ticket instead of by QR.
// ArnTo-Auto records it as paid (server: decorGiftService.createByHand); the
// shop opens its arnto_N and an admin approves it with the gift links in the
// Deco Gift staff channel, like every other Deco Gift order.

const MAX_ITEMS = 5;
const SNOWFLAKE = /^\d{17,20}$/;
const RESULTS = 30;

const money = (n) => `${Number(n || 0).toLocaleString("vi-VN")}đ`;
const errMsg = (err, fallback) => err?.response?.data?.error || err?.message || fallback;
const newRef = () => Array.from(window.crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join("");
/** A pasted mention or ID → the ID. */
const idOf = (s) => (String(s).match(/\d{17,20}/) || [])[0] || "";
/** The folding ArnTo-Auto's search uses: no accents, lower case, words only. */
const fold = (s) =>
    String(s || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/đ/gi, "d")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

function Thumb({ src }) {
    const box = { width: 36, height: 36, flex: "none", borderRadius: 6, background: "var(--bg-hover)" };
    return src ? <img src={src} alt="" loading="lazy" style={{ ...box, objectFit: "contain" }} /> : <span style={box} />;
}

function DecorRow({ d, sub, action }) {
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", minWidth: 0 }}>
            <Thumb src={d.thumb} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</p>
                <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</p>
            </div>
            <span className="mono" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{money(d.price)}</span>
            {action}
        </div>
    );
}

function BuyerHint({ id, buyer }) {
    if (!id) return "Paste their ID or mention — ArnTo-Shop DMs them the bill, ArnTo-assistant the gift links.";
    if (!buyer || buyer.id !== id) return "Looking up…";
    if (buyer.known === true) return <span style={{ color: "var(--success)" }}>✓ {buyer.tag}</span>;
    if (buyer.known === false) return <span style={{ color: "var(--danger)" }}>No Discord user has this ID.</span>;
    return "Could not look the name up (the panel's Discord bot is away) — check the ID yourself.";
}

function Result({ result, buyer, onAgain, onClose }) {
    const ok = !!result.shopOrderId;
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {ok ? (
                <Notice tone="success">
                    Order <b className="mono">{result.shopOrderId}</b> is open{buyer?.tag ? ` for ${buyer.tag}` : ""}. Approve it with the gift links in the Deco
                    Gift staff channel on Discord.
                </Notice>
            ) : (
                <Notice tone="warning">
                    ArnTo-Auto recorded it as <b className="mono">{result.id}</b>, but the shop's order is not open yet
                    {result.shopError ? `: ${result.shopError}` : ""}. ArnTo-Auto retries every 5 minutes, or press Thử lại on its staff card.
                </Notice>
            )}
            {result.existed && (
                <p style={{ margin: 0, fontSize: 12, color: "var(--text-dim)" }}>This form had been sent already — this is the order that first send made.</p>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {result.staffUrl && (
                    <a className="btn-ghost btn-sm" href={result.staffUrl} target="_blank" rel="noreferrer">
                        <Icon name="gift" size={14} /> Staff card
                    </a>
                )}
                {result.waitingUrl && (
                    <a className="btn-ghost btn-sm" href={result.waitingUrl} target="_blank" rel="noreferrer">
                        Waiting list
                    </a>
                )}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" className="btn-ghost" onClick={onAgain}>
                    Another order
                </button>
                <button type="button" className="btn-primary" onClick={onClose}>
                    Done
                </button>
            </div>
        </div>
    );
}

export default function DecoGiftOrderModal({ onClose, onCreated }) {
    const [catalog, setCatalog] = useState(null);
    const [loadError, setLoadError] = useState("");
    const [query, setQuery] = useState("");
    const [picked, setPicked] = useState([]); // sku ids, in order
    const [buyerInput, setBuyerInput] = useState("");
    const [buyer, setBuyer] = useState(null); // { id, known, tag }
    const [note, setNote] = useState("");
    const [ref, setRef] = useState(newRef);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState(null);

    useEffect(() => {
        api.get("/shop/deco-gift/catalog")
            .then(({ data }) => setCatalog(data))
            .catch((err) => setLoadError(errMsg(err, "Could not load the Gift decors")));
    }, []);

    const buyerId = idOf(buyerInput);
    useEffect(() => {
        if (!SNOWFLAKE.test(buyerId)) return;
        let live = true;
        const t = setTimeout(() => {
            api.get(`/shop/deco-gift/buyer/${buyerId}`)
                .then(({ data }) => live && setBuyer({ id: buyerId, ...data }))
                .catch(() => live && setBuyer({ id: buyerId, known: null }));
        }, 400);
        return () => {
            live = false;
            clearTimeout(t);
        };
    }, [buyerId]);

    // Another buyer or other decors is another order. Sending the same form again
    // (after a timeout) keeps its ref, so ArnTo-Auto returns the first order.
    useEffect(() => {
        setRef(newRef());
    }, [picked, buyerId]);

    const decors = useMemo(() => (catalog?.decors || []).map((d) => ({ ...d, sku_id: String(d.sku_id), norm: fold(d.name) })), [catalog]);
    const index = useMemo(() => new Map(decors.map((d) => [d.sku_id, d])), [decors]);
    const catName = useMemo(() => new Map((catalog?.categories || []).map((c) => [c.sku_id, c.name])), [catalog]);
    const catNorm = useMemo(() => new Map((catalog?.categories || []).map((c) => [c.sku_id, fold(c.name)])), [catalog]);

    // Ranked like ArnTo-Auto's search: exact > prefix > contains > all words > its collection.
    // A shop link or SKU finds that decor.
    const hits = useMemo(() => {
        const sku = (query.match(/itemSkuId=(\d+)/i) || query.match(/\b(\d{17,20})\b/))?.[1];
        if (sku) return index.has(sku) ? [index.get(sku)] : [];
        const q = fold(query);
        if (!q) return decors.slice(0, RESULTS);
        const words = q.split(" ");
        return decors
            .map((d) => {
                const n = d.norm;
                let score = 0;
                if (n === q) score = 100;
                else if (n.startsWith(q)) score = 80;
                else if (n.includes(q)) score = 60;
                else if (words.every((w) => n.includes(w))) score = 40;
                else {
                    const c = catNorm.get(d.category) || "";
                    if (c && words.every((w) => c.includes(w))) score = 30;
                }
                return [score, d];
            })
            .filter(([score]) => score > 0)
            .sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length)
            .slice(0, RESULTS)
            .map(([, d]) => d);
    }, [query, decors, index, catNorm]);

    const items = picked.map((s) => index.get(s)).filter(Boolean);
    const total = items.reduce((s, d) => s + d.price, 0);
    const full = picked.length >= MAX_ITEMS;
    const sub = (d) => [d.typeLabel, catName.get(d.category)].filter(Boolean).join(" · ");
    const unknownBuyer = buyer?.id === buyerId && buyer.known === false;
    const canSend = !busy && items.length > 0 && SNOWFLAKE.test(buyerId) && !unknownBuyer;

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            const { data } = await api.post("/shop/deco-gift/orders", { ref, buyerId, skus: picked, note }, { timeout: 90_000 });
            setResult(data);
            onCreated?.();
        } catch (err) {
            const timedOut = err?.response?.status === 504 || err?.code === "ECONNABORTED";
            setError(
                timedOut
                    ? `${errMsg(err, "No answer yet")}. Press Create again to check — this form will not make a second order.`
                    : errMsg(err, "Could not create the order"),
            );
        } finally {
            setBusy(false);
        }
    };

    const again = () => {
        setResult(null);
        setPicked([]);
        setBuyerInput("");
        setBuyer(null);
        setNote("");
        setQuery("");
        setError("");
    };

    return (
        <Modal title="New Deco Gift order" onClose={busy ? () => {} : onClose} width={620}>
            {result ? (
                <Result result={result} buyer={buyer} onAgain={again} onClose={onClose} />
            ) : (
                <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                        For a buyer who paid in a ticket. ArnTo-Auto records the order as paid and ArnTo-Shop opens it like any Deco Gift order — an admin still
                        approves it with the gift links in the staff channel.
                    </p>

                    <Field label="Buyer's Discord user ID" hint={<BuyerHint id={SNOWFLAKE.test(buyerId) ? buyerId : ""} buyer={buyer} />}>
                        <input className="input mono" value={buyerInput} onChange={(e) => setBuyerInput(e.target.value)} placeholder="953525563878948914" autoFocus />
                    </Field>

                    {/* Not a <Field>: a <label> would send every click in the list to its first button. */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>
                            Decors ({items.length}/{MAX_ITEMS}) <span style={{ fontWeight: 400, color: "var(--text-dim)" }}>· Gift prices from the Decors page, not editable here</span>
                        </span>
                        {items.length > 0 && (
                            <div className="card" style={{ padding: 2 }}>
                                {items.map((d) => (
                                    <DecorRow
                                        key={d.sku_id}
                                        d={d}
                                        sub={sub(d)}
                                        action={
                                            <button
                                                type="button"
                                                className="btn-ghost btn-icon btn-sm"
                                                title="Remove"
                                                onClick={() => setPicked((cur) => cur.filter((s) => s !== d.sku_id))}
                                            >
                                                <Icon name="x" size={14} />
                                            </button>
                                        }
                                    />
                                ))}
                                <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 10px", borderTop: "1px solid var(--border)", fontSize: 13 }}>
                                    <span style={{ color: "var(--text-muted)" }}>Total</span>
                                    <b className="mono">{money(total)}</b>
                                </div>
                            </div>
                        )}
                    </div>

                    {loadError ? (
                        <Notice tone="danger">{loadError}</Notice>
                    ) : !catalog ? (
                        <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>Loading the Gift decors…</p>
                    ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <SearchInput value={query} onChange={setQuery} placeholder="Decor name, collection or shop link…" />
                            <div className="card" style={{ padding: 2, maxHeight: 260, overflowY: "auto" }}>
                                {hits.length === 0 ? (
                                    <p style={{ margin: 0, padding: 10, fontSize: 12, color: "var(--text-dim)" }}>No Gift decor matches.</p>
                                ) : (
                                    hits.map((d) => {
                                        const has = picked.includes(d.sku_id);
                                        return (
                                            <DecorRow
                                                key={d.sku_id}
                                                d={d}
                                                sub={sub(d)}
                                                action={
                                                    <button
                                                        type="button"
                                                        className="btn-ghost btn-sm"
                                                        disabled={has || full}
                                                        onClick={() => setPicked((cur) => (cur.includes(d.sku_id) || cur.length >= MAX_ITEMS ? cur : [...cur, d.sku_id]))}
                                                    >
                                                        {has ? "Added" : "Add"}
                                                    </button>
                                                }
                                            />
                                        );
                                    })
                                )}
                            </div>
                        </div>
                    )}

                    <Field label="Note (optional)" hint="Shown on the staff card — e.g. the ticket it was paid in.">
                        <input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="ticket-1234, paid by bank transfer" />
                    </Field>

                    {error && <Notice tone="danger">{error}</Notice>}
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                        <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
                            Cancel
                        </button>
                        <button type="submit" className="btn-primary" disabled={!canSend}>
                            {busy ? "Creating…" : `Create order${items.length ? ` · ${money(total)}` : ""}`}
                        </button>
                    </div>
                </form>
            )}
        </Modal>
    );
}
