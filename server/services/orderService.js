const sharedStore = require("./sharedStore");
const discordBus = require("./discordBus");
const shopService = require("./shopService");

// ─────────────────────────────────────────────────────────────────────────────
//  Shop orders for the panel's Orders page.
//
//  `orders` (and the nextOrderId counter) is shared data owned by ArnTo-Shop.
//  Once adopted, listing and stats read the panel's copy; Done / Cancel still
//  need the shop's Discord client (edit the order message, DM the buyer, post
//  in the ticket), so they go to the shop over the Discord bus. Before the
//  adoption everything still goes to the shop's HTTP API (shopService).
//  Shapes are the shop's api/ordersApi.js, unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const SELLERS = {
    "427399742906040333": "ArnTo",
    "871329074046435338": "KhaiDev",
};

const onPanel = () => sharedStore.nameRow("orders")?.state === "active";
const owner = () => sharedStore.nameRow("orders")?.owner || null;

const sum = (arr) => arr.reduce((s, o) => s + (o.price || 0), 0);
// The shop added the buyer's tag from its Discord cache; the panel has none.
const enrich = (order) => (order ? { ...order, sellerName: SELLERS[order.sellerId] || order.sellerId, buyerTag: order.buyerTag || null } : order);

const statsFor = (orders) => ({
    total: orders.length,
    pending: orders.filter((o) => o.status === "pending").length,
    completed: orders.filter((o) => o.status === "completed").length,
    cancelled: orders.filter((o) => o.status === "cancelled").length,
    buyers: new Set(orders.map((o) => o.buyerId)).size,
    revenue: sum(orders.filter((o) => o.status === "completed")),
});

const listOrders = async ({ status, sellerId } = {}) => {
    if (!onPanel()) return shopService.listOrders({ status, sellerId });
    let orders = sharedStore.run("orders", "get");
    if (status) orders = orders.filter((o) => o.status === status);
    if (sellerId) orders = orders.filter((o) => o.sellerId === sellerId);
    orders.sort((a, b) => (b.orderDate || 0) - (a.orderDate || 0));
    return { orders: orders.map(enrich) };
};

const getStats = async () => {
    if (!onPanel()) return shopService.getStats();
    const orders = sharedStore.run("orders", "get");
    const bySeller = {};
    for (const [id, name] of Object.entries(SELLERS)) bySeller[id] = { name, ...statsFor(orders.filter((o) => o.sellerId === id)) };
    return { ...statsFor(orders), bySeller };
};

const act = async (cmd, message, orderId) => {
    const order = await discordBus.request(owner(), cmd, { orderId: String(orderId) }, { timeoutMs: 45_000 });
    return { message, order: enrich(order) };
};

const completeOrder = async (orderId) => {
    if (!onPanel()) return shopService.completeOrder(orderId);
    return act("order.complete", "Order completed", orderId);
};

const cancelOrder = async (orderId) => {
    if (!onPanel()) return shopService.cancelOrder(orderId);
    return act("order.cancel", "Order cancelled", orderId);
};

module.exports = { onPanel, statsFor, listOrders, getStats, completeOrder, cancelOrder };
