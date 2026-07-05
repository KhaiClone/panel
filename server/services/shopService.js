const axios = require("axios");

// HTTP client for the ArnTo-Shop Orders API. The shop bot runs on the same VPS
// as the panel, so this talks to it over localhost by default — no public
// exposure. Configure via env:
//   SHOP_API_URL  (default http://127.0.0.1:3000)
//   SHOP_API_KEY  (must match the shop's SHOP_API_KEY)

const BASE = () => (process.env.SHOP_API_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const KEY = () => process.env.SHOP_API_KEY || "";

const request = async (method, path, { params, timeout } = {}) => {
    if (!KEY()) {
        const e = new Error("Shop integration not configured (SHOP_API_KEY missing on the panel)");
        e.status = 503;
        throw e;
    }
    try {
        const res = await axios({
            method,
            url: `${BASE()}${path}`,
            params,
            timeout: timeout ?? 15_000,
            headers: { "x-api-key": KEY() },
        });
        return res.data;
    } catch (err) {
        if (err.response?.data?.error) {
            const e = new Error(err.response.data.error);
            e.status = err.response.status;
            throw e;
        }
        // Connection refused / timeout → shop bot is down or unreachable
        const e = new Error(`ArnTo-Shop is unreachable (${err.code || err.message})`);
        e.status = 503;
        throw e;
    }
};

const listOrders = (filters = {}) => request("get", "/api/orders", { params: filters });
const getStats = () => request("get", "/api/orders/stats");
const completeOrder = (orderId) => request("post", `/api/orders/${encodeURIComponent(orderId)}/done`, { timeout: 30_000 });
const cancelOrder = (orderId) => request("post", `/api/orders/${encodeURIComponent(orderId)}/cancel`, { timeout: 30_000 });

module.exports = { listOrders, getStats, completeOrder, cancelOrder };
