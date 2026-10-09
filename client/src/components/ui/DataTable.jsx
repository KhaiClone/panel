/**
 * A scrolling frame around a .data-table, with its header row.
 *
 *   <DataTable columns={["Order ID", "Product", { label: "Price", align: "right" }, ""]} minWidth={720}>
 *       {rows.map((r) => <tr key={r.id}><td>…</td></tr>)}
 *   </DataTable>
 *
 * Cells take the helper classes in index.css: .nowrap, .num (right, tabular),
 * .actions (right, buttons in a row), .muted, and .cell-sub for a second line.
 * `flush` drops the frame's own border, for a table that fills a card.
 */
export default function DataTable({ columns, minWidth, flush = false, children }) {
    return (
        <div className={`table-wrap${flush ? " flush" : ""}`}>
            <table className="data-table" style={minWidth ? { minWidth } : undefined}>
                <thead>
                    <tr>
                        {columns.map((c, i) => {
                            const col = typeof c === "string" ? { label: c } : c;
                            return (
                                <th key={`${col.label}-${i}`} style={{ textAlign: col.align || "left", width: col.width }}>
                                    {col.label}
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>{children}</tbody>
            </table>
        </div>
    );
}
