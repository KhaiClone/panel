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

            // Get file size from the files list
            const file = files.find(f => {
                const fullPath = currentPath ? `${currentPath}/${f.name}` : f.name;
                return fullPath === filePath;
            });
            setFileSize(file ? file.size : null);

            if (isSQLite) {
                // For SQLite files, keep the binary content
                setContent(data.content);
            } else {
                // For text files, ensure content is a string
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
            await api.put(`/bots/${botId}/fs/write`, {
                path: selectedFile,
                content,
                binary: isSQLite
            });
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
                setSelectedFile(null);
                setContent("");
                setOriginal("");
                setFileSize(null);
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
            if (selectedFile === oldPath) {
                setSelectedFile(newPath);
            }
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
            await api.post(`/bots/${botId}/fs/upload`, formData, {
                headers: { "Content-Type": "multipart/form-data" }
            });
            loadDirectory(currentPath);
            setMsg({ type: "success", text: `✅ Uploaded ${file.name}` });
        } catch (err) {
            setMsg({ type: "error", text: err.response?.data?.error || "Upload failed" });
        } finally {
            e.target.value = ""; // Reset input
        }
    };

    const handleDownload = (e, f) => {
        e.stopPropagation();
        const filePath = currentPath ? `${currentPath}/${f.name}` : f.name;
        const token = localStorage.getItem("token");
        // SSE/Download needs token in query param
        const url = `/api/bots/${botId}/fs/download?path=${encodeURIComponent(filePath)}&token=${token}`;
        window.open(url, "_blank");
    };

    useEffect(() => {
        loadDirectory("");
    }, [botId]);

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
                {/* Actions Toolbar */}
                <div className="p-2 border-b border-slate-700 bg-slate-800 flex items-center justify-between gap-2 text-xs">
                    <div className="flex gap-2">
                        <button className="text-slate-300 hover:text-emerald-400" onClick={() => handleCreate('file')} title="New File">📄+</button>
                        <button className="text-slate-300 hover:text-emerald-400" onClick={() => handleCreate('dir')} title="New Folder">📁+</button>
                        <button className="text-slate-300 hover:text-indigo-400" onClick={() => fileInputRef.current?.click()} title="Upload File">⬆️ Upload</button>
                        <input type="file" ref={fileInputRef} className="hidden" onChange={handleUpload} />
                    </div>
                    <button className="text-slate-400 hover:text-slate-200" onClick={() => loadDirectory(currentPath)} title="Refresh">🔄</button>
                </div>

                {/* Breadcrumbs */}
                <div className="px-2 py-1.5 border-b border-slate-700 bg-slate-800/80 flex items-center gap-1 text-xs font-mono overflow-x-auto whitespace-nowrap scrollbar-thin">
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
                
                {/* File List */}
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
                                    <div
                                        key={f.name}
                                        className={`group w-full text-left px-2 py-1.5 text-xs rounded flex items-center justify-between gap-2 cursor-pointer ${
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
                                        <div className="flex items-center gap-2 truncate flex-1">
                                            <span className="shrink-0">{f.isDir ? '📁' : '📄'}</span>
                                            <span className="truncate">{f.name}</span>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            {!f.isDir && (
                                                <span className={`text-xs ${isSelected ? 'text-indigo-200' : 'text-slate-500'}`}>
                                                    {formatFileSize(f.size)}
                                                </span>
                                            )}
                                            <div className={`flex items-center gap-2 transition-opacity ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                                                {f.isDir ? null : (
                                                    <button
                                                        className="hover:text-indigo-400"
                                                        onClick={(e) => handleDownload(e, f)}
                                                        title="Download"
                                                    >
                                                        ⬇️
                                                    </button>
                                                )}
                                                <button
                                                    className="hover:text-amber-300"
                                                    onClick={(e) => handleRename(e, f)}
                                                    title="Rename"
                                                >
                                                    ✏️
                                                </button>
                                                <button
                                                    className="hover:text-red-400"
                                                    onClick={(e) => handleDelete(e, f)}
                                                    title="Delete"
                                                >
                                                    🗑️
                                                </button>
                                            </div>
                                        </div>
                                    </div>
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
                                {fileSize && (
                                    <span className="text-xs text-slate-500 bg-slate-800 px-2 py-1 rounded border border-slate-700">
                                        {formatFileSize(fileSize)}
                                    </span>
                                )}
                                {isDirty && (
                                    <span className="text-xs text-amber-400 bg-amber-900/30 border border-amber-800 px-2 py-0.5 rounded shrink-0">
                                        Unsaved
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    className="btn-ghost text-xs py-1.5 px-3"
                                    onClick={() => {
                                        const token = localStorage.getItem("token");
                                        const url = `/api/bots/${botId}/fs/download?path=${encodeURIComponent(selectedFile)}&token=${token}`;
                                        window.open(url, "_blank");
                                    }}
                                    title="Download File"
                                >
                                    ⬇️ Download
                                </button>
                                <button
                                    className="btn-primary text-xs py-1.5 shrink-0"
                                    onClick={saveFile}
                                    disabled={saving || !isDirty}
                                >
                                    {saving ? "Saving…" : "💾 Save"}
                                </button>
                            </div>
                        </div>

                        {loadingFile ? (
                            <div className="flex-1 flex items-center justify-center border border-slate-700 rounded bg-slate-900/50">
                                <div className="animate-spin h-6 w-6 border-4 border-indigo-500 border-t-transparent rounded-full" />
                            </div>
                        ) : isSQLiteFile(selectedFile) ? (
                            <div className="flex-1 min-h-[300px] overflow-hidden border border-slate-700 rounded bg-slate-900/50">
                                <SQLiteViewer
                                    fileContent={content}
                                    fileName={selectedFile.split(/[\/\\]/).pop()}
                                />
                            </div>
                        ) : (
                            <div className="flex-1 min-h-[300px] overflow-hidden border border-slate-700 rounded bg-slate-900/50">
                                <CodeMirrorEditor
                                    value={content}
                                    onChange={setContent}
                                    fileName={selectedFile}
                                />
                            </div>
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
