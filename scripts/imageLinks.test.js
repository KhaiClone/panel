#!/usr/bin/env node
/**
 * Checks for pictures attached by link (server/services/imageLinks.js — the
 * Messages and Webhooks pages): only public addresses are fetched (literal
 * IPs, names resolving to private ones, redirects into them), only pictures
 * Discord draws are taken (read from the bytes; an HTML page or an SVG is
 * refused with a reason), the size budget holds across a message's pictures,
 * names follow attachment://'s rule, and an edit keeps the links of the files
 * still on the message. A local HTTP server stands in for the internet.
 * Run:  node scripts/imageLinks.test.js
 */

const http = require("http");
const assert = require("assert");
const links = require("../server/services/imageLinks");

let failures = 0;
const test = async (name, fn) => {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${name}\n    ${err.stack}`);
    }
};
const rejects = async (fn, re, status = 400) => {
    try {
        await fn();
    } catch (err) {
        assert.strictEqual(err.status, status, `expected ${status}, got ${err.status}: ${err.message}`);
        if (re) assert.match(err.message, re);
        return err;
    }
    throw new Error("expected an error");
};

// Picture bytes: just enough of each format's header for the sniffing.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(50)]);

let hits = 0;
let allow = true; // what the test `check` answers — the routes below flip it
const server = http.createServer((req, res) => {
    hits++;
    const send = (status, type, body, headers = {}) => {
        res.writeHead(status, { "content-type": type, ...headers });
        res.end(body);
    };
    if (req.url === "/a.png") return send(200, "image/png", PNG);
    if (req.url === "/octet") return send(200, "application/octet-stream", JPEG); // a CDN that does not say
    if (req.url === "/lying.png") return send(200, "image/png", Buffer.from("<html>nope</html>"));
    if (req.url === "/page") return send(200, "text/html; charset=utf-8", "<html><img src=/a.png></html>");
    if (req.url === "/qr.svg") return send(200, "image/svg+xml", "<svg/>");
    if (req.url === "/big") return send(200, "image/png", Buffer.concat([PNG, Buffer.alloc(5000)]));
    if (req.url === "/chunked-big") {
        res.writeHead(200, { "content-type": "image/png" }); // no content-length: counted while it comes
        res.write(PNG);
        res.end(Buffer.alloc(5000));
        return undefined;
    }
    if (req.url === "/hop") return send(302, "text/plain", "", { location: "/webp" });
    if (req.url === "/webp") return send(200, "image/webp", WEBP);
    if (req.url === "/loop") return send(302, "text/plain", "", { location: "/loop" });
    if (req.url === "/inside") {
        allow = false; // from here on, the address counts as private
        return send(302, "text/plain", "", { location: `http://127.0.0.1:${server.address().port}/a.png` });
    }
    return send(404, "text/plain", "missing");
});

(async () => {
    console.log("imageLinks");
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const open = { check: () => allow };

    await test("public addresses only: private, loopback, link-local, CGNAT and reserved are refused", async () => {
        for (const ip of ["8.8.8.8", "1.1.1.1", "103.97.125.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) assert.ok(links.isPublicAddress(ip), `${ip} is public`);
        for (const ip of [
            "127.0.0.1",
            "127.8.9.10",
            "10.0.0.5",
            "172.16.4.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.254",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.1",
            "::1",
            "::",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:7f00:1",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "64:ff9b::a00:1",
            "2002:c0a8:101::1",
            "[::1]",
            "not-an-ip",
        ]) {
            assert.ok(!links.isPublicAddress(ip), `${ip} is not public`);
        }
        assert.ok(links.isPublicAddress("::ffff:8.8.8.8"), "a mapped public IPv4 is public");
    });

    await test("the page's list: links checked, names safe for attachment://, at most 10", async () => {
        assert.deepStrictEqual(links.imagesOf(undefined), []);
        assert.deepStrictEqual(
            links.imagesOf([
                { url: "https://cdn.discordapp.com/attachments/1/2/Bảng giá.PNG?ex=abc", name: "" },
                { url: "  " },
                "https://i.imgur.com/x",
                { url: "https://a.b/c.jpg", name: "Ảnh đẹp" },
            ]),
            [
                { url: "https://cdn.discordapp.com/attachments/1/2/Bảng giá.PNG?ex=abc", name: "Bang_gia.PNG" },
                { url: "https://i.imgur.com/x", name: "x.png" },
                { url: "https://a.b/c.jpg", name: "Anh_dep.png" },
            ],
        );
        await rejects(() => links.imagesOf("https://a.b/c.png"), /must be a list/);
        await rejects(() => links.imagesOf([{ url: "not a link" }]), /Image 1 is not a link/);
        await rejects(() => links.imagesOf([{ url: "ftp://a.b/c.png" }]), /must start with https/);
        await rejects(() => links.imagesOf([{ url: "file:///etc/passwd" }]), /must start with https/);
        await rejects(() => links.imagesOf(Array.from({ length: 11 }, (_, i) => `https://a.b/${i}.png`)), /11 images — Discord allows 10/);
        assert.strictEqual(links.fileName("Ảnh sản phẩm (1).PNG", 0), "Anh_san_pham_1_.PNG");
    });

    await test("a picture is taken by its bytes, whatever the header says", async () => {
        const a = await links.download(`${base}/a.png`, open);
        assert.deepStrictEqual([a.type, a.ext, a.buffer.length], ["image/png", "png", PNG.length]);
        const o = await links.download(`${base}/octet`, open);
        assert.strictEqual(o.type, "image/jpeg");
        const w = await links.download(`${base}/hop`, open);
        assert.strictEqual(w.type, "image/webp", "a redirect is followed");
    });

    await test("what is not a picture is refused with the reason", async () => {
        await rejects(() => links.download(`${base}/page`, open), /web page, not a picture — use the picture's own link/);
        await rejects(() => links.download(`${base}/qr.svg`, open), /SVG — Discord shows that as a file/);
        await rejects(() => links.download(`${base}/lying.png`, open), /not a picture Discord can show/);
        await rejects(() => links.download(`${base}/gone.png`, open), /answered HTTP 404/);
        await rejects(() => links.download(`${base}/loop`, open), /redirects too many times/);
        await rejects(() => links.download(`${base}/big`, { ...open, maxBytes: 1000 }), /too big — at most \d/);
        await rejects(() => links.download(`${base}/chunked-big`, { ...open, maxBytes: 1000 }), /too big/);
        await rejects(() => links.download("http://no-such-host.invalid/a.png", open), /does not exist|cannot be reached/);
    });

    await test("the panel's own machine is out of reach: literal IPs, names and redirects", async () => {
        const before = hits;
        await rejects(() => links.download(`${base}/a.png`), /private address/);
        await rejects(() => links.download(`http://[::1]:${server.address().port}/a.png`), /private address/);
        await rejects(() => links.download("http://169.254.169.254/latest/meta-data/"), /private address/);
        assert.strictEqual(hits, before, "nothing was even asked");
        await rejects(() => links.download(`http://localhost:${server.address().port}/a.png`), /private address/);
        assert.strictEqual(hits, before, "a name that resolves to loopback is refused at connect time");
        allow = true;
        await rejects(() => links.download(`${base}/inside`, open), /private address/);
        allow = true;
    });

    await test("a message's pictures: one after another within the budget, a failure names the picture", async () => {
        const files = await links.downloadAll(
            [
                { url: `${base}/a.png`, name: "a.png" },
                { url: `${base}/octet`, name: "photo.png" },
            ],
            open,
        );
        assert.deepStrictEqual(
            files.map((f) => [f.name, f.type, f.size]),
            [
                ["a.png", "image/png", PNG.length],
                ["photo.png", "image/jpeg", JPEG.length],
            ],
        );
        // The first takes most of the budget: the second no longer fits.
        await rejects(
            () => links.downloadAll([{ url: `${base}/a.png`, name: "a.png" }, { url: `${base}/big`, name: "big.png" }], { ...open, maxBytes: PNG.length + 1000 }),
            /^Image 2 \(big\.png\): the picture is too big/,
        );
        await rejects(() => links.downloadAll([{ url: `${base}/page`, name: "p.png" }], open), /^Image 1 \(p\.png\): the link is a web page/);
    });

    await test("after an edit: the earlier links whose file is still there, then the new ones", async () => {
        const before = [
            { url: "https://a.b/1.png", name: "1.png" },
            { url: "https://a.b/2.png", name: "2.png" },
        ];
        const added = [{ url: "https://a.b/3.png", name: "3.png" }];
        assert.deepStrictEqual(links.stillOn(before, [{ filename: "2.png" }, { filename: "3.png" }, { filename: "upload.pdf" }], added), [before[1], added[0]]);
        assert.deepStrictEqual(links.stillOn(before, [], undefined), undefined, "every file removed");
        assert.deepStrictEqual(links.stillOn(before, undefined, added), added, "no list from Discord: only the new ones are known");
    });

    server.close();
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
