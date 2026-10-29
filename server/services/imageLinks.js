const dns = require("dns");
const net = require("net");
const http = require("http");
const https = require("https");

// ─────────────────────────────────────────────────────────────────────────────
//  Pictures by link — the Messages and Webhooks pages attach an image to a
//  message from its URL. Discord only draws a picture under plain content when
//  it is an attachment (a link in the text stays a link, and an embed's image
//  sits inside the embed), so the picture is downloaded and sent as a file.
//
//  The page keeps links, not files — { url, name } in the message as `images` —
//  so they survive a reload and go into Saved messages. The Webhooks page's
//  messages are posted by the panel, which downloads the pictures here; the
//  Messages page's are posted by ArnTo-assistant, which downloads them itself
//  with the same rules (its functions/imageLinks.js).
//
//  The download runs on the panel's machine, so a link may only reach the
//  public internet: every address a name resolves to is checked when the
//  connection is made (a second DNS answer cannot slip past), so is every
//  redirect, and loopback, private, link-local, CGNAT and reserved ranges are
//  refused — a pasted http://127.0.0.1:… must not end up posted on Discord.
//  Only pictures Discord draws are taken (PNG, JPEG, GIF, WebP, AVIF — read
//  from the bytes, not the header); SVG is refused, Discord shows it as a
//  file (the same trap as img.vietqr.io's QR codes).
// ─────────────────────────────────────────────────────────────────────────────

const MAX_IMAGES = 10; // Discord's files per message
const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const HOPS = 3;
const URL_MAX = 2048;
const UA = "Mozilla/5.0 (compatible; ArnTo-panel; +image-link)";
const EXT = /\.(png|jpe?g|gif|webp|avif)$/i;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const bad = (message) => httpError(400, message);
const mb = (n) => `${Math.round((n / 1048576) * 10) / 10} MB`;

/** What attachment:// can name: ASCII letters, digits, _ - . (the pages use the same rule). */
const fileName = (name, i) => {
    const s = String(name || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .replace(/[^\w.-]+/g, "_")
        .replace(/^[._]+/, "")
        .slice(-100);
    return s || `file-${i + 1}`;
};

/** A picture's file name: the page's, else the link's last part; .png when it has no picture extension. */
const imageName = (name, url, i) => {
    let base = name;
    if (!base) {
        try {
            base = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
        } catch {
            base = "";
        }
    }
    const s = fileName(base || `image-${i + 1}`, i);
    return EXT.test(s) ? s : `${s}.png`;
};

const linkOf = (v, what) => {
    const s = String(v ?? "").trim();
    if (s.length > URL_MAX) throw bad(`${what} is too long`);
    let u;
    try {
        u = new URL(s);
    } catch {
        throw bad(`${what} is not a link: "${s.slice(0, 80)}"`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw bad(`${what} must start with https://`);
    return s;
};

/**
 * The page's `images` → [{ url, name }] (empty rows dropped). Throws 400 on a
 * link that is not one, or more pictures than Discord takes.
 */
const imagesOf = (list, { max = MAX_IMAGES } = {}) => {
    if (list == null) return [];
    if (!Array.isArray(list)) throw bad("Images must be a list");
    const out = [];
    list.forEach((x, i) => {
        const raw = typeof x === "string" ? x : x?.url;
        if (raw == null || !String(raw).trim()) return;
        const url = linkOf(raw, `Image ${i + 1}`);
        out.push({ url, name: imageName(typeof x === "object" ? x?.name : "", url, out.length) });
    });
    if (out.length > max) throw bad(`${out.length} images — Discord allows ${max} files per message`);
    return out;
};

// ── Public addresses only ────────────────────────────────────────────────────

const BLOCKED = new net.BlockList();
for (const [a, p] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10], // CGNAT — overlays live here too
    ["127.0.0.0", 8],
    ["169.254.0.0", 16], // link-local, cloud metadata
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 3], // multicast and reserved, up to 255.255.255.255
]) {
    BLOCKED.addSubnet(a, p, "ipv4");
}
// No ::ffff:0:0/96 rule: BlockList matches every IPv4 address against it too
// (as IPv4-mapped), which blocked the whole internet. Mapped addresses are
// turned back into IPv4 below instead.
for (const [a, p] of [
    ["::", 127], // :: and ::1
    ["64:ff9b::", 96], // NAT64
    ["100::", 64],
    ["2001:db8::", 32],
    ["2002::", 16], // 6to4 can carry a private IPv4
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
]) {
    BLOCKED.addSubnet(a, p, "ipv6");
}

/** ::ffff:a.b.c.d / ::ffff:7f00:1 (any spelling) → "a.b.c.d"; anything else → null. */
const mappedV4 = (ip) => {
    let s;
    try {
        s = new URL(`http://[${ip}]/`).hostname.slice(1, -1); // canonical: ::ffff:7f00:1
    } catch {
        return null;
    }
    const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(s);
    if (!m) return null;
    const [hi, lo] = [parseInt(m[1], 16), parseInt(m[2], 16)];
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
};

/** Is this IP on the public internet? */
const isPublicAddress = (ip) => {
    const s = String(ip || "").replace(/^\[|\]$/g, "");
    const family = net.isIP(s);
    if (!family) return false;
    const v4 = family === 6 ? mappedV4(s) : null;
    if (v4) return !BLOCKED.check(v4, "ipv4");
    return !BLOCKED.check(s, family === 4 ? "ipv4" : "ipv6");
};

/** dns.lookup for http(s).get that only ever answers public addresses. */
const lookupWith = (check) => (hostname, options, cb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, list) => {
        if (err) return cb(err);
        const ok = list.filter((a) => check(a.address));
        if (!ok.length) return cb(Object.assign(new Error(`${hostname} is a private address`), { code: "EPRIVATE" }));
        if (options?.all) return cb(null, ok);
        return cb(null, ok[0].address, ok[0].family);
    });
};

// ── Downloading ──────────────────────────────────────────────────────────────

/** What the bytes are — the header is often wrong (octet-stream, or a page). */
const sniff = (b) => {
    if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return { type: "image/png", ext: "png" };
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
    if (b.length >= 6 && b.toString("latin1", 0, 4) === "GIF8") return { type: "image/gif", ext: "gif" };
    if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return { type: "image/webp", ext: "webp" };
    if (b.length >= 12 && b.toString("latin1", 4, 8) === "ftyp" && /^avi[fs]$/.test(b.toString("latin1", 8, 12))) return { type: "image/avif", ext: "avif" };
    return null;
};

const NOT_PUBLIC = "points to a private address — only public links can be fetched";
const PAGE = "is a web page, not a picture — use the picture's own link (right-click it → Copy image address)";

/**
 * One picture from the internet → { buffer, type, ext }. Errors are short
 * phrases ("the link answered HTTP 404") for downloadAll to name the image.
 * `check` is for the tests (a local server); nothing else passes it.
 */
const download = (link, { maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS, check = isPublicAddress } = {}) =>
    new Promise((resolve, reject) => {
        let req = null;
        let done = false;
        const finish = (err, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (err) {
                req?.destroy();
                reject(err);
            } else resolve(value);
        };
        const fail = (text) => finish(bad(text));
        const timer = setTimeout(() => fail(`the link did not answer within ${timeoutMs / 1000} s`), timeoutMs);
        const tooBig = () => fail(`the picture is too big — at most ${mb(maxBytes)} of files per message`);

        const go = (href, hops) => {
            let u;
            try {
                u = new URL(href);
            } catch {
                return fail("the link is not a link");
            }
            if (u.protocol !== "http:" && u.protocol !== "https:") return fail("the link must start with https://");
            const host = u.hostname.replace(/^\[|\]$/g, "");
            if (net.isIP(host) && !check(host)) return fail(`the link ${NOT_PUBLIC}`);
            const lib = u.protocol === "https:" ? https : http;
            req = lib.get(u, { headers: { "user-agent": UA, accept: "image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5" }, lookup: lookupWith(check) }, (res) => {
                const status = res.statusCode;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    if (hops >= HOPS) return fail("the link redirects too many times");
                    return go(new URL(res.headers.location, u).href, hops + 1);
                }
                if (status !== 200) {
                    res.resume();
                    return fail(`the link answered HTTP ${status}`);
                }
                const header = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
                if (header.includes("svg")) return fail("it is an SVG — Discord shows that as a file, not a picture (use PNG, JPEG, GIF or WebP)");
                if (header === "text/html") return fail(`the link ${PAGE}`);
                if (Number(res.headers["content-length"]) > maxBytes) return tooBig();
                const chunks = [];
                let n = 0;
                res.on("data", (c) => {
                    n += c.length;
                    if (n > maxBytes) return tooBig();
                    chunks.push(c);
                });
                res.on("error", (err) => fail(`the download broke off (${err.code || err.message})`));
                res.on("end", () => {
                    if (done) return;
                    const buffer = Buffer.concat(chunks);
                    const kind = sniff(buffer);
                    if (!kind) return fail(/^text\//.test(header) ? `the link ${PAGE}` : "it is not a picture Discord can show (PNG, JPEG, GIF, WebP or AVIF)");
                    return finish(null, { buffer, ...kind });
                });
            });
            req.on("error", (err) => {
                if (err.code === "EPRIVATE") return fail(`the link ${NOT_PUBLIC}`);
                if (err.code === "ENOTFOUND") return fail(`the site ${u.hostname} does not exist`);
                return fail(`the link cannot be reached (${err.code || err.message})`);
            });
        };
        go(String(link), 0);
    });

/**
 * imagesOf's list → files ready to upload: [{ name, type, buffer, size }], one
 * after another within `maxBytes` together. A failure names the picture:
 * "Image 2 (banner.png): the link answered HTTP 404".
 */
const downloadAll = async (images = [], { maxBytes = MAX_BYTES, ...opts } = {}) => {
    const out = [];
    let left = maxBytes;
    for (const [i, img] of images.entries()) {
        let f;
        try {
            f = await download(img.url, { ...opts, maxBytes: left });
        } catch (err) {
            throw httpError(err.status || 400, `Image ${i + 1} (${img.name}): ${err.message}`);
        }
        left -= f.buffer.length;
        out.push({ name: img.name, type: f.type, buffer: f.buffer, size: f.buffer.length });
    }
    return out;
};

/**
 * The links a message's pictures came from, after an edit: the earlier ones
 * whose file is still on it (Discord's attachments), then the ones just added.
 * Without Discord's list (an older bot) only the added ones are known.
 */
const stillOn = (before, attachments, added) => {
    const names = Array.isArray(attachments) ? new Set(attachments.map((a) => a.filename)) : null;
    const out = [...(names ? (before || []).filter((x) => names.has(x.name)) : []), ...(added || [])];
    return out.length ? out : undefined;
};

module.exports = { MAX_IMAGES, MAX_BYTES, fileName, imageName, imagesOf, isPublicAddress, download, downloadAll, stillOn, sniff };
