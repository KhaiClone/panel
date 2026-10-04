#!/usr/bin/env node
// bot-lib/uiTemplate.js is the one source of the message-template language;
// the Embeds page needs it as an ES module. This writes
// client/src/lib/uiTemplate.js from it.
//
//   node scripts/sync-ui-template.js          write the client copy
//   node scripts/sync-ui-template.js --check  exit 1 if the copy is stale

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "../bot-lib/uiTemplate.js");
const OUT = path.join(__dirname, "../client/src/lib/uiTemplate.js");

const build = () => {
    const src = fs.readFileSync(SRC, "utf8").replace(/\r\n/g, "\n");
    if (!src.includes("\nmodule.exports = api;\n")) throw new Error("bot-lib/uiTemplate.js must end with `module.exports = api;`");
    const names = /const api = \{([\s\S]*?)\};/.exec(src)[1].split(",").map((s) => s.trim()).filter(Boolean);
    return (
        "// GENERATED from bot-lib/uiTemplate.js by scripts/sync-ui-template.js — do not edit.\n" +
        // `api` lists the module's own bindings by name, so they are exported as they are.
        src.replace("\nmodule.exports = api;\n", `\nexport default api;\nexport { ${names.join(", ")} };\n`)
    );
};

const want = build();
if (process.argv.includes("--check")) {
    const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").replace(/\r\n/g, "\n") : "";
    if (have !== want) {
        console.error("client/src/lib/uiTemplate.js is stale — run: node scripts/sync-ui-template.js");
        process.exit(1);
    }
    console.log("client/src/lib/uiTemplate.js is up to date");
} else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, want);
    console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}
