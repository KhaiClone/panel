// GitHub repo URLs as projects store them (bot.repoUrl), both ways.
//
// The panel clones over SSH through per-key host aliases from Git keys
// (git@github.com-<key>:owner/repo.git), so the host is not always
// "github.com"; https URLs are fine too. A rewritten URL keeps its form and
// host alias, so it still clones with the same key.

const SCP = /^([\w.-]+)@(github\.com[\w.-]*):([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/i;
const SSH = /^ssh:\/\/([\w.-]+)@(github\.com[\w.-]*)(?::\d+)?\/([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/i;
const HTTPS = /^https?:\/\/(?:[^@/]+@)?(github\.com)\/([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/i;

/** { form, user?, host, owner, name, dotGit } — or null for anything not on GitHub. */
const parse = (url) => {
    const s = String(url || "").trim();
    let m = SCP.exec(s);
    if (m) return { form: "scp", user: m[1], host: m[2], owner: m[3], name: m[4], dotGit: !!m[5] };
    m = SSH.exec(s);
    if (m) return { form: "ssh", user: m[1], host: m[2], owner: m[3], name: m[4], dotGit: !!m[5] };
    m = HTTPS.exec(s);
    if (m) return { form: "https", host: m[1], owner: m[2], name: m[3], dotGit: !!m[4] };
    return null;
};

/** The same URL pointing at owner/name. */
const rewrite = (url, owner, name) => {
    const p = parse(url);
    if (!p) return null;
    const tail = `${owner}/${name}${p.dotGit ? ".git" : ""}`;
    if (p.form === "scp") return `${p.user}@${p.host}:${tail}`;
    if (p.form === "ssh") return `ssh://${p.user}@${p.host}/${tail}`;
    return `https://github.com/${tail}`;
};

/** "owner/name" in lower case — how repos are compared (GitHub names are case-insensitive). */
const key = (owner, name) => `${owner}/${name}`.toLowerCase();

module.exports = { parse, rewrite, key };
