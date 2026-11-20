import api from "../../api/client";
import { money } from "../../utils/format";
import avatarPng from "../../assets/decor/avatar.png";
import profilePng from "../../assets/decor/profile.png";
import nameplatePng from "../../assets/decor/nameplate.png";

// ─────────────────────────────────────────────────────────────────────────────
//  "Export image" on the Decors page: one theme drawn as the decor site shows
//  it (decor-site assets/css/style.css: .category-banner, .grid, .card,
//  .card-info, .badge; the previews as in DecorPreview.jsx), straight onto a
//  canvas at 1–3× — instead of zooming the site out until it fits a screenshot
//  and the picture goes soft.
//
//  Everything below is in CSS pixels of the decor site; the canvas is scaled.
//  Pictures come through GET /api/decors/image (same origin), because Discord's
//  CDN sends no CORS header and a canvas holding a cross-origin picture cannot
//  be saved. Still pictures only: a profile effect is Discord's own still
//  (staticURL), a nameplate its static.png, an animated decoration its first frame.
// ─────────────────────────────────────────────────────────────────────────────

const PAD = 24;
const GAP = 18;
const CARD = 220;
const RADIUS = 14;
const MEDIA_RADIUS = 10;
const BANNER_GAP = 18;
// .card-info: border-top 1 + padding 14 / 16 / 16; name 13px × 1.4, 2 lines max, 8 below; price line 14px × 1.6.
const INFO_PAD_X = 16;
const NAME_LINE = 13 * 1.4;
const PRICE_LINE = 22.4;
const infoHeight = (lines) => 1 + 14 + lines * NAME_LINE + 8 + PRICE_LINE + 16;

const C = {
    bg: "#09090f",
    card: "#13131e",
    border: "rgba(255, 255, 255, 0.06)",
    text: "#e4e4f0",
    muted: "#7070a0",
    price: "#9d5cf6",
    preview: "#1e1f22",
    glow: "rgba(124, 58, 237, 0.18)",
};
const TYPE = {
    0: { label: "Avatar Deco", color: "#3b82f6", bg: "rgba(59, 130, 246, 0.12)" },
    1: { label: "Profile Effect", color: "#10b981", bg: "rgba(16, 185, 129, 0.12)" },
    2: { label: "Nameplate", color: "#f59e0b", bg: "rgba(245, 158, 11, 0.12)" },
    3: { label: "Frame", color: "#ec4899", bg: "rgba(236, 72, 153, 0.12)" },
    1000: { label: "Bundle", color: "#8b5cf6", bg: "rgba(139, 92, 246, 0.12)" },
};

const font = (weight, size, style = "") => `${style} ${weight} ${size}px Inter, system-ui, -apple-system, "Segoe UI", sans-serif`.trim();

/**
 * Text ON the picture. The picture is for customers, like the decor site it
 * copies, so it can speak Vietnamese with the site's "59.000đ" — the panel's
 * own screens stay English (rule 29); this is content, like a composed message.
 */
export const PICTURE_TEXT = {
    vi: { from: "Từ", off: "Ngừng bán", other: "Khác", money: (n) => `${Math.round(n).toLocaleString("en-US").replace(/,/g, ".")}đ` },
    en: { from: "From", off: "Not for sale", other: "Other", money },
};

// Browsers refuse canvases past ~32k px a side or ~268M px (Chrome); stay well under.
const MAX_SIDE = 32_000;
const MAX_AREA = 150_000_000;

// ── Pictures ─────────────────────────────────────────────────────────────────

const PROFILE_ASPECT = 1760 / 900; // profile.png
const FRAME_PROFILE_CROP = 0.5;

/** Discord's static nameplate sits next to the video: …/asset.webm → …/static.png. */
const nameplateStill = (url) => (/\/asset\.webm(\?.*)?$/.test(url || "") ? url.replace(/\/asset\.webm(\?.*)?$/, "/static.png") : null);

/** An avatar decoration at its full 288 px, first frame (the record keeps the 240 px animated one). */
const decorationStill = (url) => {
    try {
        const u = new URL(url);
        u.searchParams.set("size", "480"); // Discord answers its largest, 288
        u.searchParams.set("passthrough", "false");
        return u.toString();
    } catch {
        return url;
    }
};

const frameLayerUrl = (decor, layer) => `https://cdn.discordapp.com/media/v1/collectibles-shop/${decor.sku_id}/${layer.id}/static`;

/** Every picture one card needs (null = none). */
function picturesOf(decor) {
    switch (decor.type) {
        case 0:
            return [avatarPng, decor.assetURL && decorationStill(decor.assetURL)];
        case 1:
            return [profilePng, decor.staticURL];
        case 2:
            return [nameplatePng, nameplateStill(decor.assetURL)];
        case 3:
            return decor.frame?.layers?.length ? [profilePng, ...decor.frame.layers.map((l) => frameLayerUrl(decor, l))] : [decor.staticURL];
        case 1000:
            return Array.isArray(decor.assetURL) ? decor.assetURL.slice(0, 2) : [];
        default:
            return [];
    }
}

/** True when the top square (what a card shows) is all but transparent. */
function isBlank(img) {
    const n = 48;
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    ctx.canvas.width = ctx.canvas.height = n;
    ctx.drawImage(img, 0, 0, img.width, img.width, 0, 0, n, n);
    const d = ctx.getImageData(0, 0, n, n).data;
    let seen = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 40) seen++;
    return seen < n * n * 0.02;
}

/**
 * One card's pictures → { pics, missing }.
 *
 * A profile effect is drawn from Discord's still. A few stills are empty
 * (La Llorona, Run Rẩy… ~3 % in 2026-11) and an animation's first frame is
 * always empty (the effects fade in), so those get a frame from the middle of
 * the looping layers — or of the intro when the loop is empty too. The layers
 * are APNGs of ~3 MB, hence only then.
 */
async function loadCard(decor, loader) {
    const srcs = picturesOf(decor);
    const pics = await Promise.all(srcs.map((src) => (src ? loader.get(src) : null)));
    let missing = srcs.filter((src, i) => src && !pics[i]).length;
    if (decor.type === 1 && !(pics[1] && !isBlank(pics[1]))) {
        const layers = [...(decor.effects || [])].filter((e) => e.src).sort((a, b) => a.zIndex - b.zIndex);
        const frames = (list) => Promise.all(list.map((e) => loader.frame(e.src)));
        let imgs = await frames(layers.filter((e) => e.loop));
        if (!imgs.some((img) => img && !isBlank(img))) imgs = await frames(layers.filter((e) => !e.loop));
        if (imgs.some(Boolean)) {
            if (decor.staticURL && !pics[1]) missing--;
            pics[1] = null;
            pics.push(...imgs);
        }
    }
    return { pics, missing };
}

/** The middle frame of an animated picture (ImageDecoder, Chrome/Edge); the first one elsewhere. */
async function middleFrame(blob) {
    if (typeof window.ImageDecoder !== "function") return window.createImageBitmap(blob);
    try {
        const dec = new window.ImageDecoder({ data: await blob.arrayBuffer(), type: blob.type || "image/png" });
        try {
            await dec.tracks.ready;
            const count = dec.tracks.selectedTrack?.frameCount || 1;
            const { image } = await dec.decode({ frameIndex: Math.floor(count / 2) });
            try {
                return await window.createImageBitmap(image);
            } finally {
                image.close();
            }
        } finally {
            dec.close();
        }
    } catch {
        return window.createImageBitmap(blob);
    }
}

const isLocal = (src) => !/^https?:\/\//i.test(src) || src.startsWith(window.location.origin);

/**
 * Loads pictures once per dialog (changing an option redraws from memory).
 * get(src) → ImageBitmap (first frame), frame(src) → the middle frame of an
 * animation; either is null when the picture could not be loaded.
 */
export function createLoader() {
    const cache = new Map();
    const queue = [];
    let running = 0;
    const PARALLEL = 6;

    const pump = () => {
        while (running < PARALLEL && queue.length) {
            const job = queue.shift();
            running++;
            job().finally(() => {
                running--;
                pump();
            });
        }
    };
    const fetchBlob = async (src) => {
        if (isLocal(src)) {
            const r = await fetch(src);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.blob();
        }
        const { data } = await api.get("/decors/image", { params: { url: src }, responseType: "blob", timeout: 45_000 });
        return data;
    };

    const load = (key, src, decode) => {
        if (!src) return Promise.resolve(null);
        if (!cache.has(key)) {
            cache.set(
                key,
                new Promise((resolve) => {
                    queue.push(() => fetchBlob(src).then(decode).then(resolve, () => resolve(null)));
                    pump();
                }),
            );
        }
        return cache.get(key);
    };

    return {
        get: (src) => load(src, src, (blob) => window.createImageBitmap(blob)),
        frame: (src) => load(`middle:${src}`, src, middleFrame),
        dispose() {
            queue.length = 0;
            for (const p of cache.values()) p.then((b) => b?.close?.());
            cache.clear();
        },
    };
}

// ── Drawing helpers ──────────────────────────────────────────────────────────

function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}

/** object-fit: cover, with object-position as fractions (0.5 = center). */
function drawCover(ctx, img, x, y, w, h, posX = 0.5, posY = 0.5) {
    if (!img) return;
    const s = Math.max(w / img.width, h / img.height);
    const sw = w / s, sh = h / s;
    ctx.drawImage(img, (img.width - sw) * posX, (img.height - sh) * posY, sw, sh, x, y, w, h);
}

/** object-fit: contain, centred. */
function drawContain(ctx, img, x, y, w, h) {
    if (!img) return;
    const s = Math.min(w / img.width, h / img.height);
    const dw = img.width * s, dh = img.height * s;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

const intToHex = (n) => "#" + ((n >>> 0) & 0xffffff).toString(16).padStart(6, "0");

/** CSS linear-gradient(160deg, …) over a box. */
function cssGradient(ctx, x, y, w, h, deg, colors) {
    const a = (deg * Math.PI) / 180;
    const dx = Math.sin(a), dy = -Math.cos(a);
    const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
    const cx = x + w / 2, cy = y + h / 2;
    const g = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
    colors.forEach((c, i) => g.addColorStop(colors.length === 1 ? 0 : i / (colors.length - 1), c));
    return g;
}

/** Word-wrap into at most `max` lines; the last one ends in "…" when cut (CSS line-clamp). */
function wrapLines(ctx, text, width, max) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    const fits = (t) => ctx.measureText(t).width <= width;
    for (let i = 0; i < words.length; i++) {
        let word = words[i];
        const tryLine = line ? `${line} ${word}` : word;
        if (fits(tryLine)) {
            line = tryLine;
            continue;
        }
        if (line) {
            lines.push(line);
            line = "";
        }
        // A word wider than the card breaks by characters.
        while (!fits(word) && word.length > 1) {
            let n = word.length - 1;
            while (n > 1 && !fits(word.slice(0, n))) n--;
            lines.push(word.slice(0, n));
            word = word.slice(n);
        }
        line = word;
        if (lines.length >= max) break;
    }
    if (line && lines.length < max + 1) lines.push(line);
    if (lines.length <= max) return lines;
    const kept = lines.slice(0, max);
    let last = kept[max - 1];
    while (last.length && !fits(`${last}…`)) last = last.slice(0, -1);
    kept[max - 1] = `${last.trimEnd()}…`;
    return kept;
}

// ── Previews (DecorPreview.jsx, as still pictures) ───────────────────────────

function drawAvatar(ctx, decor, pics, x, y, s) {
    const [base, deco] = pics;
    drawContain(ctx, base, x + s * 0.08, y + s * 0.08, s * 0.84, s * 0.84);
    drawContain(ctx, deco, x + s * 0.04, y + s * 0.04, s * 0.92, s * 0.92);
}

function drawProfileEffect(ctx, decor, pics, x, y, s) {
    const [profile, still, ...loops] = pics;
    const ph = s * PROFILE_ASPECT;
    if (still) drawCover(ctx, still, x, y, s, ph);
    else loops.forEach((img) => drawCover(ctx, img, x, y, s, ph)); // loadCard sorted them by zIndex
    ctx.save();
    ctx.globalAlpha = 0.18;
    if (profile) ctx.drawImage(profile, x, y, s, ph);
    ctx.restore();
}

function drawNameplate(ctx, decor, pics, x, y, s) {
    const [avatar, still] = pics;
    // .dp-chat-preview: padding 8% 6%, rows 22% / 30% / 22% of the content height, gap 2%.
    const cw = s * 0.88, ch = s * 0.84;
    const dimH = ch * 0.22, mainH = ch * 0.3, gap = ch * 0.02;
    const padV = cw * 0.02, padH = cw * 0.03; // .dp-chat-row padding: 2% 3%
    const left = x + s * 0.06;
    const innerW = cw - padH * 2;
    let top = y + s * 0.08 + (ch - (dimH * 2 + mainH + gap * 2)) / 2;

    const dimRow = (rowTop, widths) => {
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = "#3a3d44";
        const cy = rowTop + dimH / 2;
        const av = innerW * 0.15;
        ctx.beginPath();
        ctx.arc(left + padH + av / 2, cy, av / 2, 0, Math.PI * 2);
        ctx.fill();
        const lx = left + padH + av + innerW * 0.04;
        const lw = innerW - av - innerW * 0.04;
        widths.forEach((w, i) => {
            roundRect(ctx, lx, cy - 8 + i * 10, lw * w, 6, 3);
            ctx.fill();
        });
        ctx.restore();
    };

    dimRow(top, [0.65, 0.4]);
    top += dimH + gap;

    // .dp-nameplate-bg: the row's full inner box, radius 12, picture anchored right.
    const bx = left + padH, by = top + padV, bw = innerW, bh = mainH - padV * 2;
    ctx.save();
    roundRect(ctx, bx, by, bw, bh, 12);
    ctx.clip();
    ctx.fillStyle = "rgba(88, 101, 242, 0.15)";
    ctx.fillRect(bx, by, bw, bh);
    drawCover(ctx, still, bx, by, bw, bh, 1, 0.5);
    // padding 0 8% 0 4%, gap 5%: avatar 78% of the height, then the name pill (50% × 28%).
    const contentW = bw * 0.88;
    const avD = bh * 0.78;
    const ax = bx + bw * 0.04;
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax + avD / 2, by + bh / 2, avD / 2, 0, Math.PI * 2);
    ctx.clip();
    drawCover(ctx, avatar, ax, by + (bh - avD) / 2, avD, avD);
    ctx.restore();
    const nx = ax + avD + contentW * 0.05, nh = bh * 0.28;
    ctx.fillStyle = "rgba(97, 96, 99, 0.4)";
    roundRect(ctx, nx, by + (bh - nh) / 2, contentW * 0.5, nh, nh / 2);
    ctx.fill();
    ctx.restore();
    top += mainH + gap;

    dimRow(top, [0.5, 0.75]);
}

function drawFrame(ctx, decor, pics, x, y, s) {
    const f = decor.frame;
    if (!f?.layers?.length) {
        drawContain(ctx, pics[0], x + s * 0.08, y + s * 0.08, s * 0.84, s * 0.84);
        return;
    }
    const [profile, ...layerImgs] = pics;
    const { inner_width: iw, overflow_top: ot, overflow_bottom: ob, overflow_horizontal: oh } = f;
    const cropped = PROFILE_ASPECT * FRAME_PROFILE_CROP;
    const totalW = 1 + (2 * oh) / iw;
    const totalH = cropped + (ot + ob) / iw;
    const sw = s * Math.min(1 / totalW, 1 / totalH) * 0.96;
    const sh = sw * cropped;
    const mt = (sw * ot) / iw, mb = (sw * ob) / iw;
    const sx = x + (s - sw) / 2;
    const sy = y + (s - (mt + sh + mb)) / 2 + mt;

    const drawLayer = (layer, img) => {
        if (!img) return;
        const lw = sw * (1 + (2 * oh) / iw);
        const lx = sx - (sw * oh) / iw;
        if (layer.anchor === "top") ctx.drawImage(img, lx, sy - (sw * ot) / iw, lw, (lw * img.height) / img.width);
        else if (layer.anchor === "bottom") {
            const lh = (lw * img.height) / img.width;
            ctx.drawImage(img, lx, sy + sh + (sw * ob) / iw - lh, lw, lh);
        } else ctx.drawImage(img, lx, sy, lw, sh); // center: stretched to the stage height
    };
    const layers = f.layers.map((l, i) => [l, layerImgs[i]]);
    layers.filter(([l]) => l.order !== "front").forEach(([l, img]) => drawLayer(l, img));
    ctx.save();
    roundRect(ctx, sx, sy, sw, sh, 6);
    ctx.clip();
    ctx.fillStyle = "#2b2d31";
    ctx.fillRect(sx, sy, sw, sh);
    drawCover(ctx, profile, sx, sy, sw, sh, 0.5, 0);
    ctx.restore();
    layers.filter(([l]) => l.order === "front").forEach(([l, img]) => drawLayer(l, img));
}

function drawBundle(ctx, decor, pics, x, y, s) {
    const [base, overlay] = pics;
    if (!(Array.isArray(decor.assetURL) && decor.assetURL[1]) && decor.backgroundColors?.length) {
        const colors = decor.backgroundColors.map(intToHex);
        ctx.fillStyle = colors.length === 1 ? colors[0] : cssGradient(ctx, x, y, s, s, 160, colors);
        ctx.fillRect(x, y, s, s);
    }
    drawCover(ctx, base, x, y, s, s);
    drawCover(ctx, overlay, x, y, s, s);
}

const PREVIEW = { 0: drawAvatar, 1: drawProfileEffect, 2: drawNameplate, 3: drawFrame, 1000: drawBundle };

// ── Card & header ────────────────────────────────────────────────────────────

function drawBadge(ctx, type, x, y) {
    const t = TYPE[type] || { label: String(type), color: TYPE[0].color, bg: TYPE[0].bg };
    ctx.font = font(600, 11);
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0.2px";
    const w = ctx.measureText(t.label).width + 18;
    ctx.fillStyle = t.bg;
    roundRect(ctx, x, y, w, 22.5, 6);
    ctx.fill();
    ctx.fillStyle = t.color;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(t.label, x + 9, y + 15.3);
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
}

function drawCard(ctx, entry, pics, x, y, h, lines, text) {
    const { decor, on, from } = entry;
    const inner = CARD - 2;
    ctx.save();
    roundRect(ctx, x, y, CARD, h, RADIUS);
    ctx.fillStyle = C.card;
    ctx.fill();
    ctx.clip();

    // Media: a bundle fills the square; the Discord previews have their own 10 px corners.
    const mx = x + 1, my = y + 1;
    ctx.save();
    if (decor.type === 1000) {
        ctx.beginPath();
        ctx.rect(mx, my, inner, inner);
    } else {
        roundRect(ctx, mx, my, inner, inner, MEDIA_RADIUS);
    }
    ctx.clip();
    ctx.fillStyle = C.preview;
    ctx.fillRect(mx, my, inner, inner);
    (PREVIEW[decor.type] || drawAvatar)(ctx, decor, pics, mx, my, inner);
    ctx.restore();

    drawBadge(ctx, decor.type, x + 10, y + 10);

    // .card-info
    const iy = my + inner;
    ctx.fillStyle = C.border;
    ctx.fillRect(x, iy, CARD, 1);
    ctx.textBaseline = "alphabetic";
    ctx.font = font(600, 13);
    ctx.fillStyle = C.text;
    let ly = iy + 1 + 14;
    lines.forEach((l) => {
        ctx.fillText(l, x + INFO_PAD_X, ly + 13.8);
        ly += NAME_LINE;
    });
    ly = iy + 1 + 14 + Math.max(1, lines.length) * NAME_LINE + 8;
    // Rows share the tallest card's height; the price sits under this card's own name, as on the site.
    const base = ly + 16.3;
    if (!on) {
        ctx.font = font(400, 12, "italic");
        ctx.fillStyle = C.muted;
        ctx.fillText(text.off, x + INFO_PAD_X, base);
    } else if (from) {
        ctx.font = font(500, 11);
        ctx.fillStyle = C.muted;
        ctx.fillText(text.from, x + INFO_PAD_X, base);
        const lw = ctx.measureText(text.from).width;
        ctx.font = font(700, 14);
        ctx.fillStyle = C.price;
        ctx.fillText(text.money(from), x + INFO_PAD_X + lw + 5, base);
    }
    ctx.restore();

    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y + 0.5, CARD - 1, h - 1, RADIUS - 0.5);
    ctx.stroke();
}

const TITLE_H = 2 + 28 + 17 * 1.6;

/** .category-header: the theme name when it has no banner. */
function drawTitle(ctx, title, count, x, y, w) {
    ctx.save();
    roundRect(ctx, x, y, w, TITLE_H, RADIUS);
    ctx.fillStyle = cssGradient(ctx, x, y, w, TITLE_H, 90, [C.glow, "rgba(124, 58, 237, 0)"]);
    ctx.fill();
    ctx.strokeStyle = C.border;
    ctx.stroke();
    ctx.textBaseline = "alphabetic";
    ctx.font = font(700, 17);
    ctx.fillStyle = C.text;
    const base = y + 1 + 14 + 19.7;
    ctx.fillText(title, x + 19, base);
    const tw = ctx.measureText(title).width;
    ctx.font = font(500, 12);
    ctx.fillStyle = C.muted;
    ctx.fillText(count, x + 19 + tw + 10, base);
    ctx.restore();
}

function drawBanner(ctx, img, x, y, w) {
    const h = (w * img.height) / img.width;
    ctx.save();
    roundRect(ctx, x, y, w, h, RADIUS);
    ctx.fillStyle = C.card;
    ctx.fill();
    ctx.clip();
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, RADIUS - 0.5);
    ctx.stroke();
    return h;
}

// ── The whole picture ────────────────────────────────────────────────────────

const chunk = (arr, n) => {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
};

/**
 * Draw one theme. Returns { canvases, missing } — one canvas per part
 * (`rowsPerImage` 0 = everything in one), `missing` = pictures that could not
 * be loaded (their cards are drawn without them).
 *
 * entries: [{ decor, on, from }] in the page's order. header: { title, banner,
 * other } or null — `other` = the "Other" section, titled in the picture's language.
 */
export async function renderTheme({ entries, header, columns, rowsPerImage, scale, lang, loader, onProgress, isStale = () => false }) {
    const text = PICTURE_TEXT[lang] || PICTURE_TEXT.vi;
    const title = header?.other ? text.other : header?.title || "";

    // 1. Pictures, every card at once (the loader queues the requests). Progress counts cards.
    const bannerSrc = header?.banner || null;
    const total = entries.length + (bannerSrc ? 1 : 0);
    let done = 0;
    onProgress?.(0, total);
    const tick = (p) => p.then((v) => (onProgress?.(++done, total), v));
    const [cards, banner] = await Promise.all([
        Promise.all(entries.map((e) => tick(loadCard(e.decor, loader)))),
        bannerSrc ? tick(loader.get(bannerSrc)) : null,
    ]);
    const pics = cards.map((c) => c.pics);
    const missing = cards.reduce((n, c) => n + c.missing, bannerSrc && !banner ? 1 : 0);
    if (isStale()) return null;

    // 2. Fonts (Vietnamese letters come in their own Inter subset).
    const sample = entries.map((e) => e.decor.name).join(" ") + title + Object.values(text).filter((v) => typeof v === "string").join("");
    await Promise.all(
        [font(500, 11), font(600, 11), font(600, 13), font(700, 14), font(700, 17), font(500, 12), font(400, 12, "italic")].map((f) =>
            document.fonts?.load(f, sample).catch(() => null),
        ),
    );
    if (isStale()) return null;

    // 3. Layout: rows of `columns`, each row as tall as its longest name.
    const contentW = columns * CARD + (columns - 1) * GAP;
    const width = PAD * 2 + contentW;
    const measure = document.createElement("canvas").getContext("2d");
    measure.font = font(600, 13);
    const lines = entries.map((e) => wrapLines(measure, e.decor.name, CARD - 2 - INFO_PAD_X * 2, 2));
    const rows = chunk(entries.map((e, i) => i), columns).map((idx) => ({
        idx,
        height: CARD + infoHeight(Math.max(1, ...idx.map((i) => lines[i].length))),
    }));
    const parts = rowsPerImage > 0 ? chunk(rows, rowsPerImage) : [rows];
    const headerH = (first) => {
        if (!first || !header) return 0;
        if (banner) return (contentW * banner.height) / banner.width + BANNER_GAP;
        return TITLE_H + BANNER_GAP;
    };

    const canvases = parts.map((part, pi) => {
        const height = PAD * 2 + headerH(pi === 0) + part.reduce((h, r) => h + r.height, 0) + GAP * (part.length - 1);
        const cw = Math.round(width * scale), chh = Math.round(height * scale);
        if (cw > MAX_SIDE || chh > MAX_SIDE || cw * chh > MAX_AREA) {
            throw Object.assign(new Error("The picture would be too large for the browser — put fewer rows in each picture or pick a lower resolution."), { tooLarge: true });
        }
        const canvas = document.createElement("canvas");
        canvas.width = cw;
        canvas.height = chh;
        const ctx = canvas.getContext("2d");
        ctx.scale(cw / width, chh / height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.fillStyle = C.bg;
        ctx.fillRect(0, 0, width, height);

        let y = PAD;
        if (pi === 0 && header) {
            if (banner) y += drawBanner(ctx, banner, PAD, y, contentW);
            else {
                // "N items" is English on the decor site too.
                drawTitle(ctx, title, `${entries.length} item${entries.length !== 1 ? "s" : ""}`, PAD, y, contentW);
                y += TITLE_H;
            }
            y += BANNER_GAP;
        }
        part.forEach((row, ri) => {
            if (ri) y += GAP;
            row.idx.forEach((i, col) => {
                drawCard(ctx, entries[i], pics[i], PAD + col * (CARD + GAP), y, row.height, lines[i], text);
            });
            y += row.height;
        });
        return canvas;
    });

    return { canvases, missing };
}

/** canvas → Blob (PNG, or JPEG at 92 %: a third of the size, fine for Discord). */
export const toBlob = (canvas, format) =>
    new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The browser could not encode the picture"))), format === "jpeg" ? "image/jpeg" : "image/png", 0.92),
    );
