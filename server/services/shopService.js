const axios = require("axios");
const integrations = require("./integrationService");

// HTTP client for the ArnTo-Shop Orders API. Where the shop is reached is the
// "shop" integration (see integrationService): linked to the shop's project it
// follows that project across nodes, otherwise SHOP_API_URL as before
// (default http://127.0.0.1:3000).
//   SHOP_API_KEY  (must match the shop's SHOP_API_KEY)

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
            url: `${await integrations.baseUrl("shop")}${path}`,
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
