const crypto = require("crypto");

// AES-256-GCM payload encryption for sensitive material (SSH private keys)
// travelling between panel and agent over the public internet.
//
// The 32-byte key is derived from the shared AGENT_API_KEY (sha256), so both
// sides can encrypt/decrypt without exchanging anything extra. This is
// defense-in-depth ON TOP of the UFW rule that already restricts the agent
// port to the panel's IP — not a replacement for it. The panel and agent MUST
// ship identical copies of this file.

const deriveKey = (secret) => crypto.createHash("sha256").update(String(secret)).digest();

/** Returns { iv, tag, data } — all base64. */
const encrypt = (plaintext, secret) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv);
    const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
    return {
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: enc.toString("base64"),
    };
};

/** Inverse of encrypt(). Throws if the payload was tampered with. */
const decrypt = (payload, secret) => {
    if (!payload || !payload.iv || !payload.tag || !payload.data) {
        throw new Error("Malformed encrypted payload");
    }
    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        deriveKey(secret),
        Buffer.from(payload.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return Buffer.concat([
        decipher.update(Buffer.from(payload.data, "base64")),
        decipher.final(),
    ]).toString("utf8");
};

module.exports = { encrypt, decrypt };
