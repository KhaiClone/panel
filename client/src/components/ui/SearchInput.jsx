import Icon from "./Icon";

/** A text input with a search icon in front. `style` sizes the wrapper. */
export default function SearchInput({ value, onChange, placeholder = "Search…", style }) {
    return (
        <div className="search-input" style={style}>
            <Icon name="search" className="search-input-icon" />
            <input className="input" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        </div>
    );
}
