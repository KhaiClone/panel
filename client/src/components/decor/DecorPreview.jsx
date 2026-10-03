import { useEffect, useMemo, useState } from "react";
import avatarPng from "../../assets/decor/avatar.png";
import profilePng from "../../assets/decor/profile.png";
import nameplatePng from "../../assets/decor/nameplate.png";

// ─────────────────────────────────────────────────────────────────────────────
//  How a decor looks on Discord — the decor site's previews (decor-site
//  assets/js/app.js, createDiscordProfileMock & co.), ported to React so the
//  Decors page shows exactly what customers see. Styles: pages/DecorsPage.css.
// ─────────────────────────────────────────────────────────────────────────────

// profile.png is 900 x 1760.
const PROFILE_ASPECT = 1760 / 900;
// A frame shows only the top half of the profile, so the frame itself is larger.
const FRAME_PROFILE_CROP = 0.5;

const intToHex = (n) => "#" + ((n >>> 0) & 0xffffff).toString(16).padStart(6, "0");
const colorsToGradient = (colors) => {
    const hex = colors.map(intToHex);
    return hex.length === 1 ? hex[0] : `linear-gradient(160deg, ${hex.join(", ")})`;
};

/** Bundle art: foreground over background, or over a gradient of its colours when it has one layer. */
export function BundleImage({ decor, className = "dp-bundle" }) {
    const assets = decor.assetURL || [];
    const style = !assets[1] && decor.backgroundColors?.length ? { background: colorsToGradient(decor.backgroundColors) } : undefined;
    return (
        <div className={className} style={style}>
            {assets[0] && <img className="dp-bundle-base" src={assets[0]} alt="" loading="lazy" />}
            {assets[1] && <img className="dp-bundle-overlay" src={assets[1]} alt="" loading="lazy" />}
        </div>
    );
}

function AvatarPreview({ decor }) {
    return (
        <div className="dp-avatar-preview">
            <img className="dp-avatar-base-img" src={avatarPng} alt="" />
            {decor.assetURL && <img className="dp-deco-img" src={decor.assetURL} alt="" loading="lazy" />}
        </div>
    );
}

function NameplatePreview({ decor }) {
    const dimRow = (widths) => (
        <div className="dp-chat-row dp-chat-row--dim">
            <div className="dp-chat-av dp-chat-av--dim" />
            <div className="dp-chat-lines">
                {widths.map((w, i) => <div key={i} className="dp-chat-line" style={{ width: w }} />)}
            </div>
        </div>
    );
    return (
        <div className="dp-chat-preview">
            {dimRow(["65%", "40%"])}
            <div className="dp-chat-row dp-chat-row--main">
                <div className="dp-nameplate-bg">
                    {decor.assetURL && <video src={decor.assetURL} autoPlay loop muted playsInline />}
                    <div className="dp-nameplate-av"><img src={nameplatePng} alt="" /></div>
                    <div className="dp-nameplate-name" />
                </div>
            </div>
            {dimRow(["50%", "75%"])}
        </div>
    );
}

/** Frame layers placed around the profile the way Discord renders them. */
function FramePreview({ decor }) {
    const f = decor.frame;
    if (!f?.layers?.length) {
        // Older / hand-imported frames: only the /preview image (or KhaiDevApi's composition).
        return (
            <div className="dp-frame-outer">
                <img className="dp-frame-fallback" src={decor.frameURL || decor.staticURL} alt="" loading="lazy" />
            </div>
        );
    }
    const { inner_width: iw, overflow_top: ot, overflow_bottom: ob, overflow_horizontal: oh } = f;
    // Shrink the stage so profile + overflow fit the square.
    const croppedAspect = PROFILE_ASPECT * FRAME_PROFILE_CROP;
    const totalW = 1 + (2 * oh) / iw;
    const totalH = croppedAspect + (ot + ob) / iw;
    const wPct = Math.min(100 / totalW, 100 / totalH) * 0.96;
    const stageStyle = {
        "--iw": iw,
        "--ot": ot,
        "--ob": ob,
        "--oh": oh,
        width: `${wPct}%`,
        // Absolute layers take no room: margins keep the overflow from being cut.
        marginTop: `${(wPct * ot) / iw}%`,
        marginBottom: `${(wPct * ob) / iw}%`,
    };
    return (
        <div className="dp-frame-outer">
            <div className="dp-frame-stage" style={stageStyle}>
                <div className="dp-frame-profile" style={{ aspectRatio: `1 / ${croppedAspect}` }}>
                    <img src={profilePng} alt="" />
                </div>
                {f.layers.map((layer) => (
                    <img
                        key={layer.id}
                        src={`https://cdn.discordapp.com/media/v1/collectibles-shop/${decor.sku_id}/${layer.id}/static`}
                        alt=""
                        loading="lazy"
                        className={`dp-frame-layer dp-frame-layer--${layer.anchor === "top" ? "top" : layer.anchor === "bottom" ? "bottom" : "center"} dp-frame-layer--${layer.order === "front" ? "front" : "back"}`}
                    />
                ))}
            </div>
        </div>
    );
}

const layerStyle = (effect) => ({ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", zIndex: effect.zIndex });

/** The looping layers only (or the static frame) — what a card shows at rest. */
function EffectLoop({ decor }) {
    const loops = useMemo(() => [...(decor.effects || [])].filter((e) => e.loop).sort((a, b) => a.zIndex - b.zIndex), [decor.effects]);
    if (!loops.length) {
        return decor.staticURL ? <img src={decor.staticURL} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null;
    }
    return loops.map((e, i) => <img key={i} src={e.src} alt="" style={layerStyle(e)} />);
}

/** One full play of the effect with Discord's timing: each layer shows at `start` for `duration`. */
function EffectCycle({ effects }) {
    const sorted = useMemo(() => [...effects].sort((a, b) => a.zIndex - b.zIndex), [effects]);
    const [stamp] = useState(() => Date.now()); // restarts the one-shot images
    const [shown, setShown] = useState(() => new Set());
    useEffect(() => {
        const timers = [];
        sorted.forEach((e, i) => {
            timers.push(setTimeout(() => setShown((s) => new Set(s).add(i)), e.start || 0));
            if (!e.loop) {
                timers.push(
                    setTimeout(() => setShown((s) => {
                        const next = new Set(s);
                        next.delete(i);
                        return next;
                    }), (e.start || 0) + (e.duration || 0)),
                );
            }
        });
        return () => timers.forEach(clearTimeout);
    }, [sorted]);
    return sorted.map((e, i) => (
        <img
            key={i}
            src={e.loop ? e.src : `${e.src}${e.src.includes("?") ? "&" : "?"}_t=${stamp}`}
            alt=""
            style={{ ...layerStyle(e), opacity: shown.has(i) ? 1 : 0, transition: "opacity 0.4s ease" }}
        />
    ));
}

/** `animate`: play the full effect (modal, hovered card); `replay` changes restart it. */
function ProfilePreview({ decor, animate, replay = 0 }) {
    const hasEffects = decor.effects?.length > 0;
    return (
        <div className="dp-profile-preview">
            <div className="dp-effect-layer">
                {animate && hasEffects ? <EffectCycle key={replay} effects={decor.effects} /> : <EffectLoop decor={decor} />}
            </div>
            <img className="dp-profile-base" src={profilePng} alt="" />
        </div>
    );
}

/**
 * The preview for any decor. `card`: square crop that plays the profile effect
 * on hover; otherwise the large modal version, animated.
 */
export default function DecorPreview({ decor, card = false, replay = 0 }) {
    const [hover, setHover] = useState(false);
    if (decor.type === 1000) return <BundleImage decor={decor} className={card ? "dp-bundle" : "dp-bundle dp-bundle--modal"} />;
    if (decor.type === 3) return <FramePreview decor={decor} />;
    if (decor.type === 0) return <AvatarPreview decor={decor} />;
    if (decor.type === 2) return <NameplatePreview decor={decor} />;
    if (!card) return <ProfilePreview decor={decor} animate replay={replay} />;
    return (
        <div className="dp-profile-crop" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
            <ProfilePreview decor={decor} animate={hover} />
        </div>
    );
}
