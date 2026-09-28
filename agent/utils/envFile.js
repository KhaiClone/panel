const fs = require("fs");

/**
 * Set (or remove, with value === null) one KEY=value line in .env text,
 * leaving every other line — comments included — exactly where it was.
 * Duplicate lines for the key collapse into the first one.
 */
const setKeyInText = (text, key, value) => {
    const lines = String(text || "").split("\n");
    const out = [];
    let done = false;
    for (const line of lines) {
        const idx = line.indexOf("=");
        const isKey = idx > 0 && !line.trim().startsWith("#") && line.slice(0, idx).trim() === key;
        if (!isKey) {
            out.push(line);
            continue;
        }
        if (!done && value !== null) out.push(`${key}=${value}`);
        done = true;
    }
    if (!done && value !== null) {
        while (out.length && out[out.length - 1] === "") out.pop();
        out.push(`${key}=${value}`, "");
    }
    return out.join("\n");
};

/** Same as setKeyInText, on a file. Written via a temp file + rename. */
const setKey = (file, key, value) => {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const next = setKeyInText(current, key, value);
    if (next === current) return false;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, next, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
};

module.exports = { setKeyInText, setKey };
