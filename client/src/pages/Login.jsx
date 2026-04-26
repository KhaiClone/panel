import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { motion, AnimatePresence } from "framer-motion";

export default function Login() {
    const { login } = useAuth();
    const navigate = useNavigate();

    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
            await login(username, password);
            navigate("/dashboard");
        } catch (err) {
            setError(
                err.response?.data?.error ||
                    "Login failed. Check your credentials.",
            );
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4 relative overflow-hidden">
            {/* Background Decoration */}
            <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-[20%] left-[10%] w-[50%] h-[50%] rounded-full bg-indigo-600/10 blur-[150px] animate-glow" />
                <div className="absolute bottom-[20%] right-[10%] w-[50%] h-[50%] rounded-full bg-blue-600/10 blur-[150px] animate-glow" style={{ animationDelay: '-2s' }} />
            </div>

            <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, ease: "easeOut" }}
                className="w-full max-w-sm relative z-10"
            >
                {/* Header */}
                <div className="text-center mb-10">
                    <motion.div 
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: "spring", stiffness: 200, delay: 0.2 }}
                        className="text-6xl mb-4 drop-shadow-2xl"
                    >
                        🤖
                    </motion.div>
                    <h1 className="text-4xl font-black text-slate-100 tracking-tight">
                        Bot Panel
                    </h1>
                    <p className="text-slate-500 text-xs font-black uppercase tracking-widest mt-2">
                        System Authentication
                    </p>
                </div>

                {/* Card */}
                <motion.div 
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.3 }}
                    className="card glass border-white/5 shadow-2xl p-8"
                >
                    <form onSubmit={handleSubmit} className="space-y-6">
                        <div className="space-y-2">
                            <label className="label">Access Username</label>
                            <input
                                type="text"
                                className="input py-3"
                                placeholder="Enter username"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                autoComplete="username"
                                required
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="label">Security Token</label>
                            <input
                                type="password"
                                className="input py-3"
                                placeholder="••••••••"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoComplete="current-password"
                                required
                            />
                        </div>

                        <AnimatePresence>
                            {error && (
                                <motion.div 
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    exit={{ opacity: 0, height: 0 }}
                                    className="bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs font-bold uppercase tracking-wider rounded-xl px-4 py-3 text-center"
                                >
                                    {error}
                                </motion.div>
                            )}
                        </AnimatePresence>

                        <button
                            type="submit"
                            className="btn-primary w-full py-3 font-black uppercase tracking-widest text-xs shadow-indigo-600/20 hover:shadow-indigo-600/40 transition-all active:scale-[0.98]"
                            disabled={loading}
                        >
                            {loading ? "Authenticating…" : "Grant Access"}
                        </button>
                    </form>
                </motion.div>

                <p className="text-center mt-8 text-[10px] font-black uppercase tracking-widest text-slate-600">
                    Protected by Multi-Layer Encryption
                </p>
            </motion.div>
        </div>
    );
}
