/** An on/off switch. The click does not reach the row or card behind it. */
export default function Toggle({ checked, onChange, disabled, title }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            title={title}
            className={`toggle${checked ? " on" : ""}`}
            onClick={(e) => {
                e.stopPropagation();
                onChange(!checked);
            }}
        >
            <span className="toggle-knob" />
        </button>
    );
}
