/** @type {import('tailwindcss').Config} */
export default {
    content: ["./index.html", "./src/**/*.{js,jsx}"],
    theme: {
        extend: {
            colors: {
                base: {
                    950: "#060B14",
                    900: "#0D1525",
                    800: "#111827",
                    700: "#1a2035",
                    600: "#243048",
                },
                violet: {
                    950: "#2e1065",
                },
            },
            fontFamily: {
                sans: ["Inter", "system-ui", "sans-serif"],
                mono: ["JetBrains Mono", "Fira Code", "Consolas", "monospace"],
            },
            animation: {
                "spin-slow": "spin 3s linear infinite",
                "glow":      "pulse-glow 4s ease-in-out infinite",
            },
            backgroundImage: {
                "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
                "gradient-conic":  "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
            },
        },
    },
    plugins: [],
};
