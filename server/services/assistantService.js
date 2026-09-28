const axios = require("axios");
const integrations = require("./integrationService");

// HTTP client for the ArnTo-assistant decor API. Where it is reached is the
// "assistant" integration (see integrationService): linked to its project it
// follows that project across nodes, otherwise ASSISTANT_API_URL as before
// (default http://127.0.0.1:3000).
//   ASSISTANT_API_KEY  (must match the assistant's ASSISTANT_API_KEY)

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
            url: `${await integrations.baseUrl("assistant")}${path}`,
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
const listCategories = () => request("get", "/api/decors/categories", { needsKey: false });
const previewDecor = (fields) => request("post", "/api/decors/preview", { data: fields });
const importDecor = (fields) => request("post", "/api/decors/import", { data: fields, timeout: 20_000 });
const updateDecor = (skuId, fields) => request("patch", `/api/decors/import/${encodeURIComponent(skuId)}`, { data: fields });
const deleteDecor = (skuId) => request("delete", `/api/decors/import/${encodeURIComponent(skuId)}`);

// Price table (assistant DB `prices`): the original->selling-price lookup that
// GET /api/decors uses to compute sellingPrices. Key-guarded on the assistant.
const listPrices = () => request("get", "/api/decors/prices");
const upsertPrice = (fields) => request("put", "/api/decors/prices", { data: fields });
const deletePrice = (type, original) =>
    request("delete", `/api/decors/prices/${encodeURIComponent(type)}/${encodeURIComponent(original)}`);

module.exports = {
    listDecors,
    listCategories,
    previewDecor,
    importDecor,
    updateDecor,
    deleteDecor,
    listPrices,
    upsertPrice,
    deletePrice,
};
