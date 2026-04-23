import { useState, useEffect } from "react";
import api from "../api/client";

export default function FileEditor({ botId }) {
    const [currentPath, setCurrentPath] = useState("");
    const [files, setFiles] = useState([]);
    const [selectedFile, setSelectedFile] = useState(null);
    const [content, setContent] = useState("");
    const [original, setOriginal] = useState("");
    const [loadingDir, setLoadingDir] = useState(true);
    const [loadingFile, setLoadingFile] = useState(false);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState(null);

    const loadDirectory = async (path = "") => {
        setLoadingDir(true);
        setMsg(null);
        try {
            const { data } = await api.get(`/bots/${botId}/fs/list?path=${encodeURIComponent(path)}`);
            setFiles(data.files || []);
            setCurrentPath(path);
        } catch (err) {
            setMsg({ type: "error", text: err.response?.data?.error || "Failed to load directory" });
        } finally {
            setLoadingDir(false);
        }
    };

    const openFile = async (filePath) => {
        if (isDirty && !window.confirm("You have unsaved changes. Discard them?")) {
            return;
        }

        setLoadingFile(true);
        setMsg(null);
        try {
            const { data } = await api.get(`/bots/${botId}/fs/read?path=${encodeURIComponent(filePath)}`);
            setContent(data.content);
            setOriginal(data.content);
            setSelectedFile(filePath);
        } catch (err) {
            setMsg({ type: "error", text: err.response?.data?.error || "Failed to load file" });
        } finally {
            setLoadingFile(false);
        }
    };

    const saveFile = async () => {
        if (!selectedFile) return;
        setSaving(true);
        setMsg(null);
        try {
            await api.put(`/bots/${botId}/fs/write`, { path: selectedFile, content });
            setOriginal(content);
            setMsg({ type: "success", text: "✅ File saved successfully" });
        } catch (err) {
            setMsg({ type: "error", text: err.response?.data?.error || "Save failed" });
        } finally {
            setSaving(false);
        }
    };

    useEffect(() => {
        loadDirectory("");
    }, [botId]);

    const isDirty = content !== original;

    // Breadcrumb parsing
    const parts = currentPath ? currentPath.split(/[\/\\]/).filter(Boolean) : [];
    
    const handleNavigateUp = () => {
        if (parts.length === 0) return;
        parts.pop();
        loadDirectory(parts.join("/"));
    };

    const handleNavigateTo = (index) => {
        const newPath = parts.slice(0, index + 1).join("/");
        loadDirectory(newPath);
    };

    return (
        <div className="flex flex-col md:flex-row gap-4 h-[600px]">
            {/* File Browser (Left) */}
            <div className="w-full md:w-1/3 flex flex-col border border-slate-700 rounded bg-slate-800/50 overflow-hidden">
                <div className="p-2 border-b border-slate-700 bg-slate-800 flex items-center gap-1 text-xs font-mono overflow-x-auto whitespace-nowrap scrollbar-thin">
                    <button 
                        className="text-indigo-400 hover:text-indigo-300 shrink-0" 
                        onClick={() => loadDirectory("")}
                    >
                        [root]
                    </button>
                    {parts.map((p, i) => (
                        <span key={i} className="flex items-center gap-1 shrink-0">
                            <span className="text-slate-500">/</span>
                            <button 
                                className="text-indigo-400 hover:text-indigo-300"
                                onClick={() => handleNavigateTo(i)}
                            >
                                {p}
                            </button>
                        </span>
                    ))}
                </div>
                
                <div className="flex-1 overflow-y-auto p-2 space-y-0.5 scrollbar-thin">
                    {loadingDir ? (
                        <div className="text-center text-slate-500 py-4 text-xs animate-pulse">Loading...</div>
                    ) : (
                        <>
                            {parts.length > 0 && (
                                <button
                                    className="w-full text-left px-2 py-1.5 text-xs text-slate-400 hover:bg-slate-700 rounded flex items-center gap-2"
                                    onClick={handleNavigateUp}
                                >
                                    <span>📁</span> ..
                                </button>
                            )}
                            {files.length === 0 && (
                                <div className="text-center text-slate-500 py-4 text-xs">Folder is empty</div>
                            )}
                            {files.map(f => {
                                const fullPath = currentPath ? `${currentPath}/${f.name}` : f.name;
                                const isSelected = selectedFile === fullPath;
                                return (
                                    <button
                                        key={f.name}
                                        className={`w-full text-left px-2 py-1.5 text-xs rounded flex items-center gap-2 truncate ${
                                            isSelected ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-700'
                                        }`}
                                        onClick={() => {
                                            if (f.isDir) {
                                                loadDirectory(fullPath);
                                            } else {
                                                openFile(fullPath);
                                            }
                                        }}
                                    >
                                        <span className="shrink-0">{f.isDir ? '📁' : '📄'}</span>
                                        <span className="truncate">{f.name}</span>
                                    </button>
                                );
                            })}
                        </>
                    )}
                </div>
            </div>

            {/* Editor (Right) */}
            <div className="w-full md:w-2/3 flex flex-col gap-3">
                {selectedFile ? (
                    <>
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 truncate">
                                <span className="text-sm font-semibold text-slate-200 truncate">
                                    {selectedFile.split(/[\/\\]/).pop()}
                                </span>
                                {isDirty && (
                                    <span className="text-xs text-amber-400 bg-amber-900/30 border border-amber-800 px-2 py-0.5 rounded shrink-0">
                                        Unsaved
                                    </span>
                                )}
                            </div>
                            <button
                                className="btn-primary text-xs py-1.5 shrink-0"
                                onClick={saveFile}
                                disabled={saving || !isDirty}
                            >
                                {saving ? "Saving…" : "💾 Save"}
                            </button>
                        </div>

                        {loadingFile ? (
                            <div className="flex-1 flex items-center justify-center border border-slate-700 rounded bg-slate-900/50">
                                <div className="animate-spin h-6 w-6 border-4 border-indigo-500 border-t-transparent rounded-full" />
                            </div>
                        ) : (
                            <textarea
                                className="input font-mono text-xs leading-relaxed resize-none flex-1 w-full"
                                value={content}
                                onChange={(e) => setContent(e.target.value)}
                                spellCheck={false}
                            />
                        )}
                        <p className="text-xs text-slate-500">
                            ⚠️ Restart the bot after saving for changes to take effect.
                        </p>
                    </>
                ) : (
                    <div className="flex-1 border border-slate-700 border-dashed rounded flex items-center justify-center text-slate-500 text-sm">
                        Select a file from the browser to edit
                    </div>
                )}
                
                {/* Feedback */}
                {msg && (
                    <div
                        className={`text-sm rounded-lg px-3 py-2 border ${
                            msg.type === "success"
                                ? "bg-emerald-900/40 border-emerald-700 text-emerald-400"
                                : "bg-red-900/40 border-red-700 text-red-400"
                        }`}
                    >
                        {msg.text}
                    </div>
                )}
            </div>
        </div>
    );
}
