# bot-panel — chuẩn làm việc cho mọi session

Claude Code tự nạp file này đầu mỗi session. **Mục 0 là luật bắt buộc**: không có ngoại lệ trừ khi
người dùng nói rõ trong chat.

> Repo `KhaiClone/panel` là **PUBLIC**. Không bao giờ ghi vào file này (hay bất kỳ file nào được commit):
> IP, node id, API key/token, mật khẩu, nội dung `.env`, tình trạng firewall/cổng mở. Những thứ đó nằm
> trong file hạ tầng riêng dưới đây — nó chỉ có trên máy của chủ dự án, không nằm trong git.

@~/.claude/bot-panel-infra.md

---

## 0. Luật bắt buộc

### Làm việc với người dùng
1. Trả lời bằng **tiếng Việt**. Identifier, lệnh, đường dẫn giữ nguyên.
2. **Không bàn lại quyết định người dùng đã chốt** (mục 6). Thấy rủi ro thì nói + hỏi, không tự đổi.
3. Làm đúng phạm vi được giao. Việc phát hiện thêm → báo (hoặc đề xuất task riêng), không tự sửa.
   Khi người dùng nói "chỉ điều tra / không sửa khi chưa có lệnh" thì tuyệt đối không sửa.
4. Ý tưởng **voice hosting trả theo giờ (panel ↔ ArnTo-Auto)**: cấm động vào khi chưa có yêu cầu rõ.
5. Báo cáo cuối luôn nói: đã kiểm bằng gì, **chưa** kiểm được gì, commit nào, **đã deploy hay chưa**,
   thứ tự deploy. Không nói "đã xong" cho thứ chưa chạy thật.

### Git
6. **Chỉ commit / push khi người dùng bảo.** Push thẳng nhánh chính (mọi VPS đứng trên nhánh đó; nút
   Rebuild chạy `git pull`). Nhánh chính: panel `main`, ArnTo-Auto `master`, ArnTo-Shop `main`,
   ArnTo-assistant `main`, ArnTo-SelfBot `master`, decor-site `master`.
7. `git add <đường dẫn cụ thể>` — **không** `git add -A` / `git add .`: session khác có thể đang sửa cùng
   checkout. Không commit file của session khác.
8. Trước khi làm trên một repo bot: `git fetch && git status -sb`. Checkout local có thể chậm hơn origin
   (người dùng commit từ máy khác) — làm trên bản cũ thì phải port lại lúc push.
9. Commit message: `Khu vực: câu tiếng Anh nói kết quả` (vd `Auto Badge: add accounts by hand, free,
   from the panel`), thân commit giải thích *vì sao*. Kèm dòng attribution theo hướng dẫn hệ thống.
10. Test/fixture không chứa chuỗi trông như token thật — GitHub push protection chặn (GH013). Ghép token
    giả lúc chạy. Đã lỡ commit thì amend trước khi push (commit sửa chồng lên không cứu được).
11. `panel-launcher`: người dùng tự commit/deploy/quản domain — không git init/push, không đụng DNS.
    `decor-site` phải giữ **public** (Vercel Hobby chặn repo private).

### Deploy & máy chủ
12. **Không tự deploy.** Panel deploy = người dùng bấm **Rebuild & Restart** trên panel. Deploy qua SSH
    chỉ khi người dùng nói rõ. Máy đang chạy panel không có SSH từ đây.
13. SSH vào VPS mặc định **chỉ đọc**. Không đổi UFW/firewall, DNS, cert, nginx, apt/sudo, pm2 của bot
    khi chưa được đồng ý. Không bao giờ đăng nhập VPS bằng mật khẩu.
14. Thứ tự deploy: **agent trước panel** khi agent đổi. Bot gọi route panel mới → **panel trước bot**.
    Bot phải announce cap bus mới → bot trước khi tính năng panel dùng được. Ghi thứ tự trong báo cáo.
15. **Không chạy server panel thật ở local** (`npm start`, `npm run dev:server`): `.env` local cũ còn
    webhook thật và thiếu `PANEL_NODE_ID`. Kiểm UI bằng mock server cô lập trong scratchpad (route/service
    thật + Discord giả, cổng 127.0.0.1:3999) hoặc bằng test.
16. Không xoá dữ liệu live (DB rows, dòng `.env`, message Discord, cert) khi chưa hỏi — liệt kê phần còn
    sót để người dùng quyết. Không gỡ / thêm probe vào overlay WireGuard.
17. Trước khi nói "VPS X sẵn sàng / bot Y chạy ở đâu": kiểm lại (`pm2 jlist`, SSH chỉ đọc). Vị trí bot
    đã đổi nhiều lần.

### Kiến trúc — luật cứng
18. **Panel không bao giờ gọi bot qua mạng.** Bot → panel: HTTP qua gateway agent
    `http://127.0.0.1:4201` với API key riêng của project. Panel → bot: **Discord bus** (lệnh ký HMAC
    trong kênh #api). Bot không có HTTP API cho panel (server HTTP của bot chỉ là trang ping "/").
19. Không `.env` nào hard-code nơi phía bên kia chạy (`localhost`, IP WireGuard). Panel và bot di chuyển
    độc lập, không cái gì tự di chuyển.
20. **Không xử lý riêng** cho arnto-auto / shop / assistant — mọi sửa phải chung cho mọi project.
21. Panel là **control plane**: không chạy pm2/git/nginx/shell của riêng nó. Mọi thao tác project đi qua
    agent của node đó bằng `server/services/executor.js` (một code path, không `if (isRemote)`).
    `executor.target(bot)` là nơi DUY NHẤT quyết định địa chỉ hoá project.
22. Chỉ data **cả hai phía** dùng mới lên panel (`shared.sqlite`); data chỉ bot dùng ở lại bot.
    Shared name mới = Declare trên trang Panel + `PANEL_SHARED` của bot + restart bot.
23. Payload bus chứa bí mật (link gift, DM voucher…) phải `sealed: true`. JSON trong bus escape `<` `>` và
    non-ASCII (`busJson` trong `discordBus.js` + `bot-lib/PanelBus.js` — giữ hai bên giống nhau).
24. Không bao giờ hạ fencing **epoch**; không rollback `PANEL_NODE_ID`.
25. `node.host` là địa chỉ PUBLIC (dùng làm endpoint WireGuard + egress proxy) — không bao giờ loopback;
    panel→agent dùng `node.controlHost`.
26. Root-jail của agent (`agent/utils/paths.js`), `/self/*`, `PANEL_DIR`, `LAVALINK_DIR` không bao giờ
    nhận đường dẫn từ request. Agent không cài package (apt/Java) từ HTTP call.

### Code
27. **Trước khi commit** chạy `npm run lint` (bắt identifier dùng mà không khai báo — Vite/Node không bắt)
    + test liên quan (mục 4). Service mới/logic mới → thêm `scripts/<tên>.test.js`. Đụng data → thêm
    `node scripts/verify.js`.
28. Code giống code xung quanh: **ngôn ngữ comment theo file** (badge/quest/pricing viết tiếng Việt; phần
    lớn service mới hơn viết tiếng Anh), comment giải thích *vì sao* + lịch sử sự cố, đúng mật độ của file.
29. **Toàn bộ site panel luôn bằng tiếng Anh** (luật của người dùng, 2026-10-20). **Bất kỳ giá trị nào
    hiển thị lên giao diện panel đều phải tiếng Anh**: nhãn, nút, tiêu đề, placeholder, tooltip, hint,
    toast/Notice, hộp xác nhận, tên trạng thái, số đơn vị/ngày giờ định dạng, VÀ mọi chuỗi server trả về
    mà trang hiển thị — message lỗi của route `/api/<x>`, trường `error`/`reason`/`note` hệ thống ghi vào
    record, thông báo chuông, log, kết quả kiểm tra, nhãn sinh ra trong service.
    - Chuỗi vừa lên panel vừa tới khách (vd `error` của đơn badge cũng webhook về ArnTo-Auto): **không**
      đổi text khách đang nhận một cách lặng lẽ — panel lưu/hiển thị tiếng Anh (hoặc mã), bot tự diễn đạt
      tiếng Việt cho khách; nếu phải đổi phía bot thì nói rõ với người dùng.
    - Chỉ hiển thị nguyên văn (không dịch) nội dung do người/khách nhập hoặc lấy từ Discord: tên decor,
      tên sản phẩm/dịch vụ, ghi chú, nội dung message soạn trên trang Messages/Webhooks, tên kênh/role.
    - Text khách thấy trong bot = tiếng Việt. Lỗi của `/api/external/*` mà CHỈ bot đọc có thể tiếng Việt.
    - Lỗi đi cả hai phía mang hai câu: `err.message` tiếng Anh (lưu vào record, hiện trên panel) và
      `err.vi` câu tiếng Việt cho bot/khách — route external và payload bus gửi `err.vi ?? err.message`.
    - Record lưu TRƯỚC khi chuyển sang tiếng Anh vẫn giữ `error` tiếng Việt; dữ liệu không bị sửa. Router
      của trang (`/api/quests`, `/api/badges`) dịch khi trả ra bằng `router.use(englishJson)`
      (`server/services/legacyText.js`). Router mới hiện `error` từ record cũ → dùng nó; đổi câu lỗi
      tiếng Việt cũ nào → thêm vào bản đồ trong file đó. Không gắn vào router `/api/external/*`.
    - Số và tiền chỉ định dạng qua `client/src/utils/format.js`: `fmtNum` → `1,234,567`, `money` →
      `1,000,000 VND` (người dùng chọn 2026-10-20); không có giá trị → `—`. Không dùng `vi-VN` / `đ`.
    - Trang CTV hiển thị tên **Resellers**. Code mới hay sửa một trang: không để lọt chuỗi tiếng Việt nào
      ra UI — grep ký tự có dấu trong phần đã đụng trước khi commit.
30. Trang staff được cấp: key phải có ở **cả** `server/services/staffService.js` `PAGES` và
    `client/src/context/access.js` `STAFF_PAGES`, route mount bằng `pageAuth("<key>")`. Thao tác cho không
    / tốn tiền (đơn miễn phí…) = **owner only** (`req.auth.kind === "owner"`, client `useAuth().isOwner`).
31. Output Discord của panel → `panelLog.add(kind, text)`. `DISCORD_ALERT_WEBHOOK` chỉ dành cho cảnh báo
    hết hạn / nhắc gia hạn của khách (có thể khách thấy) — không bao giờ IP, lỗi, log ở đó.
32. Chuyển một lời gọi từ exec sang HTTP (hay ngược lại) **không đổi shape** API mà UI đang destructure.
33. Xoá import / destructure → grep cả nháy đơn lẫn nháy kép rồi chạy lint. Xoá chính xác chuỗi, không
    dùng regex nuốt cả khối.
34. Không đặt tên hàm module-level là `process` (che `process.env` — đã làm chết mọi đơn badge một lần).
35. Token khách luôn lưu mã hoá aes-256-gcm; `_shape()` bỏ token khỏi mọi response; không log token.
36. Ảnh trên Discord: không dùng KhaiDevApi — render trong bot (sharp) hoặc URL CDN Discord. QR VietQR:
    bot tự vẽ bằng gói `qrcode` từ chuỗi EMVCo, như pokezone-pay (ArnTo-Auto `functions/vietQr.js`);
    không dùng ảnh `img.vietqr.io` (giờ trả SVG, Discord không hiện).
37. **Không thêm lại** những thứ đã gỡ có chủ đích: hệ thống Robux; Embeds/message templates
    (`client.ui`); badge reader (đọc hộ) + phụ phí non-Nitro; đọc lại badge sau khi gửi; dòng "Backup sent"
    trong panel log; Integrations/HTTP API trong bot; Cloudflare.
38. Không xoay IP proxy giữa lúc một quest đang chạy (lease trong `proxyPool`); không sửa 429 bằng cách
    xoay trong vòng heartbeat.

---

## 1. Dự án là gì

**bot-panel** = web panel (Express + React/Vite) để:
- quản lý bot Discord và website của khách trên nhiều VPS (tạo từ git, start/stop, .env, file, log,
  domain + SSL, egress proxy, di chuyển giữa node, metrics, Lavalink, backup);
- chạy các hệ thống bán hàng của shop **ArnTo**: Orders, Stock (/kho, /giao), Vouchers, Ticket Menus,
  Supporters, Resellers (CTV), Messages + Webhooks (soạn kiểu Discohook), Decors, Pricing, Auto Quest,
  Auto Badge, Auto Deco Gift.

**Đăng nhập:** đúng **một** tài khoản owner = `ADMIN_USERNAME` + `ADMIN_PASSWORD_HASH` trong `.env`
(không có bảng users). Staff đăng nhập bằng Discord OAuth (redirect qua launcher), quyền none/view/edit
theo từng trang, một session mỗi người, phải giữ role Staff; audit mọi thao tác. Trang chỉ-owner mãi
mãi: Terminal, Systems/Nodes, Panel manage, Git keys, Proxy/Proxies, Bots, Lavalink, Domains/Sites.

## 2. Repo liên quan (máy local)

| Repo | Đường dẫn local | Vai trò |
|---|---|---|
| panel (repo này) | `E:\Code\NodeJs\Discord\My_Projects\bot-panel` | panel + `agent/` + `bot-lib/` |
| ArnTo-Auto | `E:\Code\NodeJs\Discord\ArnTo\ArnTo-Auto` | bán tự động: AutoBank QR, Auto Quest, Auto Badge, Deco Gift; nhận `quest.event`, `badge.event`, `dm.send` |
| ArnTo-Shop | `…\ArnTo\ArnTo-Shop` | ticket, đơn `arnto_N`, /new /done, /menu, /supporter-*, /ctv-*, /server |
| ArnTo-assistant | `…\ArnTo\ArnTo-assistant` | decor (/decor-load), /kho /giao, /voucher, gửi Messages, DM link gift |
| ArnTo-SelfBot | `…\ArnTo\ArnTo-SelfBot` | lệnh `$` (chỉ nhận từ bot ArnTo, Staff/Supporter, chính nó) |
| decor-site | `…\My_Projects\decor-site` | site tĩnh trên Vercel, đọc snapshot `data/*.json` |
| panel-launcher | `…\My_Projects\panel-launcher` | hàm Vercel 302 tới panel đang active (dựa vào `url` của `/api/health`) |

Shop/assistant: `node_modules` là bản build Linux → không load được trên Windows (chỉ syntax-check);
better-sqlite3 của assistant không load trên Node máy này → stub QuickDB trong harness.

## 3. Kiến trúc

**Node & agent.** Mỗi VPS chạy `agent/` (pm2 `panel-agent`, cổng 4200, version trong
`agent/package.json`). Máy chạy panel có thêm pm2 `bot-panel`. `PANEL_NODE_ID` trong `.env` panel = node
panel đang ở (bắt buộc). Project git ở `{root}/{buyerID}/{botID}`, pm2 name `{buyerID}-{botID}`.
`bot.source === "local"` nghĩa là "đăng ký từ thư mục có sẵn" (có `localPath` tuyệt đối), KHÔNG phải
"chạy ở node local". `bot.buyerID` = Discord id khách (bắt buộc khi tạo bot).

**Di chuyển panel.** Panel chạy được trên bất kỳ node nào; người dùng chọn tay (Move Panel). Lease +
**epoch fencing**; agent nào cũng nghe gateway `127.0.0.1:4201` và chuyển tiếp tới panel đang giữ lease.
Mỗi node có domain riêng, DNS không bao giờ đổi (DNS ở Vietnix, không Cloudflare); node không chạy panel
302 về node đang chạy. Launcher trên Vercel là địa chỉ cố định. Proxy xoay đã whitelist IP của panel sẽ
chết khi panel đổi máy — cảnh báo người dùng trước khi move.

**Dữ liệu.**
- `data/panel.sqlite` — quick.db (`server/db/QuickDB.js`): mỗi collection là MỘT mảng JSON trong một ô,
  mỗi lần ghi viết lại cả mảng. Migration phải dừng panel và ghi mảng trong một thao tác.
- `data/shared.sqlite` — data dùng chung panel ↔ bot, một row mỗi record; kv nội bộ đặt tên `__xxx`
  (vd `__staff.settings`, `__ticketMenu`, `__messages.map`).
- `data/samples.sqlite` — metrics: raw 15s giữ 3 ngày, rollup 5 phút giữ 30 ngày (không được backup).
- Backup mỗi giờ lên Discord (template-style, gồm cả `.env` — người dùng đã chấp nhận); rollback bằng
  link message. Restore không hạ epoch, giữ `PANEL_NODE_ID` hiện tại.

**Discord bus.** Bot của panel post lệnh JSON đã ký HMAC (key của project đích) vào kênh #api trong
server "Kho"; bot trả lời trong kênh. Bot announce caps; panel tìm handler bằng `discordBus.handlerOf` /
`canHandle`. Panel đọc lại kênh lúc start + mỗi 5 phút để bắt reply bị lỡ; lệnh quá 3 ngày = failed.

**API key & callback.** Mỗi project có key riêng (Panel Settings → API Keys). Route external:
`/api/external/*` sau `apiKeyMiddleware` (`req.apiCaller.botId`). Sự kiện về bot (quest/badge) đi qua
`callbackService` theo project chủ sở hữu.

**Proxy.** `/proxy` (Egress Proxy) = ghim IP public của **một bot** về một VPS bằng proxychains.
`/proxies` (Proxy Pool) = proxy mà **chính panel** đi ra (Auto Quest, Auto Badge). Đăng ký bất kỳ proxy
nào ở `/proxies` (priority `custom`) là thắng hẳn pool node → mọi account đổi IP.

**Lavalink.** Mỗi node có Lavalink do panel quản (`~/lavalink`, pm2 `lavalink`), một config chung, tự
update 02:00 Asia/Ho_Chi_Minh từng node một. `renderYaml()` phải **deterministic** (drift = so sha256);
`applyEdits()` splice theo byte range, bỏ qua field không đổi; node đang dừng không bao giờ bị update khởi
động lại.

## 4. Bản đồ code & kiểm tra

```
server/index.js            mount route, captureConsole → panelLog, start background services
server/routes/*.js         /api/<x> (pageAuth) và /api/external/<x> (apiKeyMiddleware)
server/services/*.js       logic; *Store.js = lưu trữ; executor.js = mọi thao tác qua agent
server/middleware/auth.js  authMiddleware (owner), pageAuth(page), isOwnerToken
client/src/pages/*.jsx     một trang mỗi file; client/src/components/ui = UI kit dùng chung
client/src/context/        AuthContext (useAuth, usePageAccess), access.js (STAFF_PAGES)
agent/                     agent chạy trên mọi VPS (routes/ + services/ + utils/paths.js)
bot-lib/                   PanelBus.js, QuickDB.js — copy vào extensions/ của bot, giữ giống hệt
scripts/*.test.js          test chạy bằng node, không framework; inventory.js + verify.js
```

**Mẫu code server:** lỗi = `_err(message, status, extra)` → route `if (err.status) return
res.status(err.status).json({ error: err.message })`, còn lại `next(err)`. Service export object hàm;
background job đi qua `lifecycle` (dừng khi panel đang move).

**Mẫu code client:** `api` (axios) từ `client/src/api/client`; UI kit `PageHeader`, `Notice`, `Modal`,
`Field`, `StatusBadge`, `EmptyState`, `Icon`, `Toggle`, `SearchInput`, `DataTable`, `StatCard`; class
`page fade-in`, `card`, `input`, `chip`/`chip active`, `btn-primary|btn-ghost|btn-danger` + `btn-sm`;
màu chỉ dùng token CSS (`--text-muted`, `--warning-bg`, `--info`…). Quyền: `usePageAccess(key).canEdit`.

**Mẫu test:** stub module qua `require.cache` (`stub("services/x", {...})`), db in-memory cùng ngữ nghĩa
QuickDB, router express trên cổng 0, in `✓/✗`, exit code ≠ 0 khi fail. Xem
`scripts/questMonthly.test.js`, `scripts/badgeManual.test.js`.

**Lệnh kiểm tra:**
```
npm run lint                          # bắt buộc trước mọi commit
node scripts/<feature>.test.js        # test của phần vừa sửa
node scripts/sampleStore.test.js      # metrics / rollup
node agent/utils/paths.test.js        # root-jail của agent
node scripts/lavalinkConfig.test.js   # renderYaml deterministic
node scripts/verify.js                # mất data so với scripts/snapshots/baseline.json (gitignored, mỗi máy một bản)
cd client && npx vite build --outDir <thư mục tạm ngoài repo>   # kiểm client build được
```
Re-take baseline (`node scripts/inventory.js --save=baseline`) chỉ sau khi mọi dòng LOST đã được giải
thích — re-take là "hợp thức hoá" trạng thái hiện tại.

## 5. Bẫy đã gặp (mỗi cái đã tốn thời gian hoặc data thật)

- **pm2 env rò rỉ:** pm2 export cả `pm2_env` của tiến trình vào environment và CLI đọc lại — biến env
  THẮNG flag. `max_memory_restart` của agent từng đè giới hạn của mọi bot (Lavalink chết mỗi 30s).
  `runPM2()` unset `PORT`, `max_memory_restart`; thêm key rò rỉ mới vào `PM2_ENV_LEAKS`.
- **Daemon pm2 cũ làm chết HTTP outbound** sau reboot, `pm2 restart` không chữa: `pm2 delete` → start lại
  với `--interpreter` tuyệt đối → `pm2 save`.
- **Watermark ban đầu của job incremental phải lấy từ data**, không từ hằng số retention (đã mất 4 ngày
  metrics). SQLite `GROUP BY` theo alias trùng tên cột nguồn → đặt tên alias khác (`bucket`).
- **Context đổi giá trị đầu từ mặc định dùng được sang `null`** → kiểm mọi consumer ở render đầu.
- **Discord viết lại custom emoji** mà bot post không dùng được → chữ ký bus hỏng. Đã fix bằng escape.
- **ArnTo-assistant `allowedMentions.parse` không có "roles"** → `<@&role>` im lặng trừ khi send tự truyền
  `allowedMentions.roles`. Shop thì parse roles. Role ID cứng phải kiểm còn tồn tại trước khi tin.
- Shop/Assistant rời mọi guild trừ guild chính khi ready/guildCreate — guild bus chỉ được giữ nhờ
  `PANEL_BUS_GUILD_ID`. discord.js 14.22+: dùng `Events.ClientReady`.
- **Tab trình duyệt mở trên domain panel cũ chỉ còn redirect** trông như đã logout và không sửa được gì
  (browser bỏ `Authorization` khi redirect cross-origin) → mở địa chỉ hiện tại, đăng nhập lại.
- Health-check proxy không dựa vào một echo service (ipify từng chậm 16s qua proxy vẫn tốt).
- Thêm node vào mesh WireGuard cũng thêm vào pool egress quest mặc định → xáo IP từng account
  (`questProxy: false` nếu cần giữ).
- Proxy xoay của nhà cung cấp VN có thể tự xoay theo timer của họ — panel không chặn được.
- Lệnh tiếng Việt / Unicode trong bus vẫn ổn; nghi ngờ lỗi chữ ký thì đọc kênh + verify lại, đừng đoán.
- Heredoc qua Bash tool làm hỏng `\r\n`, `\x1b` trong chuỗi → dùng Edit/Write hoặc file script. `/tmp`
  của Git Bash khác Python Windows → dùng thư mục scratchpad.

## 6. Quyết định người dùng đã chốt (không bàn lại)

- **Ngôn ngữ panel:** toàn bộ site panel và mọi giá trị hiển thị trên đó bằng tiếng Anh (luật 29);
  tiền hiển thị kiểu `1,000,000 VND`.
- **Kiến trúc:** panel & bot di chuyển độc lập; bus Discord thay HTTP; không Cloudflare; mỗi node một
  domain; chọn node đích bằng tay (không auto-election); không special-case bot ArnTo.
- **Tài khoản:** một owner trong `.env`; staff = Discord OAuth, owner thêm từng người, role Staff bắt buộc
  nhưng chưa đủ; panel không bao giờ cho/lấy role Staff.
- **Backup:** `.env` đi kèm mỗi backup dạng plain text (đã chấp nhận rủi ro); rollback bằng link message.
- **Panel log:** mọi thứ vào `DISCORD_PANEL_LOG_WEBHOOK` trừ cảnh báo hết hạn/gia hạn của khách.
- **Lavalink:** bỏ qua bản cài tay cũ; update 02:00 VN từng node; agent không cài Java.
- **Auto Badge:** game badge (Game Time/Variety) BÁN CHO MỌI acc, có Nitro hay không (2026-10-21; trước đó
  chỉ Nitro), đọc bằng token chính khách, không reader; acc chưa có thành tựu nào (Discord 404 cả hai
  đường) tính là 0; gửi xong là xong (không đọc lại); đã có mốc mà mua = mất tiền (forfeit); lỗi đọc → chờ
  duyệt tay, không tự tịch thu. Đơn **thêm tay** trên trang /badges: owner only, miễn phí, acc không đọc
  được thì owner nhập giá trị hiện tại; không bao giờ forfeit (chỉ Retry/Cancel).
- **Auto Quest:** pause là một công tắc toàn cục (đơn mới vẫn lưu, chưa chạy); "Run now" không tính là
  lượt chạy theo lịch; lỗi token monthly lưu ở key riêng `quest_monthly_outcome`.
- **Deco Gift:** Auto host việc bán, chỉ nói chuyện với panel; panel nhờ Shop tạo đơn `arnto_N`;
  assistant DM link gift (payload sealed); tối đa 5 decor/đơn; đơn tạo trên web panel luôn theo giá Gift.
- **Decor:** cờ bán `noLoginWithNitro` / `noLoginWithoutNitro` / `noGift` nằm trên record decor; deploy
  assistant TRƯỚC (`/decor-load` xoá cờ nếu bản cũ). **Giá gift bundle theo tổ hợp deco lẻ** (2026-10-21):
  khoá = giá Discord Nitro của từng deco × số lượng (`gift-bundle-set`, vd `66000x2`, `66000x1+99000x1`),
  mỗi tổ hợp một giá — KHÔNG theo tổng giá bán gift lẻ nữa (đổi giá lẻ từng làm bundle mất giá). Panel và
  `/decor-find` của assistant phải dựng khoá giống hệt nhau; deploy panel TRƯỚC assistant.
- **Vouchers:** phần thưởng admin trao tay sau khi claim; granted | public; claim trên cả Discord + panel.
- **Ticket menus:** quản cả dịch vụ + sản phẩm; owner = project import đầu tiên; `/menu` thay lệnh cũ.
- **Stock:** /kho trên ArnTo-assistant quản mọi thứ trừ TẠO loại sản phẩm (chỉ panel).
- **Supporters / CTV:** Supporter = role của bot (/supporter-*); Staff = owner trao tay. CTV trả theo
  từng đơn, admin thêm tay. Giá CTV cho đơn auto (2026-10-21): **giá riêng từng món** đặt cạnh giá
  thường — Quest lẻ + gói tháng, từng mốc Badge, từng bậc gift / tổ hợp bundle; áp cho CTV đang hoạt
  động trên trang Resellers ở cả 4 nơi (Quest, Badge, Deco Gift trên Discord, Deco Gift tạo trên web);
  để trống = giá thường. Đơn ticket vẫn theo kênh giá CTV của owner.
- **Xoá đơn shop** (2026-10-26): xoá được đơn ở **mọi trạng thái** (trừ Deco Gift — Auto quản), không báo
  khách; xoá = gỡ khỏi `orders`, `monthlyOrders` (thống kê tháng), lịch sử + `spent` của buyer, bảo hành
  /server, tin waiting-list — một hàm `deleteOrder` của Shop cho cả `/order-remove` lẫn panel (bus
  `order.delete`). Nút Delete trên trang Orders: **owner only**.
- **Messages:** staff chỉ post trong server shop, kênh họ có View + Send; server map tải 1 lần/ngày +
  nút Reload (1 lần/10 phút cho mọi người); Sent giữ 3 ngày.
- **Robux:** đã xoá hẳn khỏi ArnTo-Auto. **Message templates/Embeds:** đã gỡ khỏi panel và mọi bot.
- **WireGuard overlay:** để nguyên như hiện tại.

## 7. Kết thúc một task

1. Lint + test liên quan pass; nói rõ phần nào chỉ kiểm offline (harness/mock) và chưa chạy thật.
2. Chưa commit nếu người dùng chưa bảo; khi commit thì `git add` theo đường dẫn.
3. Báo: commit hash, repo nào, đã deploy chưa, thứ tự deploy, việc người dùng phải làm (env, Rebuild,
   chạy lại lệnh setup trên Discord…).
4. Ghi trạng thái (đã push/deploy hay chưa, quyết định mới của người dùng) vào memory của dự án; quyết
   định mới mang tính luật thì thêm vào mục 0 hoặc 6 của file này.
