const axios = require("axios");

// HTTP client for the ArnTo-assistant decor API. The assistant bot runs on the
// same VPS as the panel, so this talks to it over localhost by default.
//   ASSISTANT_API_URL  (default http://127.0.0.1:3000)
//   ASSISTANT_API_KEY  (must match the assistant's ASSISTANT_API_KEY)

const BASE = () => (process.env.ASSISTANT_API_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const KEY = () => process.env.ASSISTANT_API_KEY || "";

const request = async (method, path, { data, timeout, needsKey = true } = {}) => {
    if (needsKey && !KEY()) {
        const e = new Error("Assistant integration not configured (ASSISTANT_API_KEY missing on the panel)");
        e.status = 503;
        throw e;
    }
    try {
        const res = await axios({
            method,
            url: `${BASE()}${path}`,
            data,
            timeout: timeout ?? 15_000,
            headers: needsKey ? { "x-api-key": KEY() } : {},
        });
        return res.data;
    } catch (err) {
        if (err.response?.data?.message || err.response?.data?.error) {
            const e = new Error(err.response.data.message || err.response.data.error);
            e.status = err.response.status;
            throw e;
        }
        const e = new Error(`ArnTo-assistant is unreachable (${err.code || err.message})`);
        e.status = 503;
        throw e;
    }
};

// GET /api/decors is public on the assistant, but we still send the key harmlessly.
const listDecors = () => request("get", "/api/decors", { needsKey: false });
const previewDecor = (fields) => request("post", "/api/decors/preview", { data: fields });
const importDecor = (fields) => request("post", "/api/decors/import", { data: fields, timeout: 20_000 });
const deleteDecor = (skuId) => request("delete", `/api/decors/import/${encodeURIComponent(skuId)}`);

module.exports = { listDecors, previewDecor, importDecor, deleteDecor };
