import { Fragment, createContext, useContext } from "react";
import { emojiObject, hex } from "./format";
import "./messages.css";

// How the message will look on Discord (dark theme): content, embeds and link
// buttons, with Discord's markdown — **bold**, *italic*, __underline__,
// ~~strike~~, ||spoiler||, `code`, ```blocks```, > quotes, # headings, -#
// subtext, lists, [links](…), <t:…> times, custom emoji — and mentions drawn
// with the server's real role names and colours.

/** { roles: Map(id → { name, color }), channels: Map(id → { name }) } of the server the message goes to. */
const Lookup = createContext({ roles: new Map(), channels: new Map() });

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
    ["everyone", /@(everyone|here)\b/],
    ["link", /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/],
    ["url", /https?:\/\/[^\s<>]+[^\s<>.,:;"')\]]/],
    ["bold", /\*\*([\s\S]+?)\*\*/],
    ["underline", /__([\s\S]+?)__/],
    ["italic", /\*([^*\n]+?)\*|(?<![\w])_([^_\n]+?)_(?![\w])/],
    ["strike", /~~([\s\S]+?)~~/],
    ["spoiler", /\|\|([\s\S]+?)\|\|/],
];

function RoleMention({ id }) {
    const role = useContext(Lookup).roles.get(id);
    if (!role) return <span className="dp-mention" title={id}>@unknown-role</span>;
    const c = role.color ? hex(role.color) : null;
    return (
        <span className="dp-mention" style={c ? { color: c, background: `${c}1f` } : undefined} title={id}>
            @{role.name}
        </span>
    );
}

function ChannelMention({ id }) {
    const ch = useContext(Lookup).channels.get(id);
    return <span className="dp-mention" title={id}>#{ch ? ch.name : "unknown"}</span>;
}

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
                out.push(<RoleMention key={k} id={m[1]} />);
                break;
            case "user":
                out.push(<span key={k} className="dp-mention" title={m[1]}>@{m[1].slice(-4)}</span>);
                break;
            case "channel":
                out.push(<ChannelMention key={k} id={m[1]} />);
                break;
            case "everyone":
                out.push(<span key={k} className="dp-mention">@{m[1]}</span>);
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
export function Markdown({ text }) {
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
            if (lang.endsWith("```")) {
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
                    <Markdown text={[line.slice(4), ...lines.slice(i + 1)].join("\n")} />
                </blockquote>,
            );
            break;
        }
        if (line.startsWith("> ") || line === ">") {
            flush();
            const q = [];
            for (; i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">"); i++) q.push(lines[i].slice(2));
            i--;
            blocks.push(<blockquote key={`q${i}`} className="dp-quote"><Markdown text={q.join("\n")} /></blockquote>);
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
                            <div className="dp-field-value"><Markdown text={f.value} /></div>
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}

export function Embed({ e }) {
    const fields = (e.fields || []).filter((f) => f.name || f.value);
    return (
        <div className="dp-embed" style={{ borderLeftColor: typeof e.color === "number" ? hex(e.color) : "#1e1f22" }}>
            <div className="dp-embed-grid">
                <div className="dp-embed-body">
                    {e.author?.name && (
                        <div className="dp-author">
                            {e.author.icon_url && <img src={e.author.icon_url} alt="" />}
                            {e.author.url ? <a href={e.author.url} target="_blank" rel="noreferrer">{e.author.name}</a> : <span>{e.author.name}</span>}
                        </div>
                    )}
                    {e.title && (
                        <div className="dp-title">{e.url ? <a href={e.url} target="_blank" rel="noreferrer">{inline(e.title, "t")}</a> : inline(e.title, "t")}</div>
                    )}
                    {e.description && <div className="dp-desc"><Markdown text={e.description} /></div>}
                    {fields.length > 0 && <Fields fields={fields} thumb={!!e.thumbnail?.url} />}
                    {e.image?.url && <img className="dp-image" src={e.image.url} alt="" />}
                </div>
                {e.thumbnail?.url && <img className="dp-thumb" src={e.thumbnail.url} alt="" />}
            </div>
            {(e.footer?.text || e.timestamp) && (
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

const BUTTON_CLASS = { 1: "primary", 2: "secondary", 3: "success", 4: "danger", 5: "secondary" };

function Button({ b }) {
    const emoji = typeof b.emoji === "string" ? emojiObject(b.emoji) : b.emoji;
    const isLink = b.style === 5 || (b.style == null && b.url);
    return (
        <span className={`dp-button dp-button-${BUTTON_CLASS[b.style] || "secondary"} ${b.disabled ? "dp-disabled" : ""}`} title={b.url || b.custom_id || ""}>
            {emoji && (emoji.id ? <img className="dp-emoji" src={emojiUrl(emoji.id, emoji.animated)} alt="" /> : <span>{emoji.name}</span>)}
            {b.label && <span>{b.label}</span>}
            {isLink && <span className="dp-ext">↗</span>}
        </span>
    );
}

function Component({ c }) {
    if (c.type === 2 || c.type == null) return <Button b={c} />;
    // A menu (or anything else the bot uses): drawn as a closed menu.
    return (
        <div className="dp-select">
            <span>{c.placeholder || "Make a selection"}</span>
            <span>⌄</span>
        </div>
    );
}

function Header({ bot, edited }) {
    return (
        <div className="dp-header">
            <img className="dp-avatar" src={bot?.avatar || "https://cdn.discordapp.com/embed/avatars/0.png"} alt="" />
            <span className="dp-name">{bot?.displayName || bot?.username || "Bot"}</span>
            <span className="dp-bot">APP</span>
            <span className="dp-stamp">
                Today at {new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                {edited && " (edited)"}
            </span>
        </div>
    );
}

/**
 * msg: API shape { content, embeds, components } — components as rows
 * ([{ type: 1, components }]) or the editor's plain rows of buttons.
 * roles / channels: the server's, to draw mentions by name.
 */
export function MessagePreview({ msg, bot, roles = [], channels = [], edited = false }) {
    const rows = (msg.components || []).map((r) => (Array.isArray(r) ? r : r.components || [])).filter((r) => r.length);
    const lookup = { roles: new Map(roles.map((r) => [r.id, r])), channels: new Map(channels.map((c) => [c.id, c])) };
    const empty = !msg.content && !(msg.embeds || []).length && !rows.length;
    return (
        <Lookup.Provider value={lookup}>
            <div className="dp-root">
                <div className="dp-message">
                    <Header bot={bot} edited={edited} />
                    <div className="dp-body">
                        {msg.content && <div className="dp-content"><Markdown text={msg.content} /></div>}
                        {(msg.embeds || []).map((e, i) => <Embed key={i} e={e} />)}
                        {rows.map((row, i) => (
                            <div key={i} className="dp-row">
                                {row.map((c, j) => <Component key={j} c={c} />)}
                            </div>
                        ))}
                        {empty && <div className="dp-empty">(empty message)</div>}
                    </div>
                </div>
            </div>
        </Lookup.Provider>
    );
}
