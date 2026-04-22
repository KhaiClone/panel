/** @type {import('tailwindcss').Config} */
export default {
    content: ["./index.html", "./src/**/*.{js,jsx}"],
    theme: {
        extend: {
            colors: {
                base: {
                    900: "#0f172a",
                    800: "#1e293b",
                    700: "#293548",
                    600: "#334155",
                },
            },
            fontFamily: {
                mono: ["JetBrains Mono", "Fira Code", "monospace"],
            },
        },
    },
    plugins: [],
};
