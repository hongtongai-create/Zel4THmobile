![Zel4THmobile](board/assets/brand/logo-icon.png)

# Zel4THmobile

> **คู่มือใช้งานทีละขั้น (ติดตั้ง → สร้าง agent → คุมเครื่องอื่น → สตูดิโอ → สร้างภาพ/วิดีโอ): [docs/USAGE.md](docs/USAGE.md)**

Agent harness สไตล์ Openclaw — เลือก model ได้, คุยผ่าน Telegram, สั่งให้โพสต์ Facebook ได้เอง
และมี **board** (หน้าเว็บควบคุม) ที่ต่อผ่าน **gateway token + WebSocket**

```
Telegram ─┐
          ├─► AgentHarness ─► ModelCatalog ─► provider:model (OpenAI / OpenRouter / Ollama / อื่น ๆ)
Board(WS)─┘        │
                   └─► Tools (facebook_post)
```

## โครงสร้าง

| ไฟล์ | หน้าที่ |
| --- | --- |
| `src/agent.ts` | agent loop: ประกอบ prompt → เรียก model → เรียก tool → วนจนได้คำตอบ, เก็บประวัติ |
| `src/models.ts` | model catalog (`provider:model`) + client ที่รองรับ OpenAI-compatible API |
| `src/tools/` | tool registry, tool `facebook_post` (Graph API) และ tool `extensions` (ติดตั้ง/ถอน/ค้นหา extension) |
| `src/extensions/` | ระบบส่วนขยาย: skills (markdown), plugins (JS), MCP servers (stdio) และ clawhub client |
| `src/channels/telegram.ts` | long-polling Telegram พร้อมคำสั่ง `/model`, `/models`, `/reset`, `/status` |
| `src/channels/line.ts` | LINE Messaging API webhook (ตรวจ signature, allowlist, กัน event ซ้ำ, reply/push) |
| `src/extensions/approvals.ts` | คิวอนุมัติสำหรับการติดตั้ง/ถอน/รีโหลด extension ที่ agent ขอ |
| `src/gateway/server.ts` | HTTP + WebSocket gateway (ตรวจ token ก่อน upgrade) และเสิร์ฟ board |
| `src/store.ts` | เก็บ session เป็นไฟล์ JSON ใน `data/sessions/` |
| `src/usage.ts` | บันทึก token ต่อ turn และประมาณค่าใช้จ่ายต่อ model/provider (`data/usage.jsonl` + `zel4thmobile usage`) |
| `board/` | board UI แบบ mobile-first (vanilla JS) ต่อ WebSocket, เลือก model, ดู tool call แบบสด |
| `board/manifest.webmanifest`, `board/sw.js`, `board/icons/` | ทำให้ board ติดตั้งเป็นแอพได้ (PWA) |
| `scripts/make-icons.mjs` | สร้างไอคอน PNG ทั้งชุดโดยไม่ต้องพึ่ง library ภายนอก (`npm run icons`) |
| `src/cli.ts` | คำสั่ง `gateway`, `chat`, `models`, `usage`, `extensions` |

## เริ่มใช้งาน

```bash
npm install
cp .env.example .env
# แก้ GATEWAY_TOKEN และใส่ key ของ model อย่างน้อยหนึ่งตัว # openssl rand -hex 32
npm run dev           # = tsx src/cli.ts gateway
```

จะได้ log แบบนี้ — เปิดลิงก์ board ได้เลย (token ถูกฝังใน URL แล้ว):

```
zel4thmobile gateway listening on http://0.0.0.0:8787
board:  http://localhost:8787/?token=...
socket: ws://localhost:8787/ws
```

คำสั่งอื่น: `npm run chat` (คุยใน terminal), `npm run models` (ดู model ที่ตั้งไว้),
`npm run usage` (สรุป token/ค่าใช้จ่าย), `npm run build && npm start` (prod build),
`npm run smoke` (ทดสอบ gateway + agent loop ด้วย stub server)

### อัปเดตโค้ดบนเครื่องที่รันอยู่ (Termux / มือถือ / Mac)

```bash
cd ~/Zel4THmobile
# กด Ctrl+C ให้ gateway ตัวเก่าหยุดก่อน

git pull
npm install
npm run build && npm start
```

เปิดบอร์ดด้วย URL token เดิมอีกครั้ง (ไม่ต้องแตะ `.env` และข้อมูลใน `data/` ไม่ถูกทับ)

#### ถ้า `npm install` เตือน `install-scripts … not covered by allowScripts`

npm 12 (ตั้งแต่ ก.ค. 2026) บล็อก lifecycle script ของ dependency โดยค่าเริ่มต้น — **ไม่ใช่ error**
และไม่กระทบ `npm start` (รันไฟล์ที่ compile แล้ว) ตัวที่ถูกบล็อกคือ `esbuild` ซึ่งใช้เฉพาะ `npm run dev`
รีโปนี้ประกาศ `"allowScripts": { "esbuild": true }` ไว้แล้ว แต่ถ้าเครื่องยังใช้โค้ดเวอร์ชันเก่า หรือ
npm ยังไม่เห็นค่านี้ ให้อนุมัติเอง:

```bash
# npm 12
npm install-scripts approve esbuild
npm rebuild esbuild
npm install-scripts ls        # ควรขึ้นว่าว่าง ไม่มีอะไรค้าง

# npm 11.16–11.x (คำสั่งชื่อเก่า)
npm approve-scripts esbuild
npm rebuild esbuild
```

อนุมัติแล้วไม่ย้อนหลังอัตโนมัติ — ต้อง `npm rebuild esbuild` ตามหนึ่งครั้ง ไม่งั้น `npm run dev` จะไม่พบ binary

#### ถ้า `git pull` ไม่ได้ (local changes / EADDRINUSE)

`npm install-scripts approve` เขียน `package.json` + `package-lock.json` ในเครื่อง ทำให้ pull ฟ้อง `would be overwritten`:

```bash
git checkout -- package.json package-lock.json
git pull
npm install
npm run build && npm start
```

ถ้าเจอ `fatal: listen EADDRINUSE 0.0.0.0:8787` = มี gateway ตัวเก่ารันค้าง (เซสชัน/tmux เก่า) ปิดก่อน:

```bash
pkill -f "dist/cli.js gateway"    # Termux/Linux; macOS: lsof -ti :8787 | xargs kill
```

<!-- หมายเหตุ: ส่วนนี้ต้องเหมือนกับ docs/USAGE.md §2.1 -->

## ตั้งค่า model

model ใช้รูปแบบ `provider:model` และทุก provider ใช้ API แบบ OpenAI-compatible
ตั้งได้หลายเจ้าพร้อมกัน แล้วสลับได้ทั้งจาก board และ Telegram

```bash
OPENAI_API_KEY=sk-...                       # → openai:gpt-4.1-mini, openai:gpt-4o, ...
OPENROUTER_API_KEY=sk-or-...                # → openrouter:anthropic/claude-sonnet-4, ...
OLLAMA_ENABLED=1                            # → ollama:llama3.1 (ไม่ต้องใช้ key)
LLM_BASE_URL=https://api.groq.com/openai/v1 # provider อื่น ๆ → custom:llama-3.3-70b-versatile
LLM_API_KEY=...
LLM_MODELS=llama-3.3-70b-versatile
DEFAULT_MODEL=openai:gpt-4o-mini            # model เริ่มต้นของ session ใหม่
```

สลับ model ต่อ session: `/model openrouter:google/gemini-2.5-flash` (Telegram) หรือ dropdown บน board

## Token usage และค่าใช้จ่าย

ทุก turn ที่จบจะถูกบันทึกหนึ่งบรรทัดใน `data/usage.jsonl` (append-only, ไม่ถูก commit) และขึ้น log:

```
turn usage custom:nvidia/nemotron-3-ultra-550b-a55b provider=Nvidia prompt=1204 completion=318 total=1522
  cost=$0.000431 provider_spent=$0.018732 provider_turns=14 all_spent=$0.021003
```

- `prompt`/`completion`/`total` คือผลรวมของ **ทุก model call ในเทิร์นนั้น** (turn ที่เรียก tool หลายรอบจะรวมให้)
- `provider_spent` / `provider_turns` คือยอดสะสมของ provider นั้น (ไม่ใช่แค่เทิร์นนี้) และ `all_spent` คือยอดรวมทุกเจ้า
- ถ้า provider ไม่ส่ง `usage` กลับมา บรรทัด log จะขึ้น `(tokens unknown)` และไม่คิดเงิน

ตั้งราคาเป็น **USD ต่อ 1M tokens** รูปแบบ `input/output` คั่นด้วย `;` (ถ้าใส่ตัวเดียวใช้ราคาเดียวกันทั้งขาเข้า/ขาออก):

```bash
# model เจาะจง / ค่าเริ่มต้นของทั้ง provider / ค่าเริ่มต้นทุก provider
MODEL_PRICES=custom:nvidia/nemotron-3-ultra-550b-a55b=0.20/0.60;custom:*=0.10/0.30;*=1/3
```

ลำดับการค้นราคา: `provider:model` → `provider:*` → `*` → ถ้าไม่เจอ = `n/a` (ไม่เดาให้)

ดูยอดสะสม (ต่อ model และต่อ provider) ได้ทุกเมื่อ — อ่านจากไฟล์ log จึงรอดจากการรีสตาร์ท:

```bash
node dist/cli.js usage    # หรือ npm run usage
```

```
model                                    turns            in           out      est. cost
custom:nvidia/nemotron-3-ultra-550b-a55b    14         16,856         4,452       $0.018732
custom:z-ai/glm-5.3-flash                    3          2,104           598       $0.000271

provider   models turns            in           out      est. cost
Nvidia          3    17         18,960         5,050       $0.019003

total: 24,010 tokens over 17 turn(s), est. $0.019003
```

ราคาที่เคยบันทึกไว้จะไม่ถูกคำนวณใหม่เมื่อแก้ `MODEL_PRICES` — ยอดเก่ายังเป็นราคาตอนที่เรียกจริง
ถ้าต้องการเริ่มนับใหม่ ให้ลบ `data/usage.jsonl` (หรือย้ายเก็บไว้)

## Telegram

1. คุยกับ [@BotFather](https://t.me/BotFather) → `/newbot` → คัดลอก token
2. หา chat id ของคุณ: ส่งข้อความหาบอทแล้วเปิด
   `https://api.telegram.org/bot<TOKEN>/getUpdates` แล้วอ่าน `message.chat.id`
3. ใส่ใน `.env`:

```bash
TELEGRAM_BOT_TOKEN=123456:AA...
TELEGRAM_ALLOWED_CHAT_IDS=123456789     # ว่าง = ไม่มีใครคุยได้ (ปลอดภัยไว้ก่อน)
```

ว่างไว้แล้วจะถูกปฏิเสธทุก chat — ต้องใส่ chat id เสมอ บอทจะส่ง `typing` ระหว่างที่ agent ทำงาน
และตอบกลับเป็น plain text (ตัดให้พอดี 4000 ตัวอักษรต่อข้อความ)

คำสั่งที่มีให้: `/approvals` (ดูคำขออนุมัติ extension ที่รออยู่), `/approve <id>`, `/reject <id>`,
`/model`, `/models`, `/reset`, `/status` — คำขออนุมัติใหม่จะถูกส่งเข้ามาที่ chat นี้เองโดยไม่ต้องเปิดบอร์ด

## LINE

เชื่อม LINE Official Account (Messaging API) ให้คุยกับ agent/ออฟฟิศตัวเดียวกับ Telegram —
ใช้ model, tools, session และ agent profile ชุดเดียวกัน ไม่มี runtime แยก

1. สร้าง channel ที่ https://developers.line.biz → เลือก **Messaging API** → ออก
   *Channel secret* และ *Channel access token (long-lived)*
2. ใส่ใน `.env`:

```bash
LINE_CHANNEL_SECRET=...
LINE_CHANNEL_ACCESS_TOKEN=...
LINE_ALLOWED_SOURCE_IDS=Uxxxxxxxxxxxxxxxx   # ว่าง = ไม่มีใครคุยได้
LINE_AGENT_ID=main                          # agent ที่ตอบ (ไม่ใส่ = main)
# LINE_WEBHOOK_PATH=/webhooks/line
```

3. เปิด webhook URL เป็น **https** ที่ชี้มาที่ gateway เช่น
   `https://your-tunnel.example/webhooks/line` (Cloudflare Tunnel / reverse proxy ที่มี TLS)
   แล้วกด **Verify** ในคอนโซล LINE

สิ่งที่โค้ดทำ:

- ตรวจ `x-line-signature` = HMAC-SHA256 ของ **raw body** ด้วย channel secret ก่อน parse
  (ผิด = `403`, ไม่แตะโมเดล)
- ตอบ `200` ทันที แล้วค่อยรัน turn ใน background เพื่อไม่ให้ LINE retry เพราะ webhook ช้า
- กัน event ซ้ำด้วย `webhookEventId` (จำ 500 รายการล่าสุด)
- ผู้ส่งที่ไม่อยู่ใน `LINE_ALLOWED_SOURCE_IDS` ถูกเมินและ log ไว้ (default deny)
- session แยกเป็น `line:<userId|groupId|roomId>` ไม่ปนกับ Telegram/บอร์ด
- ส่งคำตอบด้วย reply token ก่อน ถ้า token หมดอายุจะ fallback ไป push API
- คำขออนุมัติ extension ถูก push เข้า source ที่อนุญาต และตอบกลับได้ในแชทด้วย
  `approvals`, `approve <id>`, `reject <id>` (ไม่กิน model turn)

สถานะจริงดูได้ที่ `GET /api/status` → `line: { configured, webhookVerified, events, replied, duplicates, rejected, lastEventAt }`
ค่า ENV ที่มีอยู่ไม่ถือว่า “ผ่าน” — `webhookVerified` จะเป็น true หลังมี request ที่ signature ถูกต้องจริงเท่านั้น

## Facebook

agent โพสต์เองได้ผ่าน tool `facebook_post` (Page feed)

1. สร้างแอปที่ https://developers.facebook.com → เพิ่มผลิตภัณฑ์ **Facebook Login for Business**
2. ขอ **Page access token** ของเพจที่ต้องการ (สิทธิ์ `pages_manage_posts`, `pages_read_engagement`)
   — ใช้คู่กับ App ID/Secret ใน Graph API Explorer หรือทำ token ระยะยาวผ่าน `oauth/access_token`
3. ใส่ใน `.env`:

```bash
FACEBOOK_PAGE_ID=1234567890
FACEBOOK_PAGE_ACCESS_TOKEN=EAAB...
FACEBOOK_PAGE_NAME=My Page          # ใช้แสดงใน prompt ให้ agent รู้ว่ากำลังโพสต์ที่ไหน
```

ถ้าไม่ได้ตั้งค่า tool นี้จะไม่ถูก register เลย — agent จึงไม่สามารถอ้างว่าโพสต์ได้ และจะบอกว่าไม่มีความสามารถนี้
token อยู่ฝั่ง server เท่านั้น ไม่เคยถูกส่งเข้า model

ทดสอบ: ส่งใน Telegram ว่า `โพสต์เพจว่าวันนี้ร้านเปิด 10:00-20:00` แล้วดู tool call ใน board

## สร้างภาพ (image generation)

agent สร้างภาพเองได้ผ่าน tool `image_generate` — เรียก endpoint แบบ OpenAI-compatible
(`POST {IMAGE_BASE_URL}/images/generations`) แล้วบันทึกไฟล์ลงเครื่อง

```bash
IMAGE_API_KEY=sk-...                       # เว้นว่าง = ใช้ OPENAI_API_KEY
IMAGE_BASE_URL=https://api.openai.com/v1   # เว้นว่าง = ใช้ OPENAI_BASE_URL
IMAGE_MODEL=gpt-image-1                    # หรือ dall-e-3 / model ของผู้ให้บริการที่รองรับ
IMAGE_SIZE=1024x1024
IMAGE_DIR=data/images                      # ที่เก็บไฟล์ เริ่มต้นคือ <DATA_DIR>/images
```

- ไม่ตั้งคีย์ = tool ไม่ถูก register เลย agent จึงไม่สามารถอ้างว่าสร้างภาพได้
- คีย์อยู่ฝั่ง server เท่านั้น ไม่เคยถูกส่งเข้า model
- tool คืน **path ของไฟล์ที่บันทึกแล้ว** agent จึงส่งต่อให้คนอื่น (หรือใช้ tool อื่นต่อ) ได้จริง
- ตั้ง `IMAGE_MODEL` เป็น `dall-e-*` เมื่อ endpoint ต้องการ `response_format: b64_json`

ตัวอย่าง: "วาดภาพแมวส้มนอนบนMacBook แล้วเซฟไว้" → agent เรียก
`{"prompt":"...","size":"1536x1024"}` แล้วตอบกลับพร้อม path

## สร้างวิดีโอ (video generation)

agent สร้างวิดีโอสั้นเองได้ผ่าน tool `video_generate` — ใช้ API แบบ **async task**
(`POST <tasks>` → ได้ id → `GET <tasks>/<id>` จนสถานะ `succeeded` → ดาวน์โหลด `video_url`)

```bash
VIDEO_BASE_URL=https://ark.ap-southeast.bytepluses.com/api/v3
VIDEO_TASKS_URL=https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks
VIDEO_MODEL=seedance-1-0-pro-250528
VIDEO_RESOLUTION=720p                                # 480p / 720p / 1080p
VIDEO_RATIO=16:9
VIDEO_DURATION=5                                     # วินาที
VIDEO_DIR=data/videos
VIDEO_TIMEOUT_MS=600000                              # เพดานเวลารอ render
```

- ไม่ตั้งคีย์ = tool ไม่ถูก register (คีย์ fallback: `VIDEO_API_KEY` → `IMAGE_API_KEY` → `OPENAI_API_KEY`)
- `VIDEO_BASE_URL` ใช้ร่วมกับ image ได้ เพราะ Ark ให้บริการทั้งคู่ที่ `/api/v3`
- `VIDEO_TASKS_URL` ใส่ URL เต็มได้เลย และโค้ดจะไม่ต่อ path ซ้ำ
- tool จะ poll ทุก 5 วินาที, ดาวน์โหลดไฟล์ `.mp4` เก็บไว้แล้วคืน **absolute path**
- ลิงก์ `video_url` ของผู้ให้บริการหมดอายุใน 24 ชั่วโมง — tool จึงโหลดเก็บทันที

## ใช้บนมือถือ / ติดตั้งเป็นแอพ

board ถูกออกแบบมาให้ใช้บนมือถือเป็นหลัก: app bar บาง, เมนูเป็น drawer, เลือก model ด้วย bottom sheet,
ปุ่มสูงอย่างน้อย 44px, ระยะขอบกัน notch/home indicator (`env(safe-area-inset-*)`), composer เกาะขอบล่าง
ด้วย `100dvh` (ไม่โดนคีย์บอร์ดดันหลุดจอ), input 16px เพื่อไม่ให้ iOS zoom, และไม่มี scroll แนวนอน

ติดตั้งเป็นแอพ (PWA):

- **Android / Chrome**: เปิด board → เมนู ⋮ → *Add to Home screen* (หรือกดปุ่ม **Install as app** ใน drawer)
- **iOS / Safari**: เปิด board → ปุ่ม Share → *Add to Home Screen*

แอพจะเปิดแบบ standalone (ไม่มีแถบ address), มีไอคอนของตัวเอง, จำ `GATEWAY_TOKEN` ไว้ใน
`localStorage` จึงไม่ต้องกรอกใหม่ทุกครั้งที่เปิด (กด *Disconnect* ใน drawer เพื่อล้าง),
มี service worker แคช app shell ไว้ให้เปิดได้แม้เน็ตหลุดชั่วคราว (ตัวแชทต้องต่อ gateway อยู่),
และต่อ WebSocket ใหม่เองเมื่อกลับเข้าหน้าจอ (ping ทุก 30 วินาที)

> Service worker และการติดตั้งเป็นแอพต้องมาจาก **HTTPS** (หรือ `localhost`)
> ถ้าเปิดผ่าน IP ในวง LAN ด้วย http:// จะยังใช้ได้แต่ติดตั้งเป็นแอพไม่ได้ — วางหลัง reverse proxy ที่มี TLS

## Extensions: skills / plugins / MCP / clawhub

เพิ่มความสามารถให้ agent ได้โดยไม่ต้องแก้โค้ด ทุกอย่างอยู่ใน `EXTENSIONS_DIR` (ค่าเริ่มต้น `extensions/`)
และโหลดใหม่ได้ทันทีโดยไม่ต้องรีสตาร์ท gateway

### 1. Skills — คำแนะนำแบบ markdown เข้าไปใน system prompt

```
extensions/skills/<ชื่อ>/SKILL.md
```

```markdown
---
name: web-research
description: วิธีค้นข้อมูลบนเว็บแล้วสรุป
---

เมื่อต้องค้นข้อมูล: 1) ... 2) ...
```

### 2. Plugins — JS module ที่เพิ่ม tool เอง

```
extensions/plugins/<ชื่อ>/plugin.json   # { "name", "description", "entry": "index.mjs" }
extensions/plugins/<ชื่อ>/index.mjs
```

```js
export const prompt = "ทางเลือก: ข้อความที่จะถูกเพิ่มเข้า system prompt";
export const tools = [
  {
    name: "current_time",
    description: "คืนเวลาปัจจุบันตาม time zone",
    parameters: { type: "object", properties: { timeZone: { type: "string" } } },
    async handler(args) {
      return new Date().toISOString();
    },
  },
];
```

plugin รันในโปรเซสเดียวกับ agent จึงมีสิทธิ์เท่ากับ gateway — ติดตั้งเฉพาะจากแหล่งที่ไว้ใจ

### 3. MCP servers — ต่อ tool จาก ecosystem ของ MCP

gateway จะ spawn server แบบ stdio แล้วคุย JSON-RPC (`initialize` → `tools/list` → `tools/call`)
ทุก tool จะโผล่เป็น `<server>__<tool>`

```json
// extensions/mcp.json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
  }
}
```

server ที่สตาร์ทไม่ขึ้นจะถูกข้ามพร้อม log warning โดยไม่ทำให้ gateway ล่ม

### 4. clawhub — registry ให้ agent ติดตั้งเอง

`CLAWHUB_URL` ชี้ไปที่ index JSON (https, `file:` หรือ path ในเครื่อง) โครงสร้าง:

```json
{
  "version": 1,
  "entries": [
    { "name": "clock", "kind": "plugin", "version": "1.0.0", "description": "...",
      "files": { "plugin.json": "{...}", "index.mjs": "export const tools = [...]" } },
    { "name": "web-research", "kind": "skill", "files": { "SKILL.md": "..." } },
    { "name": "filesystem", "kind": "mcp", "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
  ]
}
```

คำสั่ง:

```bash
node dist/cli.js extensions                    # list ที่ติดตั้งแล้ว
node dist/cli.js extensions search research    # ค้น registry
node dist/cli.js extensions install clock      # ติดตั้ง (skill / plugin / mcp)
node dist/cli.js extensions remove clock       # ถอนออก
```

หรือให้ agent ทำเองผ่าน tool `extensions`:

```json
{"action":"search","query":"time"}
{"action":"list"}
{"action":"diagnostics"}
{"action":"install","name":"clock"}
{"action":"remove","name":"clock"}
{"action":"reload"}
```

### ทำไม plugin ไม่ขึ้น / สิทธิ์ของ agent

`npm run build && node dist/cli.js extensions diagnostics` (หรือ `{"action":"diagnostics"}`)
แสดงทุกโฟลเดอร์ที่เจอพร้อมสถานะ `loaded` / `skipped` / `failed` และเหตุผล เช่น ไม่มี entry module,
import แล้ว throw, export ไม่ตรงสัญญา `{ name, description, handler }` หรือชื่อ tool ชนกับของเดิม
รายงานนี้อยู่ใน `ready` frame ของบอร์ดด้วย (เมนู ☰ → Extensions) และใน `GET /api/status`

- **สิทธิ์ถูกบังคับตอนเรียก tool จริง** ไม่ใช่แค่ซ่อนจาก prompt: `ToolRegistry.invoke()` ปฏิเสธ
  extension tool ที่ไม่ได้อยู่ใน selection ของ agent (`skills`/`plugins`/`mcp`)
- **plugin แทนที่ tool เดิมไม่ได้โดยปริยาย** — ชื่อชนจะถูกข้ามและบันทึกใน diagnostics
  เปิดได้ด้วย `EXTENSIONS_ALLOW_TOOL_OVERRIDE=1`
- **การเปลี่ยน extension ต้องอนุมัติ**: `EXTENSIONS_AGENT_WRITES=confirm` (ค่าเริ่มต้น) ทำให้
  `install`/`remove`/`reload` จาก agent ถูกพักไว้ในคิว แล้วขึ้นปุ่ม **รออนุมัติ** บนบอร์ดให้กดอนุมัติ/ปฏิเสธ
  (`allow` = ทำทันที, `deny` = ห้ามทั้งหมด) คำขออยู่ในหน่วยความจำและหมดอายุใน 10 นาที
- **อนุมัติได้จากแชท**: คำขอใหม่ถูก push เข้า Telegram chat ที่อยู่ใน `TELEGRAM_ALLOWED_CHAT_IDS`
  และ LINE source ที่อยู่ใน `LINE_ALLOWED_SOURCE_IDS` ทุกช่อง พร้อม id ย่อ 8 ตัว
  ตอบ `approvals` เพื่อดูคิว, `approve <id>` เพื่ออนุมัติ, `reject <id>` เพื่อปฏิเสธ
  (ใช้ `/approve` หรือคำไทย `อนุมัติ`/`ปฏิเสธ` ก็ได้) ทุกช่องใช้คิวเดียวกัน — อนุมัติที่ไหนก็หายจากที่อื่น

การติดตั้งตรวจชื่อ (`[a-z0-9._-]`), ปฏิเสธ path ที่มี `..` หรือ absolute, จำกัดขนาดไฟล์ 512 KB
และ 40 ไฟล์ต่อ entry — registry ยังเป็นโค้ดที่รันได้ (plugin) จึงควรใช้ registry ที่คุณควบคุมเอง
repo นี้มี index ตัวอย่างที่ `clawhub/index.json`

## ให้ agent คุมเครื่องอื่น (หนึ่งปลั๊กอิน = หนึ่งเครื่อง)

agent ไม่ได้มี "computer" ติดตัว — มันรันอยู่ในโปรเซสของ gateway ที่เครื่องไหนก็ตาม
สิ่งที่ทำให้มันไปสั่งงานเครื่องอื่นได้คือ **ปลั๊กอินที่ห่อ ssh ไว้** โดยมีกฎง่าย ๆ:

```
[gateway รันที่ไหน]  ──ssh ออกไป──▶  [เครื่องปลายทางใน plugin.json]
   agent อยู่ที่นี่                     เครื่องที่ถูกคุม (compute)
```

- **หนึ่งโฟลเดอร์ปลั๊กอิน = หนึ่งเครื่อง** เพราะสิทธิ์ของ agent คุมที่ระดับปลั๊กอิน
  (`plugins` ใน `agents.json`) จึงเลือกได้ว่า agent ตัวไหนแตะเครื่องไหน
- ปลั๊กอินอ่านค่าจาก `plugin.json` → `config` (ไม่ต้องตั้ง env ก็ได้) แต่ override ด้วย env
  `<PREFIX>_HOST`, `<PREFIX>_PORT`, `<PREFIX>_USER` ได้ เช่น `MAC_HOST=...`
- โค้ด ssh ที่ใช้ร่วมกันอยู่ที่ `extensions/plugins/.shared/remote-shell.mjs`
  (โฟลเดอร์ที่ขึ้นต้นด้วย `.` จะไม่ถูกโหลดเป็นปลั๊กอิน)

### ปลั๊กอินที่ repo นี้ให้มา

| ปลั๊กอิน | ไฟล์ตั้งค่า | ค่าเริ่มต้น | tool ที่ agent เห็น |
| --- | --- | --- | --- |
| `vivo-shell` | `extensions/plugins/vivo-shell/plugin.json` | `100.126.244.52:8022`, user `u0_a218` (Termux) | `vivo_run`, `vivo_read`, `vivo_write` |
| `mac-shell` | `extensions/plugins/mac-shell/plugin.json` | `100.102.143.107:22`, user `lastcore` | `mac_run`, `mac_read`, `mac_write` |

```json
{
  "name": "mac-shell",
  "description": "Shell and file access to the Mac over ssh.",
  "entry": "index.mjs",
  "prompt": "ข้อความนี้ถูกเติมเข้า system prompt ของ agent ที่ใช้ปลั๊กอินนี้",
  "config": {
    "toolPrefix": "mac",
    "label": "Mac (macOS)",
    "host": "100.102.143.107",
    "port": 22,
    "user": "lastcore",
    "notes": "คำอธิบายสั้น ๆ ที่ต่อท้าย description ของ tool"
  }
}
```

ทุกเครื่องได้ tool ชุดเดียวกัน (`<prefix>_run`, `<prefix>_read`, `<prefix>_write`)
เช่น agent เรียก:

```json
{"command":"uname -a; free -m; df -h /data","timeout_seconds":30}
```

`<prefix>_run` คืน `exit: <code>` + `stdout` + `stderr` (ตัดที่ 6,000 ตัวอักษร) — agent จึงตรวจผลได้จริง
มี deny list กันคำสั่งพังเครื่อง: `rm -rf /`, `mkfs`, `dd of=/dev/...`, `reboot|shutdown|halt`,
`pm uninstall|clear`, `su -c` (คำสั่งที่ตรงจะถูกปฏิเสธก่อนยิง ssh)

### เตรียม ssh ให้ปลายทางไว้ใจ gateway

ขา gateway → ปลายทางต้องมีคีย์ (ไม่ถามรหัสผ่าน เพราะรันแบบ `BatchMode=yes`):

```bash
# บนเครื่องที่รัน gateway
ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519     # ถ้ายังไม่มี
ssh-copy-id -p 22 lastcore@100.102.143.107           # หรือ -p 8022 สำหรับ Termux
ssh -p 22 -o BatchMode=yes lastcore@100.102.143.107 'echo OK'
```

บน Android ใช้ Termux: `pkg install openssh`, รัน `sshd` (ค่าเริ่มต้นพอร์ต 8022),
สร้างคีย์ในเครื่องแล้วเอา `~/.ssh/id_ed25519.pub` ไปต่อท้าย `~/.ssh/authorized_keys` ของเครื่องปลายทาง
ถ้าเป็นทิศกลับ (gateway อยู่บนมือถือ อยากคุม Mac) ให้ทำเหมือนกันแต่กลับด้าน:

```bash
# บนมือถือ (Termux)
ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
# แล้วเอาไปต่อท้าย ~/.ssh/authorized_keys ของ Mac (chmod 600, ไม่มีบรรทัดค้างโดยไม่ขึ้นบรรทัดใหม่)
ssh -p 22 lastcore@100.102.143.107 'echo MAC-OK'
```

> เคยเจอ: ต่อคีย์แบบไม่มี newline ทำให้สองบรรทัดติดกันแล้ว sshd มองไม่เห็นคีย์
> เช็กด้วย `ssh-keygen -l -f ~/.ssh/authorized_keys` ว่าคีย์ที่ต้องการโผล่ในลิสต์จริง

### เพิ่มเครื่องที่สาม

```bash
cp -r extensions/plugins/mac-shell extensions/plugins/s23-shell
# แก้ plugin.json: name = "s23-shell", toolPrefix = "s23", host = 100.89.67.123, user = ...
```

แล้วรีโหลด extension (ไม่ต้องรีสตาร์ท gateway ก็ได้):

```bash
node dist/cli.js extensions                 # ดูว่าปลั๊กอินขึ้น loaded
# หรือสั่งผ่านบอร์ด/agent: {"action":"diagnostics"} แล้ว {"action":"reload"} ของ tool `extensions`
```

log ของ gateway จะขึ้น `extensions: 0 skill(s), 3 plugin(s), 0 mcp server(s)`
(ถ้า `EXTENSIONS_AGENT_WRITES=confirm` การ `reload` จาก agent จะเข้าคิวรออนุมัติบนบอร์ด)

### ตั้งค่าจากบอร์ด (ไม่ต้องแก้ไฟล์ ไม่ต้องจำคำสั่ง)

ทุกอย่างที่พูดถึงข้างบนทำจากหน้าจอได้ — เหมาะกับคนที่ไม่อยากแตะ JSON

**ขั้นที่ 0 (ทำครั้งเดียวต่อเครื่อง): ใส่กุญแจ ssh** — gateway ต้องเข้าเครื่องปลายทางได้แบบไม่ถามรหัสผ่าน

```bash
# บนเครื่องที่รัน gateway
ssh-copy-id -p 22 lastcore@100.102.143.107    # Termux ใช้ -p 8022 และ user ของ Termux
```

**ขั้นที่ 1: เพิ่มเครื่อง**

1. เปิดบอร์ด → เมนู ☰ (ซ้าย) → เลื่อนลงใต้ **Extensions** → กด **🖥 เครื่องที่ agent เข้าถึงได้**
2. ใส่ **IP เครื่อง (Tailscale)** เช่น `100.126.244.52` แล้วกด **บันทึกเครื่อง**
   - ระบบตั้งชื่อ tool ให้เองจาก IP: `100.126.244.52` → `t100_126_244_52_run` / `_read` / `_write`
   - อยากได้ชื่อสวย ๆ ใส่ **ชื่อเรียก** เช่น `vivo` → `vivo_run` (ต้องไม่ซ้ำกับเครื่องอื่น)
   - port = 22, user = ผู้ใช้เดียวกับ gateway (เว้นว่างไว้) — แก้ได้ใน **ตั้งค่าขั้นสูง**
   - ระบบสร้างโฟลเดอร์ `extensions/plugins/<ชื่อเรียกหรือ ip>-shell/` ให้ และ reload extension ทันที
3. ในการ์ดของเครื่อง ติ๊ก **ให้ agent ทำอะไรได้บ้าง** แล้วกดบันทึกอีกครั้งถ้าแก้:
   - `สั่งคำสั่ง (run)` = รันคำสั่ง shell
   - `อ่านไฟล์ (read)` = อ่านไฟล์ข้อความ
   - `เขียนไฟล์ (write)` = สร้าง/เขียนทับไฟล์
   - ปิด `write` = เครื่องนั้นเป็น **read-only จริง ๆ** (ไม่มี tool เขียนเลย ไม่ใช่แค่ปฏิเสธ)
4. กด **ทดสอบ** — ระบบยิง ssh 1 ครั้ง แล้วบอกผลเป็นภาษาไทย
   - ผ่าน: แสดง `uname` + `hostname` ของเครื่องนั้น
   - ไม่ผ่าน: บอกสาเหตุ เช่น *ยังไม่ได้ใส่กุญแจ ssh ของ gateway ใน authorized_keys* หรือ *เครื่องไม่ตอบ (ปิดอยู่ หรือ Tailscale ไม่ได้ต่อ)*
5. ไปที่ **ตั้งค่า agent** → หัวข้อ **Plugins** → ติ๊กชื่อปลั๊กอินของเครื่องนั้น (เช่น `vivo-shell`)

**ขั้นที่ 2: จำกัดสิทธิ์ระดับ tool (ถ้าต้องการ)**

ในหน้าตั้งค่า agent มีหัวข้อ **ห้ามใช้ tool** — ติ๊ก tool ที่ agent ตัวนี้ห้ามเรียก เช่นให้เข้าถึงมือถือได้
แต่ห้าม `vivo_write` อย่างเดียว ค่านี้เก็บใน `agents.json` ฟิลด์ `denyTools` และถูกบังคับที่ `ToolRegistry.invoke`
(ไม่ใช่แค่ซ่อนจาก prompt) เช่น:

```json
{ "id": "nova", "plugins": ["vivo-shell"], "denyTools": ["vivo_write"] }
```

**ขั้นที่ 3: ลบเครื่อง** — ในการ์ดกด **ลบ** โฟลเดอร์จะถูกย้ายไป `extensions/plugins/.removed/<ชื่อ>-<เวลา>/`
(กู้คืนได้ด้วยการย้ายกลับ) แล้ว gateway reload ให้เอง

> สรุปสองฝั่ง: **ฝั่ง runner** = บอร์ด/`agents.json` (ใครได้เครื่องไหน + ห้าม tool อะไร)
> · **ฝั่งที่ agent เข้าถึง** = `plugin.json` ของแต่ละเครื่อง (IP/port/user + เปิด tool ไหน + `denyExtra`)
> ทั้งสองฝั่งแก้จากบอร์ดได้ ไม่ต้องรีสตาร์ท gateway

### ให้ agent ตัวไหนใช้เครื่องไหน

บอร์ด → แตะตัวละคร → ชีตตั้งค่า → หัวข้อ **Plugins** → ติ๊กเครื่องที่อนุญาต

- ไม่ติ๊กเลย (`null`) = ใช้ได้ **ทุก** ปลั๊กอิน
- ติ๊กบางตัว = allowlist เฉพาะที่ติ๊ก และถูกบังคับตอนเรียก tool จริง (`ToolRegistry.invoke`)
- ค่าเก็บใน `agents.json` ฟิลด์ `plugins` เช่น `"plugins": ["vivo-shell"]`

### ตัวอย่างที่ 1: gateway บน Linux ใช้มือถือ vivo เป็น compute

สถานการณ์: gateway รันบนเครื่อง Linux ในบ้าน, agent ตัวหนึ่งชื่อ "Runner" ต้องการ CPU/เน็ตของมือถือ
(เช่น อัปโหลดไฟล์, รันสคริปต์ที่ต้องอยู่ในเน็ตมือถือ, อ่านไฟล์ใน `/sdcard`)

1. ติ๊ก `vivo-shell` ให้ agent Runner
2. ผู้ใช้พิมพ์ในบอร์ด: `ใช้ vivo เช็กพื้นที่ว่างแล้วลิสต์ไฟล์ดาวน์โหลด 5 ไฟล์ล่าสุด`
3. agent เรียก tool เอง:

```json
{"command":"df -h /data /sdcard | tail -2; ls -t /sdcard/Download | head -5"}
```

4. ได้ผลกลับเป็นข้อความ `exit: 0 ...` แล้ว agent สรุปเป็นภาษาไทย

เขียนไฟล์/สคริปต์ข้ามเครื่อง:

```json
{"path":"/sdcard/zel4thmobile/report.md","content":"# ยอดขายวันนี้\n- ..."}
```

ข้อจำกัดของ Termux ที่ควรรู้ (เจอจริงบนเครื่องทดสอบ):

- `PATH` ของ Termux **ไม่มี** `/system/bin` → ต้องเรียกเต็มหรือเติมเอง เช่น
  `export PATH=/system/bin:$PATH; input keyevent 4`
- ใช้ `/system/bin/pm list packages` ได้ แต่ `/system/bin/cmd package ...` อาจ throw Binder error
- `screencap -p /sdcard/x.png` เขียนไฟล์ได้แต่ขนาด 0 ไบต์จนกว่าจะให้สิทธิ์storage/termux-api ครบ
- `input tap|text|keyevent` ใช้ได้ (หลังเติม PATH) → ใช้กดปุ่ม/พิมพ์แทนมือได้

### ตัวอย่างที่ 2: "โพสต์คอนเทนต์ Facebook ที่ล็อกอินไว้ใน vivo"

มี 3 ทาง เลือกตามสภาพเครื่องจริง (บน vivo เครื่องทดสอบ **ไม่ได้ติดตั้งแอป Facebook** —
`pm list packages` เจอแค่ `com.facebook.services/system/appmanager` ซึ่งเป็น service ของระบบ)

**A. Graph API (แนะนำ, ไม่ต้องพึ่งมือถือ)** — ตั้ง `FACEBOOK_PAGE_ID` + `FACEBOOK_PAGE_ACCESS_TOKEN`
แล้ว agent มี tool `facebook_post` ใช้ได้เอง (โพสต์ลง Page, token อยู่ฝั่งเซิร์ฟเวอร์):

```json
{"message":"โปรโมชันสัปดาห์นี้ ลด 20%","link":"https://example.com/promo"}
```

**B. ใช้ session เบราว์เซอร์ที่ล็อกอินค้างไว้บนมือถือ** — เปิดหน้าคอมโพสผ่าน intent
แล้วให้ agent พิมพ์/กดด้วย `input` (ต้องเติม PATH ก่อน):

```bash
/system/bin/am start -a android.intent.action.VIEW -d 'https://m.facebook.com/'
export PATH=/system/bin:$PATH
input tap 540 2100        # แตะช่องเขียนโพสต์ (พิกัดจริงต้องดูจากหน้าจอเครื่อง)
input text 'hello%sworld' # เว้นวรรคใน input text ต้องเขียนเป็น %s
```

ข้อควรระวัง: พิกัดปุ่มขึ้นกับรุ่น/ธีม/ขนาดฟอนต์, หน้าเว็บอาจเด้งไปเปิดแอป, และ **ไม่มีอะไรยืนยันว่าโพสต์สำเร็จ**
ถ้าไม่เช็กหน้าจอ — ควรให้คนกด "โพสต์" เองเป็นค่าเริ่มต้น

**C. ถ้าติดตั้งแอป Facebook ภายหลัง** — ใช้ share intent เปิดหน้าคอมโพสพร้อมข้อความ (คนกด Post เอง):

```bash
/system/bin/am start -a android.intent.action.SEND -t text/plain \
  --es android.intent.extra.TEXT 'โปรโมชันสัปดาห์นี้ ลด 20%' \
  -p com.facebook.katana
```

ถ้าอยากให้ "สั่งแล้วจบ" จริง ๆ ให้ใช้ทาง A (Graph API) หรือเขียนปลั๊กอินเฉพาะที่ยืนยันผลได้
(เช่น อ่าน feed กลับมาเช็ก) ดีกว่าฝากความหวังไว้กับการเดาพิกัด

### ความปลอดภัย

- tool จากปลั๊กอิน **ไม่มีการขออนุมัติ** (ระบบอนุมัติคุมเฉพาะการติดตั้ง/ถอด extension)
  ปลั๊กอินจึงมีสิทธิ์เท่ากับ user ที่รัน gateway — ให้เฉพาะ agent ที่ไว้ใจ
- จำกัดด้วย allowlist ต่อ agent และอย่าให้ทุกตัวเห็นเครื่องที่มีข้อมูลสำคัญ
- ถ้าต้องการปิดทาง ssh ทั้งหมด: ลบโฟลเดอร์ปลั๊กอินหรือตั้ง `plugins: []` ให้ agent
- คีย์ส่วนตัวอยู่บนเครื่องที่รัน gateway เท่านั้น — อย่า commit `~/.ssh` ลง repo

### แก้ปัญหาที่เจอบ่อย

| อาการ | สาเหตุ / ทางแก้ |
| --- | --- |
| `Permission denied (publickey,...)` | คีย์ของเครื่อง gateway ยังไม่อยู่ใน `authorized_keys` ของปลายทาง หรือบรรทัดคีย์เสีย (newline) — เช็ก `ssh-keygen -l -f` |
| `Connection refused` / timeout | ปลายทางไม่เปิด sshd, พอร์ตผิด (Termux = 8022), หรือ Tailscale ไม่ได้ connect |
| `input: app_process: inaccessible` | ยังไม่เติม `export PATH=/system/bin:$PATH` |
| ปลั๊กอินไม่ขึ้นในบอร์ด | `{"action":"diagnostics"}` ดู `skipped`/`failed` + เหตุผล แล้ว `{"action":"reload"}` |
| agent มองไม่เห็น tool เลย | ยังไม่ติ๊กปลั๊กอินในชีต agent (หรือติ๊กตัวอื่นไว้ = allowlist ปิดตัวนี้) |

## Board + gateway protocol

board เปิด WebSocket ไปที่ `ws://<host>/ws?token=<GATEWAY_TOKEN>` (หรือ header
`Authorization: Bearer <token>`). token ผิดจะถูกปฏิเสธที่ขั้นตอน HTTP upgrade ด้วย `401` ก่อนสร้าง socket
เทียบ token ด้วย SHA-256 + `timingSafeEqual`

ฝั่ง board → gateway:

| frame | ความหมาย |
| --- | --- |
| `{type:"chat.send", sessionId, text}` | ส่งข้อความให้ agent |
| `{type:"model.set", sessionId, model}` | เปลี่ยน model ของ session |
| `{type:"models.list"}` | ขอรายการ model |
| `{type:"sessions.list"}` | ขอรายการ session |
| `{type:"session.history", sessionId}` | ขอประวัติ |
| `{type:"session.reset", sessionId}` | ล้างประวัติ |
| `{type:"ping"}` | health check |
| `{type:"approvals.list"}` | ขอคิวอนุมัติ + diagnostics ปัจจุบัน |
| `{type:"approval.approve", id}` | อนุมัติคำขอ (ติดตั้ง/ถอน/รีโหลด extension) |
| `{type:"approval.reject", id}` | ปฏิเสธคำขอ |

ฝั่ง gateway → board:

| frame | ความหมาย |
| --- | --- |
| `{type:"ready", tools, models, defaultModel, extensions}` | handshake สำเร็จ (มีรายชื่อ skill/plugin/mcp ที่โหลดอยู่) |
| `{type:"event", event:{type:"turn.start"}}` | เริ่ม turn |
| `{type:"event", event:{type:"tool.start", name, args}}` | กำลังเรียก tool |
| `{type:"event", event:{type:"tool.result", ok, preview}}` | ผล tool |
| `{type:"event", event:{type:"assistant.message", text}}` | คำตอบ |
| `{type:"event", event:{type:"turn.end", iterations, usage, costUsd}}` | จบ turn พร้อม token รวมและค่าใช้จ่ายโดยประมาณ (`costUsd` = `null` ถ้ายังไม่ตั้งราคา) |
| `{type:"approvals.state", requests, writes, diagnostics}` | คิวอนุมัติเปลี่ยน (broadcast) |
| `{type:"approval.result", id, ok, message}` | ผลของการอนุมัติ/ปฏิเสธ |
| `{type:"error", message}` | ข้อผิดพลาด |

 eventosถูก broadcast ให้ทุก board client ที่ผ่านการยืนยันตัวตน

## API

- `GET /api/health` — เปิดสาธารณะ, ใช้ตรวจว่า gateway ยังมีชีวิต
- `GET /api/status` — ต้องส่ง token ผ่าน `Authorization: Bearer` หรือ `?token=`

## ทดสอบ

```bash
npm run typecheck
npm run build
npm run smoke
```

`smoke` จะสตาร์ท gateway จริงบนพอร์ตสุ่ม ใช้ stub server แทน OpenAI และ Graph API แล้วตรวจ:
health/board assets, การปฏิเสธ token ผิด, การรับ token ถูก, เลือก model, agent loop ที่เรียก
`facebook_post` จริง (ตรวจว่า message/access_token ถูกส่งไป Graph), ประวัติ session และ reset

ถ้าแก้ไอคอน/หน้า board ให้รัน `npm run icons` เมื่อแก้ `scripts/make-icons.mjs`
(ไฟล์ PNG ใน `board/icons/` ถูก commit ไว้แล้ว ไม่ต้องสร้างใหม่ตอน deploy)

## ข้อควรระวัง

- ถือ `GATEWAY_TOKEN` เป็นความลับเหมือนรหัสผ่าน: ใครได้ token ไปจะสั่ง agent ได้ทุกอย่าง
  (รวมถึงโพสต์ Facebook) — gateway ไม่รับ connection ที่ไม่มี token เลย
- `TELEGRAM_ALLOWED_CHAT_IDS` ว่าง = ไม่มีใครใช้งานได้ ถ้าต้องการเปิดให้ใครเพิ่ม ให้ใส่ chat id ของคนนั้น
  (รวมถึงการเพิ่มบอทเข้ากลุ่ม ซึ่งจะได้ chat id เป็นค่าลบ)
- ข้อมูล session เก็บเป็นไฟล์ใน `data/` (ถูก gitignore) ลบโฟลเดอร์นี้เพื่อล้างทั้งหมด
- LINE webhook ไม่ใช้ `GATEWAY_TOKEN` แต่เชื่อถือ signature ของ LINE เท่านั้น — อย่าเปิด path นี้
  ออกสู่อินเทอร์เน็ตโดยไม่มี HTTPS และควรตั้ง `LINE_ALLOWED_SOURCE_IDS` เสมอ
- plugin รันในโปรเซสเดียวกับ gateway: การอนุมัติควรอ่านชื่อ/แหล่งที่มาของ extension ก่อนกดทุกครั้ง

## Agents and the office view

The board is not one assistant anymore: it is a small office of agents. Each agent is a
profile in `data/agents.json` (no database) with its own name, emoji, role, reply prefix, identity text,
default model, character sprite, position on the stage, and its own allowlist of skills,
plugins and MCP servers.

Create, move and configure agents entirely from the board, no `.env` edit and no terminal:

- **Tap a character** (or its name in the drawer) to open its settings sheet: model,
  name, emoji, role, identity text, character sprite, colour, and which installed
  skills / plugins / MCP servers that agent may use.
- **Drag a character** to move it; the position is stored server-side and synced to every
  open board.
- **Scene chips** at the bottom switch the office backdrop for every client.
- **＋ Agent** (in the office bar or the drawer) creates another agent.
- While an agent works, its character shows a bubble with the current tool and a pulse.

Provider keys and channel tokens still live in `.env`: the board never accepts secrets.
Everything else about an agent is editable in the UI.

### Board protocol additions

| frame | direction | meaning |
| --- | --- | --- |
| `ready` | server → client | now also carries `agents`, `scene` and `office` (scenes + characters) |
| `agent.create` | client → server | `{ name, emoji, role, replyPrefix, identity, model, color, sprite }` |
| `agent.update` | client → server | `{ id, ...any of the fields above, x, y, skills, plugins, mcp }` |
| `agent.delete` | client → server | `{ id }` |
| `office.scene` | client → server | `{ scene }` |
| `office.move` | client → server | `{ id, x, y }` (percent of the stage) |
| `agents.state` | server → client | full agent + office state, broadcast after any change |

`chat.send` accepts an optional `agentId`; that agent's identity, role and model are used
for the turn, and only its allowed extension tools are offered to the model. Character
conversations use the session id `board:agent:<agentId>`.

### Using your own characters and scenes

Drop images into `board/assets/scenes/` and `board/assets/characters/` — any `.svg`,
`.png`, `.webp`, `.jpg` or `.gif` is picked up automatically and appears in the scene
picker / character select. For an animated sprite sheet, describe it in
`board/assets/office.json`:

```json
{
  "scenes": [{ "id": "studio", "name": "สตูดิโอ", "image": "/assets/scenes/studio.svg" }],
  "characters": [
    { "id": "hero", "name": "Hero", "image": "/assets/characters/hero.png", "frames": 6, "fps": 8 }
  ]
}
```

`frames` is the number of frames in one horizontal strip and `fps` is the playback speed;
the board animates the strip by itself. Files are served from the same origin as the board.
