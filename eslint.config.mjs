// Deliberately minimal: this config exists to catch ONE class of bug that
// neither Vite nor `require()` can, and that has bitten this codebase three
// times — an identifier that is used but never declared or imported.
//
// Removing an import, or dropping a name from a destructure like
// `const { nodeId, isRemote } = useNode()`, leaves the remaining references
// syntactically valid. Rollup builds them happily and Node loads the module
// fine; the code then dies at runtime with "isRemote is not defined", but only
// once someone opens that page or hits that branch.
//
//   npm run lint
//
// Only no-undef is enabled. no-unused-vars is NOT: without eslint-plugin-react
// it does not count JSX as a reference, so every component would be reported
// unused — 139 false positives that would bury the one real finding.

// The client carries `// eslint-disable-next-line react-hooks/exhaustive-deps`
// comments written before any linter existed here. ESLint 9 errors on a disable
// comment naming a rule it does not know, so the rule is declared as a no-op.
// Swap this for eslint-plugin-react-hooks if those checks are ever wanted.
const reactHooksStub = {
    rules: {
        "exhaustive-deps": { create: () => ({}) },
        "rules-of-hooks": { create: () => ({}) },
    },
};

const nodeGlobals = {
    require: "readonly",
    module: "writable",
    exports: "writable",
    process: "readonly",
    __dirname: "readonly",
    __filename: "readonly",
    console: "readonly",
    Buffer: "readonly",
    setTimeout: "readonly",
    clearTimeout: "readonly",
    setInterval: "readonly",
    clearInterval: "readonly",
    setImmediate: "readonly",
    URL: "readonly",
    URLSearchParams: "readonly",
    TextEncoder: "readonly",
    TextDecoder: "readonly",
    AbortController: "readonly",
    fetch: "readonly",
    structuredClone: "readonly",
    queueMicrotask: "readonly",
};

const browserGlobals = {
    window: "readonly",
    document: "readonly",
    localStorage: "readonly",
    sessionStorage: "readonly",
    navigator: "readonly",
    location: "readonly",
    fetch: "readonly",
    console: "readonly",
    setTimeout: "readonly",
    clearTimeout: "readonly",
    setInterval: "readonly",
    clearInterval: "readonly",
    requestAnimationFrame: "readonly",
    cancelAnimationFrame: "readonly",
    WebSocket: "readonly",
    EventSource: "readonly",
    ResizeObserver: "readonly",
    IntersectionObserver: "readonly",
    MutationObserver: "readonly",
    URL: "readonly",
    URLSearchParams: "readonly",
    Blob: "readonly",
    File: "readonly",
    FileReader: "readonly",
    FormData: "readonly",
    Image: "readonly",
    Audio: "readonly",
    atob: "readonly",
    btoa: "readonly",
    TextEncoder: "readonly",
    TextDecoder: "readonly",
    AbortController: "readonly",
    getComputedStyle: "readonly",
    alert: "readonly",
    confirm: "readonly",
    performance: "readonly",
    structuredClone: "readonly",
    queueMicrotask: "readonly",
    process: "readonly", // vite substitutes process.env at build time
};

export default [
    {
        ignores: [
            "**/node_modules/**",
            "client/dist/**",
            "data/**",
            "scripts/snapshots/**",
            "{server/**", // a stray directory literally named "{server..." lives in the repo
        ],
    },

    // ── Panel server, agent, and maintenance scripts (CommonJS on Node) ──────
    {
        files: ["server/**/*.js", "agent/**/*.js", "scripts/**/*.js", "ecosystem.config.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: nodeGlobals,
        },
        // Files carry disable comments for rules this config does not enable.
        linterOptions: { reportUnusedDisableDirectives: "off" },
        rules: { "no-undef": "error" },
    },

    // ── React client (ES modules in the browser) ─────────────────────────────
    {
        files: ["client/src/**/*.{js,jsx}"],
        plugins: { "react-hooks": reactHooksStub },
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            parserOptions: { ecmaFeatures: { jsx: true } },
            globals: browserGlobals,
        },
        linterOptions: {
            // The stub rule above never reports, so every disable comment for it
            // would otherwise be flagged as unused.
            reportUnusedDisableDirectives: "off",
        },
        rules: { "no-undef": "error" },
    },

    // ── Client build config (ESM, Node) ──────────────────────────────────────
    {
        files: ["client/*.config.js", "client/vite.config.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: nodeGlobals,
        },
        rules: { "no-undef": "error" },
    },
];
