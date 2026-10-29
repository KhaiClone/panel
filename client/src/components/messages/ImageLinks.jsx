import { useState } from "react";
import Icon from "../ui/Icon";
import { IconBtn } from "./MessageEditor";
import { imageName } from "./format";

// Pictures attached by link (the message's `images`) — Discord draws them under
// the content like an uploaded picture, no embed needed. The page keeps only the
// links: the picture is downloaded when the message is sent (by the panel for a
// webhook, by ArnTo-assistant for its own messages), so a link must stay
// reachable until then. Used by the Messages and Webhooks pages.

const isLink = (s) => {
    try {
        const u = new URL(s);
        return u.protocol === "https:" || u.protocol === "http:";
    } catch {
        return false;
    }
};

function Row({ img, onRemove, onCopy }) {
    const [broken, setBroken] = useState(false);
    return (
        <div className="dh-file">
            {broken ? (
                <span title="The picture did not load here — check that the link opens the picture itself" style={{ display: "inline-flex", color: "var(--dh-yellow)" }}>
                    <Icon name="alert" size={15} />
                </span>
            ) : (
                <img src={img.url} alt="" onError={() => setBroken(true)} style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 4, flexShrink: 0 }} />
            )}
            <a href={img.url} target="_blank" rel="noreferrer" className="dh-file-name" title={img.url}>
                {img.name}
            </a>
            <span className="dh-count">link</span>
            {onCopy && <IconBtn icon="copy" title={`Copy attachment://${img.name} — paste it as an embed's image to show the picture inside the embed`} onClick={() => onCopy(img.name)} />}
            <IconBtn icon="trash" danger title="Remove" onClick={onRemove} />
        </div>
    );
}

/**
 * images: [{ url, name }]; room: how many more files the message can take;
 * taken: file names already on the message (a new picture gets another);
 * copyable: offer attachment://name for embeds (webhooks); disabled: why not, if not.
 */
export default function ImageLinks({ images = [], onChange, room, taken = [], copyable = false, disabled = "" }) {
    const [text, setText] = useState("");
    const [error, setError] = useState("");
    const copy = (name) => navigator.clipboard?.writeText(`attachment://${name}`);
    const add = () => {
        const links = text.split(/\s+/).filter(Boolean);
        if (!links.length) return;
        const wrong = links.find((l) => !isLink(l));
        if (wrong) return setError(`"${wrong.slice(0, 60)}" is not a link — paste the picture's address (https://…)`);
        if (links.length > room) return setError(room > 0 ? `Only ${room} more file${room === 1 ? "" : "s"} fit in this message` : "This message already has 10 files — Discord's limit");
        const names = new Set([...taken, ...images.map((x) => x.name)]);
        const added = links.map((url) => {
            const name = imageName(url, names);
            names.add(name);
            return { url, name };
        });
        onChange([...images, ...added]);
        setText("");
        setError("");
    };
    return (
        <>
            {images.map((img, i) => (
                <Row key={`${i}:${img.url}`} img={img} onCopy={copyable ? copy : null} onRemove={() => onChange(images.filter((_, k) => k !== i))} />
            ))}
            {disabled ? (
                <span className="dh-hint">{disabled}</span>
            ) : (
                <div className="dh-row" style={{ flexWrap: "nowrap" }}>
                    <input
                        className="dh-input"
                        value={text}
                        placeholder="https://…/picture.png — a picture's link"
                        onChange={(e) => {
                            setText(e.target.value);
                            setError("");
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                add();
                            }
                        }}
                    />
                    <button type="button" className="dh-btn primary" style={{ flexShrink: 0 }} disabled={!text.trim() || room <= 0} onClick={add}>
                        Add Image
                    </button>
                </div>
            )}
            {error && <span className="dh-hint" style={{ color: "var(--dh-red)" }}>{error}</span>}
        </>
    );
}
