import { useState, useEffect, useRef } from "react";
import api from "../api/client";
import CodeMirrorEditor from "./CodeMirrorEditor";
import SQLiteViewer from "./SQLiteViewer";

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
    const [fileSize, setFileSize] = useState(null);

    const fileInputRef = useRef(null);

    const isDirty = content !== original;
    const parts = currentPath ? currentPath.split(/[\/\\]/).filter(Boolean) : [];

    const isSQLiteFile = (fileName) => {
        if (!fileName) return false;
        const ext = fileName.split('.').pop().toLowerCase();
        return ['db', 'sqlite', 'sqlite3'].includes(ext);
    };

    const formatFileSize = (bytes) => {
        if (!bytes) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

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
            const isSQLite = isSQLiteFile(filePath);
            const { data } = await api.get(`/bots/${botId}/fs/read?path=${encodeURIComponent(filePath)}${isSQLite ? '&binary=true' : ''}`);

            const file = files.find(f => {
                const fullPath = currentPath ? `${currentPath}/${f.name}` : f.name;
                return fullPath === filePath;
            });
            setFileSize(file ? file.size : null);

            if (isSQLite) {
                setContent(data.content);
            } else {
                setContent(typeof data.content === 'string' ? data.content : String(data.content));
            }

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
            const isSQLite = isSQLiteFile(selectedFile);
            await api.put(`/bots/${botId}/fs/write`, { path: selectedFile, content, binary: isSQLite });
            setOriginal(content);
            setMsg({ type: "success", text: "✅ File saved successfully" });
        } catch (err) {
            setMsg({ type: "error", text: err.response?.data?.error || "Save failed" });
        } finally {
            setSaving(false);
        }
    };

    const handleCreate = async (type) => {
        const name = window.prompt(`Enter new ${type} name:`);
        if (!name) return;
        
        const newPath = currentPath ? `${currentPath}/${name}` : name;
        try {
            await api.post(`/bots/${botId}/fs/create`, { path: newPath, type });
            loadDirectory(currentPath);
            setMsg({ type: "success", text: `✅ Created ${name}` });
        } catch (err) {
            setMsg({ type: "error", text: err.response?.data?.error || "Failed to create" });
        }
    };

    const handleDelete = async (e, f) => {
        e.stopPropagation();
        const pathToDelete = currentPath ? `${currentPath}/${f.name}` : f.name;
        if (!window.confirm(`Are you sure you want to delete ${f.name}?`)) return;

        try {
            await api.delete(`/bots/${botId}/fs/delete`, { data: { path: pathToDelete } });
            if (selectedFile === pathToDelete) {
                setSelectedFile(null); setContent(""); setOriginal(""); setFileSize(null);
            }
            loadDirectory(currentPath);
            setMsg({ type: "success", text: `✅ Deleted ${f.name}` });
        } catch (err) {
            setMsg({ type: "error", text: err.response?.data?.error || "Failed to delete" });
        }
    };

    const handleRename = async (e, f) => {
        e.stopPropagation();
        const oldPath = currentPath ? `${currentPath}/${f.name}` : f.name;
        const newName = window.prompt("Enter new name:", f.name);
        if (!newName || newName === f.name) return;
        
        const newPath = currentPath ? `${currentPath}/${newName}` : newName;
        try {
            await api.put(`/bots/${botId}/fs/rename`, { oldPath, newPath });
            if (selectedFile === oldPath) setSelectedFile(newPath);
            loadDirectory(currentPath);
            setMsg({ type: "success", text: `✅ Renamed to ${newName}` });
        } catch (err) {
            setMsg({ type: "error", text: err.response?.data?.error || "Failed to rename" });
        }
    };

    const handleUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const formData = new FormData();
        formData.append("path", currentPath);
        formData.append("file", file);

        setMsg(null);
        try {
            await api.post(`/bots/${botId}/fs/upload`, formData, { headers: { "Content-Type": "multipart/form-data" } });
            loadDirectory(currentPath);
            setMsg({ type: "success", text: `✅ Uploaded ${file.name}` });
        } catch (err) {
            setMsg({ type: "error", text: err.response?.data?.error || "Upload failed" });
        } finally {
            e.target.value = "";
        }
    };

    const handleDownload = (e, f) => {
        e.stopPropagation();
        const filePath = currentPath ? `${currentPath}/${f.name}` : f.name;
        const token = localStorage.getItem("token");
        const url = `/api/bots/${botId}/fs/download?path=${encodeURIComponent(filePath)}&token=${token}`;
        window.open(url, "_blank");
    };

    useEffect(() => { loadDirectory(""); }, [botId]);

    const handleNavigateUp = () => {
        if (parts.length === 0) return;
        parts.pop();
        loadDirectory(parts.join("/"));
    };

    return (
        <div style={{ display: "flex", gap: 16, height: 600, padding: 16, background: "var(--bg-card)", borderRadius: 12 }}>
            {/* File Browser (Left) */}
            <div style={{ width: "30%", display: "flex", flexDirection: "column", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                {/* Actions Toolbar */}
                <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(0,0,0,0.15)" }}>
                    <div style={{ display: "flex", gap: 12 }}>
                        <button style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 16 }} onClick={() => handleCreate('file')} title="New File">📄</button>
                        <button style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 16 }} onClick={() => handleCreate('dir')} title="New Folder">📁</button>
                        <button style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 16 }} onClick={() => fileInputRef.current?.click()} title="Upload File">⬆️</button>
                        <input type="file" ref={fileInputRef} style={{ display: "none" }} onChange={handleUpload} />
                    </div>
                    <button style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 14 }} onClick={() => loadDirectory(currentPath)} title="Refresh">🔄</button>
                </div>

                {/* Breadcrumbs */}
                <div className="mono no-scrollbar" style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", background: "rgba(0,0,0,0.1)", display: "flex", alignItems: "center", gap: 6, fontSize: 12, overflowX: "auto", whiteSpace: "nowrap" }}>
                    <button style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent-hover)", padding: 0 }} onClick={() => loadDirectory("")}>~</button>
                    {parts.map((p, i) => (
                        <span key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ color: "var(--text-dim)" }}>/</span>
                            <button style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text)", padding: 0 }} onClick={() => loadDirectory(parts.slice(0, i + 1).join("/"))}>
                                {p}
                            </button>
                        </span>
                    ))}
                </div>
                
                {/* File List */}
                <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
                    {loadingDir ? (
                        <div style={{ textAlign: "center", color: "var(--text-dim)", padding: 20, fontSize: 13, fontStyle: "italic" }}>Loading...</div>
                    ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {parts.length > 0 && (
                                <button
                                    onClick={handleNavigateUp}
                                    style={{ width: "100%", textAlign: "left", padding: "6px 10px", fontSize: 13, color: "var(--text-muted)", background: "transparent", border: "none", cursor: "pointer", borderRadius: 6, display: "flex", gap: 8, alignItems: "center" }}
                                    onMouseOver={e => e.currentTarget.style.background = "var(--bg-input)"}
                                    onMouseOut={e => e.currentTarget.style.background = "transparent"}
                                >
                                    <span>📁</span> ..
                                </button>
                            )}
                            {files.length === 0 && (
                                <div style={{ textAlign: "center", color: "var(--text-dim)", padding: 20, fontSize: 13 }}>Empty directory</div>
                            )}
                            {files.map(f => {
                                const fullPath = currentPath ? `${currentPath}/${f.name}` : f.name;
                                const isSelected = selectedFile === fullPath;
                                return (
                                    <div
                                        key={f.name}
                                        style={{
                                            width: "100%", padding: "6px 10px", fontSize: 13, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer",
                                            background: isSelected ? "var(--accent)" : "transparent",
                                            color: isSelected ? "#fff" : "var(--text)",
                                        }}
                                        onMouseOver={e => { if (!isSelected) e.currentTarget.style.background = "var(--bg-input)"; }}
                                        onMouseOut={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                                        onClick={() => f.isDir ? loadDirectory(fullPath) : openFile(fullPath)}
                                    >
                                        <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
                                            <span style={{ flexShrink: 0 }}>{f.isDir ? '📁' : '📄'}</span>
                                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                                        </div>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                                            <div style={{ display: "flex", gap: 4, opacity: isSelected ? 1 : 0.4 }}>
                                                {!f.isDir && <button style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }} onClick={e => handleDownload(e, f)}>⬇️</button>}
                                                <button style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }} onClick={e => handleRename(e, f)}>✏️</button>
                                                <button style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }} onClick={e => handleDelete(e, f)}>🗑️</button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* Editor (Right) */}
            <div style={{ width: "70%", display: "flex", flexDirection: "column", gap: 12 }}>
                {selectedFile ? (
                    <>
                        <div style={{ display: "flex", alignItems: "center", justifyItems: "space-between", gap: 12 }}>
                            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 12 }}>
                                <span className="mono" style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>
                                    {selectedFile.split(/[\/\\]/).pop()}
                                </span>
                                {fileSize && <span className="badge" style={{ background: "var(--bg-input)", color: "var(--text-muted)" }}>{formatFileSize(fileSize)}</span>}
                                {isDirty && <span className="badge" style={{ background: "var(--warning-bg)", color: "var(--warning)" }}>Unsaved changes</span>}
                            </div>
                            <div style={{ display: "flex", gap: 8 }}>
                                <button className="btn-primary" onClick={saveFile} disabled={saving || !isDirty} style={{ padding: "6px 16px" }}>
                                    {saving ? "Saving…" : "💾 Save File"}
                                </button>
                            </div>
                        </div>

                        {loadingFile ? (
                            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-input)" }}>
                                <div style={{ width: 30, height: 30, borderRadius: "50%", border: "3px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 1s linear infinite" }} />
                            </div>
                        ) : isSQLiteFile(selectedFile) ? (
                            <div style={{ flex: 1, overflow: "hidden", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-input)" }}>
                                <SQLiteViewer fileContent={content} fileName={selectedFile.split(/[\/\\]/).pop()} />
                            </div>
                        ) : (
                            <div style={{ flex: 1, overflow: "hidden", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-input)" }}>
                                <CodeMirrorEditor value={content} onChange={setContent} fileName={selectedFile} />
                            </div>
                        )}
                        
                        {msg && (
                            <div style={{
                                padding: "8px 12px", borderRadius: 8, fontSize: 13,
                                background: msg.type === "success" ? "var(--success-bg)" : "var(--danger-bg)",
                                color: msg.type === "success" ? "var(--success)" : "var(--danger)",
                                border: `1px solid ${msg.type === "success" ? "var(--success-border)" : "var(--danger-border)"}`
                            }}>
                                {msg.text}
                            </div>
                        )}
                    </>
                ) : (
                    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", border: "1px dashed var(--border)", borderRadius: 10, color: "var(--text-dim)", fontSize: 14 }}>
                        Select a file from the explorer to view and edit
                    </div>
                )}
            </div>
        </div>
    );
}
