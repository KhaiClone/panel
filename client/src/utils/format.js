// Numbers and money as the whole panel shows them — English style (CLAUDE.md rule
// 29; the user picked "1,000,000 VND" on 2026-10-20). Every page formats through
// these two, so the style changes in one place.

const NUM = new Intl.NumberFormat("en-US");

/** 1234567 → "1,234,567"; anything that is not a number → "—". */
export const fmtNum = (n) => (Number.isFinite(n) ? NUM.format(n) : "—");

/** VND amount: 1000000 → "1,000,000 VND"; anything that is not a number → "—". */
export const money = (n) => (Number.isFinite(n) ? `${NUM.format(n)} VND` : "—");
