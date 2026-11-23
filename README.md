# clawgate

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
| `src/gateway/server.ts` | HTTP + WebSocket gateway (ตรวจ token ก่อน upgrade) และเสิร์ฟ board |
| `src/store.ts` | เก็บ session เป็นไฟล์ JSON ใน `data/sessions/` |
| `src/usage.ts` | บันทึก token ต่อ turn และประมาณค่าใช้จ่ายต่อ model/provider (`data/usage.jsonl` + `clawgate usage`) |
| `board/` | board UI แบบ mobile-first (vanilla JS) ต่อ WebSocket, เลือก model, ดู tool call แบบสด |
| `board/manifest.webmanifest`, `board/sw.js`, `board/icons/` | ทำให้ board ติดตั้งเป็นแอพได้ (PWA) |
| `scripts/make-icons.mjs` | สร้างไอคอน PNG ทั้งชุดโดยไม่ต้องพึ่ง library ภายนอก (`npm run icons`) |
| `src/cli.ts` | คำสั่ง `gateway`, `chat`, `models`, `usage`, `extensions` |

## เริ่มใช้งาน

```bash
npm install
cp .env.example .env
# แก้ GATEWAY_TOKEN และใส่ key ของ model อย่างน้อยหนึ่งตัว
npm run dev           # = tsx src/cli.ts gateway
```

จะได้ log แบบนี้ — เปิดลิงก์ board ได้เลย (token ถูกฝังใน URL แล้ว):

```
clawgate gateway listening on http://0.0.0.0:8787
board:  http://localhost:8787/?token=...
socket: ws://localhost:8787/ws
```

คำสั่งอื่น: `npm run chat` (คุยใน terminal), `npm run models` (ดู model ที่ตั้งไว้),
`npm run usage` (สรุป token/ค่าใช้จ่าย), `npm run build && npm start` (prod build),
`npm run smoke` (ทดสอบ gateway + agent loop ด้วย stub server)

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
{"action":"install","name":"clock"}
{"action":"list"}
{"action":"remove","name":"clock"}
{"action":"reload"}
```

การติดตั้งตรวจชื่อ (`[a-z0-9._-]`), ปฏิเสธ path ที่มี `..` หรือ absolute, จำกัดขนาดไฟล์ 512 KB
และ 40 ไฟล์ต่อ entry — registry ยังเป็นโค้ดที่รันได้ (plugin) จึงควรใช้ registry ที่คุณควบคุมเอง
repo นี้มี index ตัวอย่างที่ `clawhub/index.json`

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

ฝั่ง gateway → board:

| frame | ความหมาย |
| --- | --- |
| `{type:"ready", tools, models, defaultModel, extensions}` | handshake สำเร็จ (มีรายชื่อ skill/plugin/mcp ที่โหลดอยู่) |
| `{type:"event", event:{type:"turn.start"}}` | เริ่ม turn |
| `{type:"event", event:{type:"tool.start", name, args}}` | กำลังเรียก tool |
| `{type:"event", event:{type:"tool.result", ok, preview}}` | ผล tool |
| `{type:"event", event:{type:"assistant.message", text}}` | คำตอบ |
| `{type:"event", event:{type:"turn.end", iterations, usage, costUsd}}` | จบ turn พร้อม token รวมและค่าใช้จ่ายโดยประมาณ (`costUsd` = `null` ถ้ายังไม่ตั้งราคา) |
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

## Agents and the office view

The board is not one assistant anymore: it is a small office of agents. Each agent is a
profile in `data/agents.json` (no database) with its own name, emoji, role, identity text,
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
| `agent.create` | client → server | `{ name, emoji, role, identity, model, color, sprite }` |
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
