import { Icon } from "./ui";

// Statistics periods: "2026-10", "2026" or "all" — and, where a page allows it, a
// range of days "2026-10-05_2026-10-20" (both ends included). Months and days are
// Vietnam's (UTC+7), like the server's (orderService, buyerService) and the
// shop's /thongke.
const vnToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
export const thisMonth = () => vnToday().slice(0, 7);
export const monthName = (m, opts = { month: "long", year: "numeric" }) => new Date(`${m}-01T00:00:00`).toLocaleDateString("en-GB", opts);
const dayName = (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
export const isRange = (p) => typeof p === "string" && p.includes("_");
export const periodName = (p) => {
    if (p === "all") return "All time";
    if (isRange(p)) {
        const [from, to] = p.split("_");
        return from === to ? dayName(from) : `${dayName(from)} – ${dayName(to)}`;
    }
    return p.length === 4 ? p : monthName(p);
};
export const modeOf = (p) => (p === "all" ? "all" : isRange(p) ? "range" : p.length === 4 ? "year" : "month");

const MODES = [["month", "Month"], ["year", "Year"], ["all", "All time"]];
const DAY_INPUT = { width: "auto", paddingTop: 6, paddingBottom: 6 };

/**
 * Month / Year / All time, stepping through `months` (newest first) — plus
 * Custom, a From–To pair of days, with `allowRange`.
 */
export default function PeriodPicker({ period, months, onChange, allowRange = false }) {
    const mode = modeOf(period);
    const years = [...new Set(months.map((m) => m.slice(0, 4)))];
    const list = mode === "month" ? months : years;
    const i = list.indexOf(period);
    const [from, to] = isRange(period) ? period.split("_") : [];
    const switchTo = (m) => {
        if (m === mode) return;
        if (m === "all") return onChange("all");
        // A range starts as this month so far.
        if (m === "range") return onChange(`${thisMonth()}-01_${vnToday()}`);
        if (m === "year") return onChange(mode === "month" ? period.slice(0, 4) : years[0]);
        // To months: the latest one of the year being looked at.
        onChange((mode === "year" && months.find((k) => k.startsWith(period))) || months[0]);
    };
    // A day typed past the other end moves that end along, so the range stays valid.
    const setFrom = (d) => d && onChange(`${d}_${d > to ? d : to}`);
    const setTo = (d) => d && onChange(`${d < from ? d : from}_${d}`);
    // The tabs come last, against the right edge, so they stay put whatever the
    // mode: the month / year stepper or the two days open on their left.
    return (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
            {(mode === "month" || mode === "year") && (
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <button className="btn-ghost btn-icon btn-sm" title={`Previous ${mode}`} disabled={i < 0 || i >= list.length - 1} onClick={() => onChange(list[i + 1])}>
                        <Icon name="chevronLeft" />
                    </button>
                    <select className="input" style={{ width: "auto" }} value={period} onChange={(e) => onChange(e.target.value)} aria-label={mode === "month" ? "Month" : "Year"}>
                        {list.map((k) => <option key={k} value={k}>{periodName(k)}</option>)}
                    </select>
                    <button className="btn-ghost btn-icon btn-sm" title={`Next ${mode}`} disabled={i <= 0} onClick={() => onChange(list[i - 1])}>
                        <Icon name="chevronRight" />
                    </button>
                </div>
            )}
            {mode === "range" && (
                // A date field is ~4px taller than a select with the same padding;
                // trimmed so the row — and the tabs — keep the same height.
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <input type="date" className="input" style={DAY_INPUT} value={from} max={vnToday()} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
                    <span style={{ color: "var(--text-dim)", fontSize: 12 }}>to</span>
                    <input type="date" className="input" style={DAY_INPUT} value={to} max={vnToday()} onChange={(e) => setTo(e.target.value)} aria-label="To" />
                </div>
            )}
            <div className="tab-bar">
                {(allowRange ? [...MODES, ["range", "Custom"]] : MODES).map(([k, label]) => (
                    <button key={k} className={`tab-item ${mode === k ? "active" : ""}`} onClick={() => switchTo(k)}>
                        {label}
                    </button>
                ))}
            </div>
        </div>
    );
}
