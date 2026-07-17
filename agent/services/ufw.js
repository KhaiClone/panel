const { exec } = require("child_process");
const util = require("util");
const net = require("net");
const execAsync = util.promisify(exec);

// Port of the panel's ufwService for the agent VPS (runs as root — no sudo).

/** Open a TCP port in UFW. */
const openPort = async (port) => {
    await execAsync(`ufw allow ${port}/tcp`);
};

/** Remove a UFW rule for a TCP port. Errors are silenced (rule may not exist). */
const closePort = async (port) => {
    try {
        await execAsync(`ufw delete allow ${port}/tcp`);
    } catch { /* rule may not exist */ }
};

/** Returns true if no process is listening on the given port. */
const isPortFree = (port) =>
    new Promise((resolve) => {
        const server = net.createServer();
        server.once("error", () => resolve(false));
        server.once("listening", () => { server.close(); resolve(true); });
        server.listen(port, "0.0.0.0");
    });

/**
 * Find an available port in [start, end].
 * Throws if no free port is found.
 */
const findFreePort = async (start = 3000, end = 9000) => {
    for (let port = start; port <= end; port++) {
        if (await isPortFree(port)) return port;
    }
    throw new Error(`No free port available in range ${start}–${end}`);
};

/** Raw `ufw status numbered` output. */
const status = async () => {
    const { stdout } = await execAsync("ufw status numbered");
    return stdout;
};

module.exports = { openPort, closePort, isPortFree, findFreePort, status };
