import { useState } from "react";
import { describeVars, describeSlotVars, FILTER_DOCS } from "../../lib/uiTemplate";

// Every variable a template can use (its own, the focused slot's, the globals),
// the filters and the syntax — a click inserts it at the caret of the field
// that had the focus last.

const SNIPPETS = [
    ["{#if x}…{/if}", "{#if order.status == \"pending\"}…{#else}…{/if}", "Điều kiện (== != > < >= <=, && ||, !)"],
    ["{#each list}…{/each}", "{#each items}{@number}. {name}\n{/each}", "Lặp danh sách: {@number} {@index} {@first} {@last} {this}"],
    ["{x|default:\"…\"}", "|default:\"\"", "Giá trị khi rỗng"],
    ["\\{ \\}", "\\{\\}", "Dấu ngoặc nhọn thật"],
];

function Node({ node, depth, onInsert, listCtx }) {
    const [open, setOpen] = useState(depth < 1);
    const hasKids = node.children?.length > 0;
    const token = node.list ? `{#each ${node.path}}{/each}` : `{${node.path}}`;
    return (
        <div style={{ marginLeft: depth ? 12 : 0 }}>
            <div className="emb-var" onClick={() => onInsert(token)} title={node.list ? "Danh sách — chèn {#each}" : "Chèn"}>
                {hasKids && (
                    <span
                        onClick={(e) => {
                            e.stopPropagation();
                            setOpen(!open);
                        }}
                        style={{ color: "var(--text-dim)", width: 10, display: "inline-block" }}
                    >
                        {open ? "▾" : "▸"}
                    </span>
                )}
                <code>
                    {node.path}
                    {node.list ? "[]" : ""}
                    {node.optional ? "?" : ""}
                </code>
                <span>{node.label}</span>
            </div>
            {hasKids && open && (
                <div>
                    {node.list && <div style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: 22 }}>trong {"{#each " + node.path + "}"}:</div>}
                    {node.children.map((c) => (
                        <Node key={c.path} node={c} depth={depth + 1} onInsert={onInsert} listCtx={node.list || listCtx} />
                    ))}
                </div>
            )}
        </div>
    );
}

function Group({ title, children, defaultOpen = true }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div>
            <div onClick={() => setOpen(!open)} style={{ cursor: "pointer", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", margin: "6px 0 4px" }}>
                {open ? "▾" : "▸"} {title}
            </div>
            {open && children}
        </div>
    );
}

export default function VariablePanel({ def, types, custom, globals, active, onInsert }) {
    const { vars, globals: globalNodes } = describeVars(def, types, custom, globals);
    const slotNodes = describeSlotVars(def, types, active?.slot);
    return (
        <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 4 }}>
                {active?.label ? <>Bấm để chèn vào <b style={{ color: "var(--text)" }}>{active.label}</b></> : "Bấm vào một ô để chọn chỗ chèn"}
            </div>
            {slotNodes.length > 0 && (
                <Group title={`Riêng phần "${active.slot}"`}>
                    {slotNodes.map((n) => <Node key={n.path} node={n} depth={0} onInsert={onInsert} />)}
                </Group>
            )}
            <Group title="Biến của tin này">
                {vars.length ? vars.map((n) => <Node key={n.path} node={n} depth={0} onInsert={onInsert} />) : <div style={{ color: "var(--text-dim)" }}>Không có</div>}
            </Group>
            <Group title="Biến chung">
                {globalNodes.map((n) => <Node key={n.path} node={n} depth={0} onInsert={onInsert} />)}
            </Group>
            <Group title="Bộ lọc" defaultOpen={false}>
                {Object.entries(FILTER_DOCS).map(([name, doc]) => (
                    <div key={name} className="emb-var" onClick={() => onInsert(`|${name.split(" ")[0]}`)}>
                        <code>|{name}</code>
                        <span>{doc}</span>
                    </div>
                ))}
            </Group>
            <Group title="Cú pháp" defaultOpen={false}>
                {SNIPPETS.map(([title, snippet, doc]) => (
                    <div key={title} className="emb-var" onClick={() => onInsert(snippet)}>
                        <code>{title}</code>
                        <span>{doc}</span>
                    </div>
                ))}
            </Group>
        </div>
    );
}
