import { createContext, useContext, useRef } from "react";

// The input the variable list inserts into: whichever template field had the
// focus last (with its caret). Each Field registers itself on focus.
export const ActiveFieldContext = createContext({ setActive: () => {} });

/**
 * A template text input. `multiline` → textarea. `slot` names the slot whose
 * extra variables apply here (a card's text, a menu), shown by the variable list.
 */
export default function Field({ label, value, onChange, multiline = false, rows = 3, placeholder, slot = null, mono = false, hint, style }) {
    const ref = useRef(null);
    const { setActive } = useContext(ActiveFieldContext);
    const props = {
        ref,
        className: "input",
        value: value ?? "",
        placeholder,
        onChange: (e) => onChange(e.target.value),
        onFocus: () => setActive({ el: ref.current, apply: onChange, slot, label }),
        style: { fontFamily: mono ? "var(--font-mono, ui-monospace, monospace)" : undefined, fontSize: 13, ...(multiline ? { resize: "vertical", minHeight: rows * 20 + 16 } : {}), ...style },
        spellCheck: false,
    };
    return (
        <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            {label && <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.02em" }}>{label}</span>}
            {multiline ? <textarea rows={rows} {...props} /> : <input {...props} />}
            {hint && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{hint}</span>}
        </label>
    );
}

/** Insert `token` at the caret of the last focused Field. */
export function insertAtCaret(active, token) {
    const el = active?.el;
    if (!el || !document.body.contains(el)) return false;
    const value = el.value ?? "";
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    active.apply(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
    });
    return true;
}
