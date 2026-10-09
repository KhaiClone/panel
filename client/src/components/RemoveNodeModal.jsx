import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import api from "../api/client";

// ─────────────────────────────────────────────────────────────────────────────
//  RemoveNodeModal — the way back from "Add node".
//
//  Three choices (services/nodeRemoval.js on the server):
//    everything   the agent uninstalls itself and undoes the whole setup
//    some parts   the agent always goes; SSH keys, firewall and packages each
//                 go only when ticked
//    panel only   the panel forgets the node; nothing on the VPS is touched
//
//  It loads /nodes/:id/impact first: projects still on the node block the
//  removal (each links to its page, to move it), copies left there by a forced
//  move and Egress Proxy pins through the node are spelled out before choosing.
//
//  Once started the modal follows the removal: the panel's own clean-up steps,
//  and the output the VPS's uninstall script reports back. The Systems page
//  lists the same removals for a day (RemovalStatus).
// ─────────────────────────────────────────────────────────────────────────────

const STEP_ICON = { running: "⏳", ok: "✅", warn: "⚠️", error: "❌" };
const POLL_MS = 3000;

const CHOICES = [
    {
        key: "all",
        title: "Remove everything",
        desc: "Undo the whole setup on the VPS: the agent, Lavalink, WireGuard, the panel's SSH keys, the firewall changes and the packages the setup installed. Packages that were there before and system upgrades stay.",
    },
    {
        key: "some",
        title: "Remove some parts",
        desc: "The agent always goes. Pick what else should.",
    },
    {
        key: "panel",
        title: "Only from the panel",
        desc: "Nothing on the VPS is touched: the agent, Lavalink and everything else keep running there, but the panel no longer sees or controls them.",
    },
];

const PARTS = [
    {
        key: "ssh",
        short: "SSH keys",
        label: "SSH keys and git config the panel copied",
        hint: "The panel's GitHub deploy keys. Keep them only if you still pull repos on this VPS yourself.",
    },
    {
        key: "firewall",
        short: "the firewall changes",
        label: "Firewall back to how it was",
        hint: "Removes the 80/443 rules the setup added, and turns UFW off again if the setup turned it on.",
    },
    {
        key: "packages",
        short: "the packages",
        label: "Packages the setup installed",
        hint: "nginx, certbot, WireGuard, Java, Chrome, Node.js, PM2, build tools: only the ones the setup newly installed, and only if nothing installed later needs them.",
    },
];
const ALL_PARTS = PARTS.map((p) => p.key);

/** The command for the VPS, as the server's nodeRemoval.manualCommand builds it. */
const manualCommand = (parts) =>
    `sudo bash ~/panel/agent/uninstall-agent.sh "$USER"` +
    [["packages", "--keep-packages"], ["ssh", "--keep-ssh-keys"], ["firewall", "--keep-firewall"]]
        .filter(([p]) => !parts.includes(p))
        .map(([, flag]) => ` ${flag}`)
        .join("");

const box = (kind, children) => {
    const c = {
        danger: ["var(--danger-bg)", "var(--danger)", "var(--danger-border)"],
        warn: ["var(--warning-bg)", "var(--warning)", "var(--warning-border)"],
        info: ["var(--bg-input)", "var(--text-muted)", "var(--border)"],
    }[kind];
    return (
        <div style={{ padding: "10px 14px", borderRadius: 8, background: c[0], color: c[1], border: `1px solid ${c[2]}`, fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {children}
        </div>
    );
};

const projectPath = (b) => `/${b.projectType === "website" ? "sites" : "bots"}/${b._id}`;

const listStyle = { margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.7 };

const ProjectLink = ({ bot, onOpen }) => (
    <a href={projectPath(bot)} onClick={(e) => { e.preventDefault(); onOpen(projectPath(bot)); }} style={{ color: "var(--accent-hover)" }}>{bot.name}</a>
);

const Command = ({ text }) => (
    <pre className="mono" style={{ margin: "6px 0 0", padding: "8px 10px", fontSize: 12, borderRadius: 6, background: "var(--bg-input)", color: "var(--text)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "all" }}>
        {text}
    </pre>
);

/** Is anything about this removal still going on? */
export const removalActive = (r) => !r.done || r.vps?.status === "running";

const vpsHeadline = (r) => {
    const v = r.vps;
    if (!v) return null;
    return {
        running: `Removing the agent from ${r.host}…`,
        done: `${r.host} is cleaned up.`,
        failed: `The clean-up on ${r.host} stopped before the end — see its output.`,
        lost: `No word from ${r.host} for 30 minutes.${v.detail ? ` Its output on the VPS: ${v.detail}` : ""}`,
    }[v.status] || v.status;
};

/** The panel's steps and the VPS's output for one removal. */
export function RemovalStatus({ removal: r }) {
    const logRef = useRef(null);
    const log = r.vps?.log || "";
    useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, [log]);

    const v = r.vps;
    const vpsColor = !v ? null : v.status === "done" ? "var(--success)" : v.status === "running" ? "var(--text)" : "var(--danger)";
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                <strong style={{ fontSize: 13, color: "var(--text)" }}>Panel</strong>
                {r.steps.map((s, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "flex-start" }}>
                        <span>{STEP_ICON[s.status] || "•"}</span>
                        <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ color: "var(--text)" }}>{s.label}</div>
                            {s.detail && (
                                <pre className="mono" style={{ margin: "2px 0 0", fontSize: 11, color: s.status === "error" ? "var(--danger)" : "var(--text-dim)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{s.detail}</pre>
                            )}
                        </div>
                    </div>
                ))}
                {!r.done && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>⏳ Cleaning up what the panel kept for the node…</div>}
            </div>

            {v && (
                <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                    <strong style={{ fontSize: 13, color: vpsColor }}>{vpsHeadline(r)}</strong>
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        {r.parts.length === ALL_PARTS.length
                            ? "Everything the setup did is undone."
                            : `The agent goes${r.parts.length ? `, with ${r.parts.map((p) => PARTS.find((x) => x.key === p)?.short || p).join(" and ")}` : ""}; ${PARTS.filter((p) => !r.parts.includes(p.key)).map((p) => p.short).join(" and ")} stay.`}
                    </span>
                    <pre ref={logRef} className="mono" style={{ margin: 0, padding: "10px 12px", fontSize: 11, lineHeight: 1.55, borderRadius: 6, background: "var(--bg-base)", color: "var(--text-muted)", maxHeight: 260, overflowY: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                        {log || (v.status === "running" ? "Waiting for the VPS's first report…" : "(the VPS sent no output)")}
                    </pre>
                </div>
            )}
        </div>
    );
}

/** onOpenProject(path) — leave for a project's page (the modal closes with this one). */
export default function RemoveNodeModal({ node, onClose, onRemoved, onOpenProject }) {
    const [impact, setImpact] = useState(null);
    const [impactError, setImpactError] = useState("");
    const [choice, setChoice] = useState(null);
    const [parts, setParts] = useState(["ssh"]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [removal, setRemoval] = useState(null);

    useEffect(() => {
        api.get(`/nodes/${node._id}/impact`)
            .then((r) => setImpact(r.data))
            .catch((e) => setImpactError(e.response?.data?.error || "Could not check what is on this node"));
    }, [node._id]);

    const online = node.status === "online";
    const blocked = !impact || impact.isPanelNode || impact.bots.length > 0;
    const chosenParts = choice === "all" ? ALL_PARTS : choice === "some" ? parts : [];
    const toggle = (key) => setParts((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));

    const submit = async () => {
        setBusy(true);
        setError("");
        try {
            const { data } = await api.post(
                `/nodes/${node._id}/remove`,
                { mode: choice === "panel" ? "panel" : "vps", parts: chosenParts, origin: window.location.origin },
                { timeout: 120_000 },
            );
            setRemoval(data);
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setBusy(false);
        }
    };

    // Follow the removal until both sides are finished.
    const removalId = removal?.id;
    const active = removal ? removalActive(removal) : false;
    useEffect(() => {
        if (!removalId || !active) return undefined;
        const t = setInterval(async () => {
            try {
                const { data } = await api.get(`/nodes/removals/${removalId}`);
                setRemoval(data);
            } catch { /* keep polling — the panel may be briefly busy */ }
        }, POLL_MS);
        return () => clearInterval(t);
    }, [removalId, active]);

    // The node is gone from the moment the removal exists: leaving goes to the list.
    const close = removal ? onRemoved : onClose;

    return createPortal(
        <div className="modal-overlay" onClick={busy ? undefined : close}>
            <div className="card slide-up modal-card-mobile" style={{ width: "100%", maxWidth: 600, padding: 0, maxHeight: "90vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
                <div style={{ padding: "18px 24px", borderBottom: "1px solid var(--border-light)", display: "flex", alignItems: "center", gap: 12 }}>
                    <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, flex: 1 }}>
                        {removal ? `Removing "${removal.name}"` : `Remove node "${node.name}"`}
                    </h2>
                    {!busy && (
                        <button onClick={close} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 18 }}>✕</button>
                    )}
                </div>

                <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
                    {removal ? (
                        <>
                            <RemovalStatus removal={removal} />
                            {removal.mode === "panel" && box("info", <>To clean up the VPS later, run there as the account the agent ran as:<Command text={manualCommand(ALL_PARTS)} />Add --keep-packages, --keep-ssh-keys or --keep-firewall to keep those.</>)}
                        </>
                    ) : (
                        <>
                            {!impact && !impactError && box("info", "Checking what is on this node…")}
                            {impactError && box("danger", impactError)}
                            {impact?.isPanelNode && box("danger", "This is the node the panel itself runs on — it cannot be removed. Move the panel to another node first (Panel Settings → Move Panel).")}
                            {impact && !impact.isPanelNode && impact.bots.length > 0 && box("danger", (
                                <>
                                    <b>{impact.bots.length} project(s) still live on this node</b>, so it cannot be removed yet — the panel would lose track of them.
                                    {" "}Open each one → Manage → <b>Move to another node</b>.{!online && " While the node is offline that rebuilds it from git on the new node."}
                                    <ul style={listStyle}>
                                        {impact.bots.map((b) => (
                                            <li key={b._id}>
                                                <ProjectLink bot={b} onOpen={onOpenProject} />
                                                {!b.canRebuild && !online && " — no git repo, cannot be rebuilt while the node is offline"}
                                            </li>
                                        ))}
                                    </ul>
                                </>
                            ))}

                            {!blocked && impact.staleCopies.length > 0 && box("warn", (
                                <>
                                    ⚠ {impact.staleCopies.length} project(s) were moved off this node while it was down and are still in its PM2 list. The panel would stop them when the node answers again; once it is removed it cannot. If that machine boots again they run <b>alongside their new copies</b> — stop them there:
                                    <ul style={listStyle}>
                                        {impact.staleCopies.map((c) => (
                                            <li key={c.pm2Name}>{c.name} — <span className="mono">pm2 delete {c.pm2Name} && pm2 save</span></li>
                                        ))}
                                    </ul>
                                </>
                            ))}
                            {!blocked && impact.egressBots.length > 0 && box("info", (
                                <>
                                    {impact.egressBots.length} project(s) send their traffic through this node (Bot Egress). Their pin is cleared; restart them to use their own node&apos;s IP:
                                    <ul style={listStyle}>
                                        {impact.egressBots.map((b) => (
                                            <li key={b._id}><ProjectLink bot={b} onOpen={onOpenProject} /></li>
                                        ))}
                                    </ul>
                                </>
                            ))}

                            {!blocked && (
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    {CHOICES.map((c) => (
                                        <div key={c.key} className="card" style={{ padding: "12px 14px", borderColor: choice === c.key ? (c.key === "panel" ? "var(--accent)" : "var(--danger)") : undefined }}>
                                            <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
                                                <input type="radio" name="remove-choice" checked={choice === c.key} onChange={() => setChoice(c.key)} style={{ marginTop: 3 }} />
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{c.title}</div>
                                                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.5 }}>{c.desc}</div>
                                                </div>
                                            </label>
                                            {c.key === "some" && choice === "some" && (
                                                <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "10px 0 0 24px" }}>
                                                    <label style={{ display: "flex", gap: 8, fontSize: 13, color: "var(--text-dim)" }}>
                                                        <input type="checkbox" checked disabled style={{ marginTop: 2 }} />
                                                        <span>Always: the agent and its PM2 processes, Lavalink, WireGuard, the panel&apos;s firewall rules, nginx site and certificates, ~/panel</span>
                                                    </label>
                                                    {PARTS.map((p) => (
                                                        <label key={p.key} style={{ display: "flex", gap: 8, fontSize: 13, color: "var(--text)", cursor: "pointer" }}>
                                                            <input type="checkbox" checked={parts.includes(p.key)} onChange={() => toggle(p.key)} style={{ marginTop: 2 }} />
                                                            <span>
                                                                {p.label}
                                                                <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>{p.hint}</span>
                                                            </span>
                                                        </label>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}

                            {choice && choice !== "panel" && !online &&
                                box("warn", <>The agent on {node.host} is not answering, so the panel cannot clean the VPS up. Remove the node from the panel only, then run on the VPS:<Command text={manualCommand(chosenParts)} /></>)}
                            {choice === "panel" &&
                                box("info", <>The machine is left as it is. To clean it up later, run there as the account the agent ran as:<Command text={manualCommand(ALL_PARTS)} /></>)}
                            {choice && choice !== "panel" &&
                                box("info", "Projects' own folders are kept if any are left, and so is anything that was on the VPS before the setup. The node that runs the panel can never be removed this way.")}
                            {error && box("danger", error)}
                        </>
                    )}
                </div>

                <div style={{ padding: "14px 24px", borderTop: "1px solid var(--border-light)", display: "flex", justifyContent: "flex-end", gap: 12 }}>
                    {removal ? (
                        <button type="button" className={active ? "btn-ghost" : "btn-primary"} onClick={close}>
                            {active ? "Close (it goes on)" : "Done"}
                        </button>
                    ) : (
                        <>
                            <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>{impact && blocked ? "Close" : "Cancel"}</button>
                            {!blocked && (
                                <button type="button" className="btn-danger" onClick={submit} disabled={busy || !choice}>
                                    {busy ? "Starting…" : choice === "panel" ? "Remove from the panel" : choice === "all" ? "Remove everything" : "Remove node"}
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}
