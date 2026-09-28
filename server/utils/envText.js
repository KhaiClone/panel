// .env text helpers — edit one key without disturbing any other line.
// Same rules as agent/utils/envFile.js.

/**
 * Set (or drop, with null) one KEY=value line in .env text, keeping every other
 * line where it was. A missing key is appended.
 */
const setEnvKey = (text, key, value) => {
    const out = [];
    let done = false;
    for (const line of String(text || "").split("\n")) {
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

/** The value of KEY in .env text (surrounding quotes dropped), or null. */
const envValue = (text, key) => {
    for (const line of String(text || "").split("\n")) {
        const idx = line.indexOf("=");
        if (idx > 0 && !line.trim().startsWith("#") && line.slice(0, idx).trim() === key) {
            return line.slice(idx + 1).trim().replace(/^(["'])(.*)\1$/, "$2") || null;
        }
    }
    return null;
};

module.exports = { setEnvKey, envValue };
