export const fmtBytes = (bytes) => {
    if (!bytes && bytes !== 0) return "—";
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
};

/** Time since `ts` (ms): "42s", "5m 3s", "2h 10m", "3d 4h". */
export const fmtUptime = (ts) => {
    if (!ts) return "—";
    const diff = Date.now() - ts;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${sec % 60}s`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ${min % 60}m`;
    const day = Math.floor(hr / 24);
    return `${day}d ${hr % 24}h`;
};
