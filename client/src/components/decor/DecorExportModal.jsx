import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, Modal, Notice } from "../ui";
import { fmtNum } from "../../utils/format";
import { createLoader, renderTheme, toBlob } from "./exportImage";

// ─────────────────────────────────────────────────────────────────────────────
//  Decors page → a theme's "Export image": the section drawn like the decor
//  site (exportImage.js) at a chosen resolution, ready to download or paste
//  into Discord. Redraws on every option change; pictures are fetched once
//  per dialog.
// ─────────────────────────────────────────────────────────────────────────────

const COLUMNS = [3, 4, 5, 6];
const SCALES = [[1, "1×"], [2, "2×"], [3, "3×"]];
const ROWS = [[0, "All in one"], [2, "2 rows"], [3, "3 rows"], [4, "4 rows"], [6, "6 rows"]];
const FORMATS = [["png", "PNG"], ["jpeg", "JPEG (smaller)"]];
const LANGS = [["vi", "Vietnamese (like the decor site)"], ["en", "English"]];
const DISCORD_LIMIT = 10 * 1024 * 1024; // upload limit without Nitro

const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
/** File name from the theme name: accents dropped, ASCII only. */
const slug = (s) =>
    String(s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\u0110\u0111]/g, "d")
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase() || "decors";

function Chips({ options, value, onChange }) {
    return (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {options.map(([v, label]) => (
                <button key={v} type="button" className={`chip${value === v ? " active" : ""}`} onClick={() => onChange(v)}>{label}</button>
            ))}
        </div>
    );
}

function Option({ label, hint, children }) {
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>{label}</span>
            {children}
            {hint && <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>{hint}</span>}
        </div>
    );
}

/** section: { key, cat, items } as the page groups it; saleOf(decor) → { on, from }. */
export default function DecorExportModal({ section, saleOf, onClose }) {
    const [columns, setColumns] = useState(5);
    const [scale, setScale] = useState(2);
    const [rows, setRows] = useState(0);
    const [format, setFormat] = useState("png");
    const [lang, setLang] = useState("vi");
    const [withHeader, setWithHeader] = useState(true);
    const [skipOff, setSkipOff] = useState(true);
    const [state, setState] = useState({ busy: true, done: 0, total: 0, error: "", images: [], missing: 0 });
    const [copied, setCopied] = useState(-1);
    const [copyError, setCopyError] = useState("");

    const loader = useMemo(() => createLoader(), []);
    useEffect(() => () => loader.dispose(), [loader]);

    useEffect(() => {
        const onKey = (e) => e.key === "Escape" && onClose();
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    const isOther = section.key === "__other";
    const all = useMemo(() => section.items.map((decor) => ({ decor, ...saleOf(decor) })), [section, saleOf]);
    const entries = useMemo(() => (skipOff ? all.filter((e) => e.on) : all), [all, skipOff]);
    const offCount = all.length - all.filter((e) => e.on).length;
    const noPrice = entries.filter((e) => e.on && !e.from).length;
    const baseName = isOther ? "other-decors" : slug(section.cat.name);
    const ext = format === "jpeg" ? "jpg" : "png";
    const fileName = (i) => (state.images.length > 1 ? `${baseName}-${i + 1}.${ext}` : `${baseName}.${ext}`);

    // Redraw on every option change; a newer draw makes the older one stale.
    const run = useRef(0);
    useEffect(() => {
        const id = ++run.current;
        const stale = () => run.current !== id;
        setState((s) => ({ ...s, busy: true, error: "", done: 0, total: 0 }));
        const timer = setTimeout(async () => {
            try {
                if (!entries.length) {
                    setState({ busy: false, done: 0, total: 0, error: "", images: [], missing: 0 });
                    return;
                }
                const out = await renderTheme({
                    entries,
                    header: withHeader ? { title: section.cat.name, banner: section.cat.banner || null, other: isOther } : null,
                    columns,
                    rowsPerImage: rows,
                    scale,
                    lang,
                    loader,
                    isStale: stale,
                    onProgress: (done, total) => !stale() && setState((s) => ({ ...s, done, total })),
                });
                if (!out || stale()) return;
                const images = [];
                for (const canvas of out.canvases) {
                    const blob = await toBlob(canvas, format);
                    images.push({ blob, url: URL.createObjectURL(blob), w: canvas.width, h: canvas.height });
                    // Drop the pixels now: a 3× theme is tens of MB per canvas.
                    canvas.width = canvas.height = 0;
                }
                if (stale()) return images.forEach((img) => URL.revokeObjectURL(img.url));
                setState({ busy: false, done: 0, total: 0, error: "", images, missing: out.missing });
            } catch (err) {
                if (!stale()) setState((s) => ({ ...s, busy: false, error: err.message || "Could not draw the picture", images: [] }));
            }
        }, 150);
        return () => clearTimeout(timer);
    }, [entries, withHeader, section, isOther, columns, rows, scale, lang, format, loader]);

    // The previews' blob URLs live until they are replaced or the dialog closes.
    useEffect(() => () => state.images.forEach((img) => URL.revokeObjectURL(img.url)), [state.images]);

    const copy = async (img, i) => {
        setCopyError("");
        try {
            // The clipboard takes PNG only; a JPEG is re-encoded for it.
            const png = img.blob.type === "image/png"
                ? Promise.resolve(img.blob)
                : window.createImageBitmap(img.blob).then((bmp) => {
                    const c = document.createElement("canvas");
                    c.width = bmp.width;
                    c.height = bmp.height;
                    c.getContext("2d").drawImage(bmp, 0, 0);
                    bmp.close();
                    return toBlob(c, "png");
                });
            await navigator.clipboard.write([new window.ClipboardItem({ "image/png": png })]);
            setCopied(i);
            setTimeout(() => setCopied((c) => (c === i ? -1 : c)), 1500);
        } catch {
            setCopyError("The browser would not copy the picture — use Download instead.");
        }
    };

    const downloadAll = () => {
        state.images.forEach((img, i) => {
            const a = document.createElement("a");
            a.href = img.url;
            a.download = fileName(i);
            document.body.appendChild(a);
            a.click();
            a.remove();
        });
    };

    const title = isOther ? "Other" : section.cat.name;
    const big = state.images.filter((img) => img.blob.size > DISCORD_LIMIT).length;

    return (
        <Modal title={`Export image — ${title}`} onClose={onClose} width={860}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                    The theme as the decor site shows it, drawn at full sharpness — no zooming out. Uses the {fmtNum(all.length)} decor shown in this section, so the page&apos;s filters apply.
                </p>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
                    <Option label="Cards per row">
                        <Chips options={COLUMNS.map((n) => [n, String(n)])} value={columns} onChange={setColumns} />
                    </Option>
                    <Option label="Resolution" hint="2× stays sharp when zoomed on a phone.">
                        <Chips options={SCALES} value={scale} onChange={setScale} />
                    </Option>
                    <Option label="Rows per picture" hint="Split a big theme into several pictures.">
                        <Chips options={ROWS} value={rows} onChange={setRows} />
                    </Option>
                    <Option label="File type">
                        <Chips options={FORMATS} value={format} onChange={setFormat} />
                    </Option>
                    <Option label="Text on the picture" hint="For customers: price as on the decor site.">
                        <Chips options={LANGS} value={lang} onChange={setLang} />
                    </Option>
                    <Option label="Include">
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
                            <input type="checkbox" checked={withHeader} onChange={(e) => setWithHeader(e.target.checked)} />
                            {section.cat.banner ? "Theme banner at the top" : "Theme name at the top"}
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
                            <input type="checkbox" checked={!skipOff} onChange={(e) => setSkipOff(!e.target.checked)} />
                            Decor not for sale{offCount ? ` (${fmtNum(offCount)})` : ""}
                        </label>
                    </Option>
                </div>

                {noPrice > 0 && <Notice tone="warning">{fmtNum(noPrice)} decor {noPrice === 1 ? "has" : "have"} no price tier, so {noPrice === 1 ? "its card shows" : "their cards show"} no price. Add the tier under Price tiers.</Notice>}
                {state.missing > 0 && !state.busy && (
                    <Notice tone="warning">{fmtNum(state.missing)} picture(s) could not be loaded from Discord — those cards are drawn without them. Change any option to try again.</Notice>
                )}
                {big > 0 && !state.busy && (
                    <Notice tone="warning">{big === 1 && state.images.length === 1 ? "The picture is" : `${big} picture(s) are`} over 10 MB — Discord refuses that without Nitro. Pick JPEG, a lower resolution or fewer rows per picture.</Notice>
                )}
                {state.error && <Notice tone="danger">{state.error}</Notice>}
                {copyError && <Notice tone="danger">{copyError}</Notice>}

                {!entries.length ? (
                    <Notice tone="warning">Nothing to draw: every decor in this section is not for sale. Tick &quot;Decor not for sale&quot; to draw them anyway.</Notice>
                ) : state.busy ? (
                    <div style={{ padding: 30, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                        {state.total && state.done < state.total ? `Loading pictures… ${fmtNum(state.done)} / ${fmtNum(state.total)}` : "Drawing the picture…"}
                    </div>
                ) : (
                    state.images.length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                            {state.images.length > 1 && (
                                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                                    <button type="button" className="btn-primary btn-sm" onClick={downloadAll}><Icon name="download" size={12} /> Download all {state.images.length}</button>
                                </div>
                            )}
                            {state.images.map((img, i) => (
                                <div key={img.url} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12, color: "var(--text-muted)" }}>
                                        {state.images.length > 1 && <strong style={{ color: "var(--text)" }}>Picture {i + 1} of {state.images.length}</strong>}
                                        <span>{fmtNum(img.w)} × {fmtNum(img.h)} px · {fmtSize(img.blob.size)}</span>
                                        <span style={{ flex: 1 }} />
                                        <button type="button" className="btn-ghost btn-sm" onClick={() => copy(img, i)} title="Copy, then paste into Discord">
                                            <Icon name={copied === i ? "check" : "copy"} size={12} /> {copied === i ? "Copied" : "Copy"}
                                        </button>
                                        <a className="btn-primary btn-sm" href={img.url} download={fileName(i)} style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
                                            <Icon name="download" size={12} /> Download
                                        </a>
                                    </div>
                                    <div style={{ maxHeight: 460, overflow: "auto", borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg-input)" }}>
                                        <img src={img.url} alt={`${title} — picture ${i + 1}`} style={{ width: "100%", display: "block" }} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    )
                )}
            </div>
        </Modal>
    );
}
