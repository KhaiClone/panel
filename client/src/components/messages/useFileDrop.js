import { useRef, useState } from "react";

// Paste (Ctrl+V) and drag-and-drop of files onto a message, like Discord's own
// box: a screenshot, a picture copied from a browser or from Discord, or files
// from the computer. Spread `props` on the message's element and draw `over`
// (a file is being dragged above it).
//
// A paste that also carries text into a text box stays a text paste: Excel and
// Word put a picture of the selection on the clipboard next to the text, and
// pasting a table should not turn it into a file.

const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
const isTextBox = (el) => el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /^(text|search|url|)$/i.test(el.type || "")));

export default function useFileDrop(onFiles, { disabled = false } = {}) {
    const [over, setOver] = useState(false);
    const depth = useRef(0); // dragenter / dragleave fire for every child crossed
    if (disabled) return { over: false, props: {} };
    return {
        over,
        props: {
            onPaste: (e) => {
                const files = [...(e.clipboardData?.files || [])];
                if (!files.length) return;
                if (isTextBox(e.target) && e.clipboardData.getData("text/plain").trim()) return;
                e.preventDefault();
                onFiles(files);
            },
            onDragEnter: (e) => {
                if (!hasFiles(e)) return;
                e.preventDefault();
                depth.current += 1;
                setOver(true);
            },
            onDragOver: (e) => {
                if (!hasFiles(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
            },
            onDragLeave: (e) => {
                if (!hasFiles(e)) return;
                depth.current = Math.max(0, depth.current - 1);
                if (!depth.current) setOver(false);
            },
            onDrop: (e) => {
                if (!hasFiles(e)) return;
                e.preventDefault();
                depth.current = 0;
                setOver(false);
                const files = [...(e.dataTransfer.files || [])];
                if (files.length) onFiles(files);
            },
        },
    };
}
