const axios = require("axios");

// ─────────────────────────────────────────────────────────────────────────────
//  Decor pictures for the Decors page's "Export image" (client
//  components/decor/exportImage.js draws a theme onto a canvas).
//
//  Why the panel fetches them: Discord's CDN sends `Access-Control-Allow-Origin`
//  only on /avatar-decoration-presets — not on /media/v1/collectibles-shop
//  (banners, bundles, frames, effects) nor /assets/collectibles (nameplates).
//  A browser shows those fine in an <img>, but a canvas that draws one is
//  "tainted" and refuses to be saved as a PNG. Fetched same-origin through
//  here, the canvas stays clean.
//
//  Only decor pictures on Discord's CDN: this must never turn into a way to
//  make the panel fetch any URL (its own agents on :4200, the LAN, metadata
//  endpoints…), and never serve something a browser would run (SVG, HTML) from
//  the panel's origin.
// ─────────────────────────────────────────────────────────────────────────────

const HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
// Every path a decor record or theme banner uses — checked against all 1,638 decors
// and 93 themes of 2026-11: shop media, older effects/stills (/assets/content),
// nameplates, avatar decorations. All Discord's own files, none uploaded by users.
const PATHS = ["/media/v1/collectibles-shop/", "/assets/content/", "/assets/collectibles/", "/avatar-decoration-presets/"];
// Raster only. Profile-effect APNGs reach ~3 MB; 20 MB leaves room without letting one call eat RAM.
const TYPES = new Set(["image/png", "image/apng", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

const _err = (message, status) => Object.assign(new Error(message), { status });

/** The URL as the panel will fetch it, or null when it is not a decor picture on Discord's CDN. */
function allowedUrl(raw) {
    let u;
    try {
        u = new URL(String(raw ?? ""));
    } catch {
        return null;
    }
    if (u.protocol !== "https:" || !HOSTS.has(u.hostname) || u.port || u.username || u.password) return null;
    // URL() already resolved "..": what is checked here is the path that gets fetched.
    if (!PATHS.some((p) => u.pathname.startsWith(p))) return null;
    return u.toString();
}

/** Fetch one picture → { type, body }. Errors carry `status` and an English message. */
async function fetchImage(raw) {
    const url = allowedUrl(raw);
    if (!url) throw _err("Only decor pictures on Discord's CDN can be fetched", 400);
    let res;
    try {
        res = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: TIMEOUT_MS,
            maxRedirects: 0, // a redirect could leave the allowed hosts
            maxContentLength: MAX_BYTES,
            validateStatus: () => true,
        });
    } catch (err) {
        throw _err(`Discord's CDN did not answer (${err.code || err.message})`, 502);
    }
    if (res.status !== 200) throw _err(`Discord's CDN answered HTTP ${res.status}`, res.status === 404 ? 404 : 502);
    const type = String(res.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!TYPES.has(type)) throw _err(`Discord's CDN did not answer with a picture (${type || "no type"})`, 502);
    return { type, body: Buffer.from(res.data) };
}

module.exports = { allowedUrl, fetchImage };
