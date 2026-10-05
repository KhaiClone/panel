import { Fragment } from "react";
import "./embeds.css";

// A Discord-looking preview of a rendered message (API shape: content, embeds,
// components) or of a card's words. Markdown as Discord draws it: **bold**,
// *italic*, __underline__, ~~strike~~, ||spoiler||, `code`, ```blocks```,
// > quotes, # headings, -# subtext, lists, [links](…), mentions, <t:…>, emoji.

const TIME_STYLES = {
    t: { hour: "2-digit", minute: "2-digit" },
    T: { hour: "2-digit", minute: "2-digit", second: "2-digit" },
    d: { day: "2-digit", month: "2-digit", year: "numeric" },
    D: { day: "numeric", month: "long", year: "numeric" },
    f: { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" },
    F: { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" },
};

function relative(ms) {
    const diff = ms - Date.now();
    const abs = Math.abs(diff);
    const units = [
        ["year", 31536e6],
        ["month", 2592e6],
        ["day", 864e5],
        ["hour", 36e5],
        ["minute", 6e4],
        ["second", 1e3],
    ];
    const [unit, size] = units.find(([, s]) => abs >= s) || units[units.length - 1];
    return new Intl.RelativeTimeFormat("vi", { numeric: "auto" }).format(Math.round(diff / size), unit);
}

const formatTime = (sec, style = "f") => {
    const ms = Number(sec) * 1000;
    if (!Number.isFinite(ms)) return "";
    if (style === "R") return relative(ms);
    return new Date(ms).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false, ...(TIME_STYLES[style] || TIME_STYLES.f) });
};

const emojiUrl = (id, animated) => `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "png"}?size=48`;

// Inline patterns, tried at every position — the earliest match wins, then list order.
const INLINE = [
    ["code", /`([^`\n]+)`/],
    ["emoji", /<(a?):([\w~]+):(\d{15,25})>/],
    ["time", /<t:(-?\d+)(?::([tTdDfFR]))?>/],
    ["role", /<@&(\d+)>/],
    ["user", /<@!?(\d+)>/],
    ["channel", /<#(\d+)>/],
    ["link", /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/],
    ["url", /https?:\/\/[^\s<>]+[^\s<>.,:;"')\]]/],
    ["bold", /\*\*([\s\S]+?)\*\*/],
    ["underline", /__([\s\S]+?)__/],
    ["italic", /\*([^*\n]+?)\*|(?<![\w])_([^_\n]+?)_(?![\w])/],
    ["strike", /~~([\s\S]+?)~~/],
    ["spoiler", /\|\|([\s\S]+?)\|\|/],
];

function inline(text, key = "i") {
    const out = [];
    let rest = String(text ?? "");
    let n = 0;
    while (rest) {
        let best = null;
        for (const [type, re] of INLINE) {
            const m = re.exec(rest);
            if (m && (!best || m.index < best.m.index)) best = { type, m };
        }
        if (!best) {
            out.push(rest);
            break;
        }
        const { type, m } = best;
        if (m.index) out.push(rest.slice(0, m.index));
        const k = `${key}-${n++}`;
        switch (type) {
            case "code":
                out.push(<code key={k} className="dp-code">{m[1]}</code>);
                break;
            case "emoji":
                out.push(<img key={k} className="dp-emoji" src={emojiUrl(m[3], !!m[1])} alt={`:${m[2]}:`} title={`:${m[2]}:`} />);
                break;
            case "time":
                out.push(<span key={k} className="dp-time">{formatTime(m[1], m[2])}</span>);
                break;
            case "role":
                out.push(<span key={k} className="dp-mention">@role</span>);
                break;
            case "user":
                out.push(<span key={k} className="dp-mention" title={m[1]}>@{m[1].slice(-4)}</span>);
                break;
            case "channel":
                out.push(<span key={k} className="dp-mention" title={m[1]}># kênh</span>);
                break;
            case "link":
                out.push(<a key={k} className="dp-link" href={m[2]} target="_blank" rel="noreferrer">{inline(m[1], k)}</a>);
                break;
            case "url":
                out.push(<a key={k} className="dp-link" href={m[0]} target="_blank" rel="noreferrer">{m[0]}</a>);
                break;
            case "bold":
                out.push(<strong key={k}>{inline(m[1], k)}</strong>);
                break;
            case "underline":
                out.push(<u key={k}>{inline(m[1], k)}</u>);
                break;
            case "italic":
                out.push(<em key={k}>{inline(m[1] ?? m[2], k)}</em>);
                break;
            case "strike":
                out.push(<s key={k}>{inline(m[1], k)}</s>);
                break;
            case "spoiler":
                out.push(<span key={k} className="dp-spoiler">{inline(m[1], k)}</span>);
                break;
            default:
                out.push(m[0]);
        }
        rest = rest.slice(m.index + m[0].length);
    }
    return out;
}

/** Discord markdown → React (blocks: code, quotes, headings, subtext, lists, lines). */
export function Markdown({ text, embed = false }) {
    const lines = String(text ?? "").split("\n");
    const blocks = [];
    let para = [];
    const flush = () => {
        if (!para.length) return;
        blocks.push(
            <div key={`p${blocks.length}`} className="dp-line">
                {para.map((l, i) => (
                    <Fragment key={i}>
                        {i > 0 && <br />}
                        {inline(l, `p${blocks.length}-${i}`)}
                    </Fragment>
                ))}
            </div>,
        );
        para = [];
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("```")) {
            flush();
            const lang = line.slice(3).trim();
            const body = [];
            const inlineEnd = lang.endsWith("```");
            if (inlineEnd) {
                body.push(lang.slice(0, -3));
            } else {
                for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
            }
            blocks.push(<pre key={`c${i}`} className="dp-pre"><code>{body.join("\n")}</code></pre>);
            continue;
        }
        if (line.startsWith(">>> ")) {
            flush();
            blocks.push(
                <blockquote key={`q${i}`} className="dp-quote">
                    <Markdown text={[line.slice(4), ...lines.slice(i + 1)].join("\n")} embed={embed} />
                </blockquote>,
            );
            break;
        }
        if (line.startsWith("> ") || line === ">") {
            flush();
            const q = [];
            for (; i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">"); i++) q.push(lines[i].slice(2));
            i--;
            blocks.push(<blockquote key={`q${i}`} className="dp-quote"><Markdown text={q.join("\n")} embed={embed} /></blockquote>);
            continue;
        }
        const h = /^(#{1,3}) (.+)$/.exec(line);
        if (h) {
            flush();
            const Tag = `h${h[1].length}`;
            blocks.push(<Tag key={`h${i}`} className={`dp-h dp-h${h[1].length}`}>{inline(h[2], `h${i}`)}</Tag>);
            continue;
        }
        if (line.startsWith("-# ")) {
            flush();
            blocks.push(<div key={`s${i}`} className="dp-subtext">{inline(line.slice(3), `s${i}`)}</div>);
            continue;
        }
        if (/^\s*[-*] /.test(line) || /^\s*\d+\. /.test(line)) {
            flush();
            const ordered = /^\s*\d+\. /.test(line);
            const items = [];
            for (; i < lines.length && (ordered ? /^\s*\d+\. /.test(lines[i]) : /^\s*[-*] /.test(lines[i])); i++) items.push(lines[i].replace(/^\s*(?:[-*]|\d+\.) /, ""));
            i--;
            const List = ordered ? "ol" : "ul";
            blocks.push(
                <List key={`l${i}`} className="dp-list">
                    {items.map((it, j) => <li key={j}>{inline(it, `l${i}-${j}`)}</li>)}
                </List>,
            );
            continue;
        }
        para.push(line);
    }
    flush();
    return <>{blocks}</>;
}

const hex = (n) => (typeof n === "number" ? `#${n.toString(16).padStart(6, "0")}` : "#1e1f22");

function Fields({ fields, thumb }) {
    // Inline fields share a row: 3 per row, 2 beside a thumbnail.
    const perRow = thumb ? 2 : 3;
    const rows = [];
    let row = [];
    for (const f of fields) {
        if (!f.inline) {
            if (row.length) rows.push(row);
            rows.push([f]);
            row = [];
            continue;
        }
        row.push(f);
        if (row.length === perRow) {
            rows.push(row);
            row = [];
        }
    }
    if (row.length) rows.push(row);
    return (
        <div className="dp-fields">
            {rows.map((r, i) => (
                <div key={i} className="dp-field-row" style={{ gridTemplateColumns: `repeat(${r.length}, minmax(0, 1fr))` }}>
                    {r.map((f, j) => (
                        <div key={j} className="dp-field">
                            <div className="dp-field-name">{inline(f.name, `fn${i}${j}`)}</div>
                            <div className="dp-field-value"><Markdown text={f.value} embed /></div>
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}

export function Embed({ e }) {
    return (
        <div className="dp-embed" style={{ borderLeftColor: hex(e.color) }}>
            <div className="dp-embed-grid">
                <div className="dp-embed-body">
                    {e.author && (
                        <div className="dp-author">
                            {e.author.icon_url && <img src={e.author.icon_url} alt="" />}
                            {e.author.url ? <a href={e.author.url} target="_blank" rel="noreferrer">{e.author.name}</a> : <span>{e.author.name}</span>}
                        </div>
                    )}
                    {e.title && (
                        <div className="dp-title">{e.url ? <a href={e.url} target="_blank" rel="noreferrer">{inline(e.title, "t")}</a> : inline(e.title, "t")}</div>
                    )}
                    {e.description && <div className="dp-desc"><Markdown text={e.description} embed /></div>}
                    {e.fields?.length > 0 && <Fields fields={e.fields} thumb={!!e.thumbnail} />}
                    {e.image && <img className="dp-image" src={e.image.url} alt="" />}
                </div>
                {e.thumbnail && <img className="dp-thumb" src={e.thumbnail.url} alt="" />}
            </div>
            {(e.footer || e.timestamp) && (
                <div className="dp-footer">
                    {e.footer?.icon_url && <img src={e.footer.icon_url} alt="" />}
                    <span>
                        {e.footer?.text}
                        {e.footer?.text && e.timestamp ? " • " : ""}
                        {e.timestamp ? new Date(e.timestamp).toLocaleString("vi-VN", { hour12: false }) : ""}
                    </span>
                </div>
            )}
        </div>
    );
}

const BUTTON_CLASS = { 1: "primary", 2: "secondary", 3: "success", 4: "danger", 5: "secondary", primary: "primary", secondary: "secondary", success: "success", danger: "danger", link: "secondary" };

export function Button({ b }) {
    const emoji = b.emoji;
    return (
        <span className={`dp-button dp-button-${BUTTON_CLASS[b.style] || "secondary"} ${b.disabled ? "dp-disabled" : ""}`} title={b.url || b.custom_id || ""}>
            {emoji && (emoji.id ? <img className="dp-emoji" src={emojiUrl(emoji.id, emoji.animated)} alt="" /> : <span>{emoji.name}</span>)}
            {b.label && <span>{b.label}</span>}
            {(b.style === 5 || b.url) && <span className="dp-ext">↗</span>}
        </span>
    );
}

export function Select({ placeholder }) {
    return (
        <div className="dp-select">
            <span>{placeholder || "Chọn…"}</span>
            <span>⌄</span>
        </div>
    );
}

function Header({ bot }) {
    return (
        <div className="dp-header">
            <img className="dp-avatar" src={bot?.avatar || "https://cdn.discordapp.com/embed/avatars/0.png"} alt="" />
            <span className="dp-name">{bot?.displayName || bot?.username || "Bot"}</span>
            <span className="dp-bot">BOT</span>
            <span className="dp-stamp">Hôm nay lúc {new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
    );
}

/** A rendered message: { content, embeds, components } plus menus [{ placeholder }]. */
export function MessagePreview({ msg, bot, selects = [] }) {
    return (
        <div className="dp-root">
            <div className="dp-message">
                <Header bot={bot} />
                <div className="dp-body">
                    {msg.content && <div className="dp-content"><Markdown text={msg.content} /></div>}
                    {(msg.embeds || []).map((e, i) => <Embed key={i} e={e} />)}
                    {selects.map((s, i) => <Select key={`s${i}`} placeholder={s.placeholder} />)}
                    {(msg.components || []).map((row, i) => (
                        <div key={i} className="dp-row">
                            {row.components.map((b, j) => <Button key={j} b={b} />)}
                        </div>
                    ))}
                    {!msg.content && !(msg.embeds || []).length && !(msg.components || []).length && !selects.length && (
                        <div className="dp-empty">(tin nhắn trống)</div>
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * A card: its words, menus and buttons — each part in a box of its own, under
 * its slot name. Where each part goes is the bot's code: pieces of one view, or
 * separate replies (a QR note, "order cancelled", "not found"…). The panel
 * cannot tell which, so it never draws them as one message.
 */
export function CardPreview({ color, parts, buttons, selects, bot }) {
    return (
        <div className="dp-root">
            <div className="dp-message">
                <Header bot={bot} />
                <div className="dp-body dp-parts">
                    {parts.map((p) => (
                        <div key={p.slot} className="dp-part">
                            <div className="dp-part-label">{p.slot}</div>
                            <div className="dp-container" style={{ borderLeftColor: hex(color) }}>
                                {String(p.text || "").trim() ? <Markdown text={p.text} /> : <div className="dp-empty">(trống)</div>}
                            </div>
                        </div>
                    ))}
                    {selects.map((s) => (
                        <div key={s.slot} className="dp-part">
                            <div className="dp-part-label">menu {s.slot}</div>
                            <Select placeholder={s.placeholder} />
                            {s.option && <div className="dp-option">{s.option.label}{s.option.description ? <span> — {s.option.description}</span> : null}</div>}
                        </div>
                    ))}
                    {buttons.length > 0 && (
                        <div className="dp-part">
                            <div className="dp-part-label">nút</div>
                            <div className="dp-row">
                                {buttons.map((b) => <Button key={b.slot} b={b} />)}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
