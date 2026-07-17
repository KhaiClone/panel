import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        // Proxy all /api requests to the Express server in development
        proxy: {
            "/api": {
                target: "http://localhost:3000",
                changeOrigin: true,
                ws: true, // proxy the terminal WebSocket too
            },
        },
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        chunkSizeWarningLimit: 1000,
        rollupOptions: {
            output: {
                manualChunks: {
                    'codemirror-core': ['codemirror'],
                    'codemirror-theme': ['@codemirror/theme-one-dark'],
                    'codemirror-lang-js': ['@codemirror/lang-javascript'],
                    'codemirror-lang-json': ['@codemirror/lang-json'],
                    'codemirror-lang-css': ['@codemirror/lang-css'],
                    'codemirror-lang-html': ['@codemirror/lang-html'],
                    'codemirror-lang-python': ['@codemirror/lang-python'],
                    'codemirror-lang-java': ['@codemirror/lang-java'],
                    'codemirror-lang-php': ['@codemirror/lang-php'],
                    'codemirror-lang-cpp': ['@codemirror/lang-cpp'],
                    'codemirror-lang-rust': ['@codemirror/lang-rust'],
                    'codemirror-lang-markdown': ['@codemirror/lang-markdown'],
                    'codemirror-lang-yaml': ['@codemirror/lang-yaml'],
                    'codemirror-lang-xml': ['@codemirror/lang-xml'],
                    'codemirror-lang-sql': ['@codemirror/lang-sql'],
                },
            },
        },
    },
});
