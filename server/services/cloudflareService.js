const axios = require("axios");

// ─────────────────────────────────────────────────────────────────────────────
//  Cloudflare DNS — points the panel's domain(s) at a new server after a move.
//
//    CF_API_TOKEN  API token limited to "Zone → DNS → Edit" on the one zone
//    CF_ZONE_ID    that zone's id (Cloudflare dashboard → the domain → Overview)
//
//  Both unset = DNS is not automated; the panel-move page then says which
//  record to change by hand. A proxied (orange-cloud) record takes effect as
//  soon as it is changed — clients talk to Cloudflare, not to the old IP.
// ─────────────────────────────────────────────────────────────────────────────

const API = "https://api.cloudflare.com/client/v4";

const configured = () => !!(process.env.CF_API_TOKEN && process.env.CF_ZONE_ID);

const call = async (method, url, data) => {
    try {
        const res = await axios({
            method,
            url: `${API}${url}`,
            data,
            timeout: 15_000,
            headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` },
        });
        return res.data.result;
    } catch (err) {
        const cfErrors = err.response?.data?.errors;
        const detail = Array.isArray(cfErrors) && cfErrors.length
            ? cfErrors.map((e) => `${e.code}: ${e.message}`).join("; ")
            : err.message;
        throw new Error(`Cloudflare: ${detail}`);
    }
};

const zonePath = () => `/zones/${encodeURIComponent(process.env.CF_ZONE_ID)}`;

/** The zone the token can edit — { name } — or throws. */
const verify = async () => {
    const zone = await call("get", zonePath());
    return { name: zone.name };
};

/**
 * Make `name` resolve to `ip`. An existing A record is updated in place (its
 * proxied setting is kept); a missing one is created proxied. More than one A
 * record for the name is refused — which one to keep is a human decision.
 * → { action: "updated" | "created" | "unchanged", proxied }
 */
const pointARecord = async (name, ip) => {
    const records = await call("get", `${zonePath()}/dns_records?type=A&name=${encodeURIComponent(name)}`);
    if (records.length > 1) {
        throw new Error(`Cloudflare: ${name} has ${records.length} A records — keep one and retry`);
    }
    if (records.length === 1) {
        const rec = records[0];
        if (rec.content === ip) return { action: "unchanged", proxied: rec.proxied };
        await call("patch", `${zonePath()}/dns_records/${rec.id}`, { content: ip });
        return { action: "updated", proxied: rec.proxied };
    }
    await call("post", `${zonePath()}/dns_records`, { type: "A", name, content: ip, proxied: true, ttl: 1 });
    return { action: "created", proxied: true };
};

module.exports = { configured, verify, pointARecord };
