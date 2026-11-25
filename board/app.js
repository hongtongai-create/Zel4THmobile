const els = {
  drawer: document.getElementById("drawer"),
  scrim: document.getElementById("scrim"),
  menu: document.getElementById("menu"),
  drawerClose: document.getElementById("drawer-close"),
  drawerPin: document.getElementById("drawer-pin"),
  install: document.getElementById("install"),
  login: document.getElementById("login"),
  loginForm: document.getElementById("login-form"),
  loginError: document.getElementById("login-error"),
  tokenInput: document.getElementById("token-input"),
  messages: document.getElementById("messages"),
  empty: document.getElementById("empty"),
  composer: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  modelBtn: document.getElementById("model-btn"),
  modelChipText: document.getElementById("model-chip-text"),
  modelSheet: document.getElementById("model-sheet"),
  modelOptions: document.getElementById("model-options"),
  sheetClose: document.getElementById("sheet-close"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  agentList: document.getElementById("agent-list"),
  sessionList: document.getElementById("session-list"),
  newAgent: document.getElementById("new-agent"),
  addAgent: document.getElementById("add-agent"),
  viewToggle: document.getElementById("view-toggle"),
  viewTitle: document.getElementById("view-title"),
  viewMeta: document.getElementById("view-meta"),
  chatView: document.getElementById("chat-view"),
  chatPortrait: document.getElementById("chat-portrait"),
  chatSpeaker: document.getElementById("chat-speaker"),
  talkView: document.getElementById("talk-view"),
  talkPortrait: document.getElementById("talk-portrait"),
  talkName: document.getElementById("talk-name"),
  talkText: document.getElementById("talk-text"),
  talkClose: document.getElementById("talk-close"),
  stage: document.getElementById("stage"),
  sceneLayer: document.getElementById("scene-layer"),
  sceneFrame: document.getElementById("scene-frame"),
  scenePicker: document.getElementById("scene-picker"),
  stageEmpty: document.getElementById("stage-empty"),
  agentSheet: document.getElementById("agent-sheet"),
  agentSheetTitle: document.getElementById("agent-sheet-title"),
  agentSheetClose: document.getElementById("agent-sheet-close"),
  agentForm: document.getElementById("agent-form"),
  agentSave: document.getElementById("agent-save"),
  agentChat: document.getElementById("agent-chat"),
  agentReset: document.getElementById("agent-reset"),
  agentDelete: document.getElementById("agent-delete"),
  agentError: document.getElementById("agent-error"),
  approvalsBtn: document.getElementById("approvals-btn"),
  approvalCount: document.getElementById("approval-count"),
  approvalSheet: document.getElementById("approval-sheet"),
  approvalSheetClose: document.getElementById("approval-sheet-close"),
  approvalList: document.getElementById("approval-list"),
  approvalHint: document.getElementById("approval-hint"),
  extensionList: document.getElementById("extension-list"),
  toolList: document.getElementById("tool-list"),
  toast: document.getElementById("toast"),
};

const SESSION_KEY = "clawgate.session";
const TOKEN_KEY = "clawgate.token";
const MODEL_KEY = "clawgate.model";
const AGENT_PREFIX = "board:agent:";
const SCENE_FALLBACK_ASPECT = 1086 / 1448;
let sceneAspect = SCENE_FALLBACK_ASPECT;

const state = {
  ws: null,
  token: null,
  sessionId: null,
  models: [],
  currentModel: null,
  defaultModel: null,
  tools: [],
  extensions: { skills: [], plugins: [], mcp: [] },
  agents: [],
  scene: null,
  office: { scenes: [], characters: [] },
  view: "office",
  agentId: null,
  sheetAgentId: null,
  creating: false,
  chatTitle: "แชท",
  chatMeta: "no messages yet",
  activity: new Map(),
  approvals: [],
  diagnostics: [],
  extensionWrites: "confirm",
  reconnectTimer: null,
  pingTimer: null,
  retries: 0,
  busy: false,
  typing: null,
  toolChips: new Map(),
  installEvent: null,
  stickToBottom: true,
};

/* localStorage with a sessionStorage fallback (private browsing / blocked storage) */
const storage = {
  get(key) {
    try {
      return localStorage.getItem(key) ?? sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      try {
        sessionStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/* ---------- small helpers ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function short(text, max) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function newSessionId() {
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `board:${id}`;
}

function agentSessionId(id) {
  return `${AGENT_PREFIX}${id}`;
}

function sessionAgentId(sessionId) {
  if (typeof sessionId !== "string" || !sessionId.startsWith(AGENT_PREFIX)) return null;
  return sessionId.slice(AGENT_PREFIX.length) || null;
}

function findAgent(id) {
  if (!id) return null;
  return state.agents.find((agent) => agent.id === id) ?? null;
}

function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove("show"), 2600);
}

/* ---------- status + header ---------- */

function setStatus(kind, text) {
  els.statusDot.className = `dot ${kind}`;
  els.statusText.textContent = text;
}

function setModelChip(model) {
  state.currentModel = model;
  els.modelChipText.textContent = model || "no model";
  els.modelBtn.disabled = state.models.length === 0;
}

function setChatHeader(title, meta) {
  state.chatTitle = title || "แชท";
  if (meta != null) state.chatMeta = meta;
  updateViewChrome();
}

function setChatMeta(meta) {
  state.chatMeta = meta;
  updateViewChrome();
}

function updateViewChrome() {
  document.body.dataset.view = state.view;
  els.viewToggle.textContent = state.view === "office" ? "แชท" : "ออฟฟิศ";
  syncChatSpeaker();

  if (state.view === "office") {
    const scene = (state.office.scenes ?? []).find((entry) => entry.id === state.scene);
    els.viewTitle.textContent = "ออฟฟิศ";
    els.viewMeta.textContent = `${state.agents.length} agent · ${scene?.name ?? "ไม่มีฉาก"}`;
    return;
  }
  els.viewTitle.textContent = state.chatTitle;
  els.viewMeta.textContent = state.chatMeta;
}

/** The chat plate names and pictures whoever a message would go to. */
function syncChatSpeaker() {
  const agent = findAgent(state.agentId);
  const label = agent?.name ?? "clawgate";
  if (els.chatSpeaker.textContent !== label) els.chatSpeaker.textContent = label;
  const key = agent ? `${agent.id}:${agent.sprite ?? ""}` : "";
  if (els.chatPortrait.dataset.agent === key) return;
  els.chatPortrait.dataset.agent = key;
  paintPortrait(els.chatPortrait, agent);
}

function setView(view) {
  state.view = view;
  updateViewChrome();
  if (view === "chat") {
    els.messages.scrollTop = els.messages.scrollHeight;
    els.viewToggle.blur();
  }
}

/* ---------- chat messages ---------- */

function hideEmpty() {
  if (els.empty) {
    els.empty.remove();
    els.empty = null;
  }
}

function scrollToBottom(force = false) {
  if (!force && !state.stickToBottom) return;
  els.messages.scrollTop = els.messages.scrollHeight;
}

els.messages.addEventListener("scroll", () => {
  const distance = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight;
  state.stickToBottom = distance < 120;
});

function addBubble(role, text) {
  hideEmpty();
  const div = el("div", `msg ${role}`, text);
  els.messages.append(div);
  scrollToBottom(role === "user");
  return div;
}

function addToolChip(callId, name, args, phase) {
  hideEmpty();
  const chip = el("div", "tool");
  chip.dataset.callId = callId;

  const head = el("div", "head");
  const icon = el("span", null, phase === "running" ? "⋯" : "✓");
  const label = el("span", "name", name);
  const status = el("span", null, phase === "running" ? "running" : "done");
  head.append(icon, label, status);

  const payload = el("div", "payload", typeof args === "string" ? args : JSON.stringify(args));
  chip.append(head, payload);
  els.messages.append(chip);
  state.toolChips.set(callId, { chip, icon, status, payload });
  scrollToBottom();
  return chip;
}

function finishToolChip(event) {
  const entry = state.toolChips.get(event.callId);
  if (!entry) return;
  entry.icon.textContent = event.ok ? "✓" : "✗";
  entry.status.textContent = event.ok ? "done" : "failed";
  entry.payload.textContent = event.preview || "(no output)";
  if (!event.ok) entry.chip.classList.add("failed");
  scrollToBottom();
}

function showTyping() {
  if (state.typing) return;
  hideEmpty();
  const div = el("div", "typing", "agent is working");
  els.messages.append(div);
  state.typing = div;
  scrollToBottom(true);
}

function stopTyping() {
  state.typing?.remove();
  state.typing = null;
}

function setBusy(busy) {
  state.busy = busy;
  els.send.disabled = busy;
  if (!busy) stopTyping();
}

function updateMeta(session) {
  const count = (session?.messages ?? []).length;
  const model = session?.model ?? state.currentModel ?? "";
  setChatMeta(count ? `${count} ข้อความ · ${model}` : "ยังไม่มีข้อความ");
}

/* ---------- drawer / sheets ---------- */

function openDrawer() {
  els.drawer.classList.add("open");
  els.scrim.classList.add("show");
}

function closeDrawer() {
  els.drawer.classList.remove("open");
  els.scrim.classList.remove("show");
}

const PIN_KEY = "clawgate.drawerPinned";

function drawerIsPinned() {
  return document.body.classList.contains("drawer-pinned");
}

/** Pin the left bar open as a sidebar, or let it slide away as a drawer. */
function setDrawerPinned(pinned) {
  document.body.classList.toggle("drawer-pinned", pinned);
  if (els.drawerPin) {
    els.drawerPin.setAttribute("aria-pressed", String(pinned));
    els.drawerPin.textContent = pinned ? "📌" : "📍";
    els.drawerPin.title = pinned ? "ปลดหมุดเมนู" : "ปักหมุดเมนู";
  }
  try {
    localStorage.setItem(PIN_KEY, pinned ? "1" : "0");
  } catch {
    /* private mode: the choice simply does not persist */
  }
  if (pinned) closeDrawer();
  // The office stage changed width, so the scene has to be re-fitted.
  layoutSceneFrame();
}

function openModelSheet() {
  if (state.models.length === 0) {
    toast("ยังไม่มีโมเดลใน gateway");
    return;
  }
  renderModelOptions();
  els.modelSheet.classList.add("open");
  els.modelSheet.setAttribute("aria-hidden", "false");
  closeDrawer();
}

function closeModelSheet() {
  els.modelSheet.classList.remove("open");
  els.modelSheet.setAttribute("aria-hidden", "true");
}

function closeAgentSheet() {
  els.agentSheet.classList.remove("open");
  els.agentSheet.setAttribute("aria-hidden", "true");
  state.sheetAgentId = null;
  state.creating = false;
}

/* ---------- approvals ---------- */

const WRITE_MODES = {
  confirm: "โหมด: ต้องอนุมัติทุกครั้ง — agent ติดตั้ง/ถอน/รีโหลด extension เองไม่ได้",
  allow: "โหมด: agent เปลี่ยน extension ได้เองโดยไม่ต้องอนุมัติ (EXTENSIONS_AGENT_WRITES=allow)",
  deny: "โหมด: ปิดการเปลี่ยน extension จาก agent ทั้งหมด (EXTENSIONS_AGENT_WRITES=deny)",
};

function closeApprovalSheet() {
  els.approvalSheet.classList.remove("open");
  els.approvalSheet.setAttribute("aria-hidden", "true");
}

function approvalLabel(request) {
  const head = request.name ? `${request.action} · ${request.name}` : request.action;
  return head;
}

function renderApprovals(requests) {
  state.approvals = Array.isArray(requests) ? requests : [];
  const pending = state.approvals.filter((request) => request.status === "pending");
  els.approvalCount.textContent = String(pending.length);
  els.approvalsBtn.hidden = pending.length === 0;
  els.approvalHint.textContent = WRITE_MODES[state.extensionWrites] ?? WRITE_MODES.confirm;
  els.approvalList.innerHTML = "";

  if (pending.length === 0) {
    els.approvalList.append(el("p", "muted", "ไม่มีคำขอที่รออนุมัติ"));
    if (els.approvalSheet.classList.contains("open")) closeApprovalSheet();
    return;
  }

  for (const request of pending) {
    const card = el("div", "approval-card");
    const agent = findAgent(request.agentId);
    const meta = [
      agent ? `${agent.emoji || "🤖"} ${agent.name}` : request.sessionId,
      request.action === "install"
        ? "ติดตั้งโค้ดใหม่จาก registry"
        : request.action === "remove"
          ? "ถอนออกจากเครื่อง"
          : "โหลด extension ใหม่ทั้งหมด",
    ].join(" · ");

    const actions = el("div", "approval-actions");
    const approve = el("button", "primary", "อนุมัติ");
    approve.type = "button";
    approve.addEventListener("click", () => {
      approve.disabled = true;
      send({ type: "approval.approve", id: request.id });
    });
    const reject = el("button", "ghost danger", "ปฏิเสธ");
    reject.type = "button";
    reject.addEventListener("click", () => send({ type: "approval.reject", id: request.id }));
    actions.append(approve, reject);

    card.append(el("strong", null, approvalLabel(request)), el("p", "muted", meta), actions);
    els.approvalList.append(card);
  }
}

function openApprovalSheet() {
  renderApprovals(state.approvals);
  els.approvalSheet.classList.add("open");
  els.approvalSheet.setAttribute("aria-hidden", "false");
}

function renderExtensions(diagnostics) {
  state.diagnostics = Array.isArray(diagnostics) ? diagnostics : [];
  els.extensionList.innerHTML = "";
  if (state.diagnostics.length === 0) {
    els.extensionList.append(el("li", "muted", "ไม่มี extension"));
    return;
  }
  for (const entry of state.diagnostics) {
    const li = el("li", `ext ${entry.status}`);
    li.append(el("span", "ext-name", `${entry.kind}: ${entry.name}`));
    li.append(el("span", "ext-reason", entry.reason));
    li.title = entry.reason;
    els.extensionList.append(li);
  }
}

/* ---------- office ---------- */

function layoutSceneFrame() {
  const frame = els.sceneFrame;
  if (!frame) return;
  const w = els.stage.clientWidth;
  const h = els.stage.clientHeight;
  if (w <= 0 || h <= 0) return;
  let fw = w;
  let fh = w / sceneAspect;
  if (fh > h) {
    fh = h;
    fw = h * sceneAspect;
  }
  frame.style.width = `${Math.round(fw)}px`;
  frame.style.height = `${Math.round(fh)}px`;
  frame.style.left = `${Math.round((w - fw) / 2)}px`;
  frame.style.top = `${Math.round(h - fh)}px`;
  const actorSize = Math.round(clamp(Math.min(w, h) * 0.19, 104, 160));
  document.documentElement.style.setProperty("--actor-size", `${actorSize}px`);
}

function applyScene(scene) {
  const url = scene ? `url("${scene.image}")` : "none";
  els.sceneLayer.style.backgroundImage = url;
  els.sceneFrame.style.backgroundImage = url;
  els.stage.classList.toggle("no-scene", !scene);
  layoutSceneFrame();
  if (!scene) return;
  const img = new Image();
  img.onload = () => {
    if (!img.naturalWidth || !img.naturalHeight) return;
    if (els.sceneFrame.style.backgroundImage !== url) return;
    sceneAspect = img.naturalWidth / img.naturalHeight;
    layoutSceneFrame();
  };
  img.src = scene.image;
}

function renderOffice() {
  const scenes = state.office.scenes ?? [];
  const scene = scenes.find((entry) => entry.id === state.scene) ?? scenes[0] ?? null;
  applyScene(scene);

  syncActors(state.agents);

  els.stageEmpty.hidden = state.agents.length > 0;
  renderScenePicker();
  renderAgentList();
  paintAllActivity();
  updateViewChrome();
}

function actorEl(id) {
  return [...els.sceneFrame.querySelectorAll(".actor")].find((node) => node.dataset.id === id) ?? null;
}

const LEGACY_SPRITES = ["bolt", "claw", "lab", "night", "nova", "studio"];

function characterAsset(agent) {
  return (state.office.characters ?? []).find(
    (entry) => entry.id === agent.sprite || entry.image === agent.sprite,
  );
}

/** Resolve a profile's sprite to an image, including the pre-sheet characters. */
function characterImage(agent) {
  const asset = characterAsset(agent) ?? null;
  // Profiles saved before the sprite sheets still point at the old flat
  // characters, which live in assets/legacy/ now.
  const legacy =
    !asset && LEGACY_SPRITES.includes(agent.sprite) ? `/assets/legacy/${agent.sprite}.svg` : null;
  const image =
    asset?.image ?? (agent.sprite && agent.sprite.startsWith("/") ? agent.sprite : null) ?? legacy;
  return { asset, image };
}

/** Paint a character's first sheet frame into a dialogue portrait slot. */
function paintPortrait(node, agent) {
  if (!node) return;
  node.style.backgroundImage = "none";
  node.textContent = "";
  const { asset, image } = agent ? characterImage(agent) : { asset: null, image: null };
  if (image) {
    const frames = Math.max(1, asset?.frames ?? 1);
    node.style.backgroundImage = `url("${image}")`;
    node.style.backgroundSize = `${frames * 100}% 100%`;
    node.style.backgroundPosition = "0% 50%";
    return;
  }
  node.textContent = agent?.emoji || "🤖";
}

function buildActor(agent) {
  const actor = el("div", "actor");
  actor.dataset.id = agent.id;
  actor.dataset.sprite = agent.sprite ?? "";
  actor.__target = { x: agent.x, y: agent.y };
  actor.setAttribute("role", "button");
  actor.setAttribute("tabindex", "0");
  actor.setAttribute("aria-label", `${agent.name} ตั้งค่า`);
  actor.style.left = `${agent.x}%`;
  actor.style.top = `${agent.y}%`;
  actor.style.setProperty("--actor-color", agent.color || "#6ee7b7");
  if (agent.id === state.agentId) actor.classList.add("focused");

  const bubble = el("div", "actor-bubble");
  const avatar = el("div", "actor-avatar");

  const { asset, image } = characterImage(agent);
  if (image) {
    const sprite = el("div", "actor-sprite");
    sprite.style.backgroundImage = `url("${image}")`;
    const frames = Math.max(1, asset?.frames ?? 1);
    if (frames > 1) {
      const fps = (asset?.fps || 6) > 0 ? asset.fps || 6 : 6;
      sprite.style.setProperty("--frames", String(frames));
      sprite.style.animation = `sprite-play ${Math.round((1000 / fps) * frames)}ms steps(${frames}, end) infinite`;
    }
    avatar.classList.add("sprite");
    avatar.append(sprite);
  } else {
    avatar.classList.add("emoji");
    avatar.textContent = agent.emoji || "🤖";
  }

  actor.append(bubble, avatar, el("div", "actor-name", agent.name));

  let drag = null;
  actor.addEventListener("pointerdown", (event) => {
    if (event.button != null && event.button !== 0) return;
    stopWalk(actor);
    drag = { x: event.clientX, y: event.clientY, moved: false };
    actor.classList.add("dragging");
    if (actor.setPointerCapture) actor.setPointerCapture(event.pointerId);
  });

  actor.addEventListener("pointermove", (event) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(event.clientX - drag.x) < 8 && Math.abs(event.clientY - drag.y) < 8) {
      return;
    }
    drag.moved = true;
    const rect = els.sceneFrame.getBoundingClientRect();
    const x = clamp(((event.clientX - rect.left) / rect.width) * 100, 2, 96);
    const y = clamp(((event.clientY - rect.top) / rect.height) * 100, 8, 94);
    actor.style.left = `${x}%`;
    actor.style.top = `${y}%`;
    actor.dataset.x = String(x);
    actor.dataset.y = String(y);
  });

  const finishDrag = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    actor.classList.remove("dragging");
    if (!moved) {
      openAgentSheet(agent.id);
      return;
    }
    const x = Number(actor.dataset.x ?? agent.x);
    const y = Number(actor.dataset.y ?? agent.y);
    agent.x = x;
    agent.y = y;
    send({ type: "office.move", id: agent.id, x, y });
  };
  actor.addEventListener("pointerup", finishDrag);
  actor.addEventListener("pointercancel", () => {
    drag = null;
    actor.classList.remove("dragging");
  });
  actor.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openAgentSheet(agent.id);
    }
  });

  return actor;
}

/**
 * Reuse the actor nodes between state broadcasts. Rebuilding them started every
 * character at its new spot, so a handoff looked like teleporting instead of
 * walking; keeping the node lets the CSS left/top transition play.
 */
function syncActors(list) {
  const frame = els.sceneFrame;
  const existing = new Map(
    [...frame.querySelectorAll(".actor")].map((node) => [node.dataset.id, node]),
  );

  for (const agent of list) {
    const current = existing.get(agent.id);
    if (!current) {
      frame.append(buildActor(agent));
      continue;
    }
    existing.delete(agent.id);
    if (current.dataset.sprite !== (agent.sprite ?? "")) {
      current.replaceWith(buildActor(agent));
      continue;
    }
    const spot = walkTarget(current, agent, list);
    current.style.setProperty("--actor-color", agent.color || "#6ee7b7");
    current.classList.toggle("focused", agent.id === state.agentId);
    current.setAttribute("aria-label", `${agent.name} ตั้งค่า`);
    const name = current.querySelector(".actor-name");
    if (name && name.textContent !== agent.name) name.textContent = agent.name;
    walkActor(current, spot.x, spot.y);
  }

  for (const node of existing.values()) node.remove();
}

const walks = new WeakMap();

/** Cancel a walk in progress so dragging stays direct. */
function stopWalk(actor) {
  const walk = walks.get(actor);
  if (!walk) return;
  if (walk.frame) cancelAnimationFrame(walk.frame);
  walks.delete(actor);
  actor.style.transform = "";
  actor.classList.remove("walking");
}

/**
 * Characters walk to their new spot instead of teleporting. Driven in JS rather
 * than a CSS transition, so it still moves where the OS asks for reduced motion.
 */
function walkActor(actor, x, y) {
  let walk = walks.get(actor);
  if (!walk) {
    walk = {
      x: Number.parseFloat(actor.style.left) || x,
      y: Number.parseFloat(actor.style.top) || y,
      frame: 0,
    };
    walks.set(actor, walk);
  }
  if (walk.frame) cancelAnimationFrame(walk.frame);
  const from = { x: walk.x, y: walk.y };
  const distance = Math.hypot(x - from.x, y - from.y);
  if (distance < 0.4) {
    walk.frame = 0;
    walk.x = x;
    walk.y = y;
    actor.style.left = `${x}%`;
    actor.style.top = `${y}%`;
    actor.style.transform = "";
    actor.classList.remove("walking");
    return;
  }
  // Long walks take longer, but never crawl.
  const duration = clamp(340 + distance * 32, 340, 1400);
  const started = performance.now();
  actor.classList.add("walking");
  const step = (now) => {
    const elapsed = now - started;
    const t = Math.min(1, elapsed / duration);
    const eased = t < 0.5 ? 2 * t * t : 1 - (1 - t) * (1 - t) * 2;
    walk.x = from.x + (x - from.x) * eased;
    walk.y = from.y + (y - from.y) * eased;
    actor.style.left = `${walk.x}%`;
    actor.style.top = `${walk.y}%`;
    // A step rhythm on top of the slide, so it reads as walking and not gliding.
    // Kept in JS because reduced-motion settings disable CSS keyframes.
    const bob = Math.sin(elapsed / 90) * 3.5;
    actor.style.transform = `translate(-50%, -50%) translateY(${bob.toFixed(2)}px)`;
    if (t < 1) {
      walk.frame = requestAnimationFrame(step);
      return;
    }
    walk.frame = 0;
    actor.style.transform = "";
    actor.classList.remove("walking");
  };
  walk.frame = requestAnimationFrame(step);
}

/**
 * A meeting pair can land on a third colleague standing nearby, so a character
 * that is moving dodges until its spot is clear of everyone else.
 */
function walkTarget(node, agent, list) {
  const previous = node.__target;
  if (previous && previous.x === agent.x && previous.y === agent.y) return previous;
  let { x, y } = agent;
  const others = list.filter((entry) => entry.id !== agent.id);
  for (let step = 0; step < 5; step += 1) {
    const clash = others.some(
      (entry) => Math.abs(entry.x - x) < 16 && Math.abs(entry.y - y) < 12,
    );
    if (!clash) break;
    const offset = (Math.floor(step / 2) + 1) * 8;
    y = clamp(y + (step % 2 === 0 ? offset : -offset), 8, 94);
  }
  const spot = { x, y };
  node.__target = spot;
  return spot;
}

function renderScenePicker() {
  els.scenePicker.innerHTML = "";
  for (const scene of state.office.scenes ?? []) {
    const chip = el("button", "chip", scene.name);
    chip.type = "button";
    if (scene.id === (state.scene ?? state.office.scenes[0]?.id)) chip.classList.add("active");
    chip.addEventListener("click", () => {
      state.scene = scene.id;
      renderOffice();
      send({ type: "office.scene", scene: scene.id });
    });
    els.scenePicker.append(chip);
  }
}

function renderAgentList() {
  els.agentList.innerHTML = "";
  if (state.agents.length === 0) {
    els.agentList.append(el("li", "muted", "ยังไม่มี agent"));
    return;
  }
  for (const agent of state.agents) {
    const li = el("li");
    if (agent.id === state.agentId) li.classList.add("active");
    const top = el("div", "agent-row");
    top.append(el("span", "agent-emoji", agent.emoji || "🤖"), el("span", null, agent.name));
    const meta = el("span", "meta", [agent.role, agent.model].filter(Boolean).join(" · ") || "โมเดลเริ่มต้น");
    li.append(top, meta);
    li.addEventListener("click", () => {
      closeDrawer();
      setView("chat");
      openSession(agentSessionId(agent.id), agent.model ?? undefined);
    });
    els.agentList.append(li);
  }
}

/* ---------- office chatter ---------- */

let talkTimer = 0;
let talkSide = false;

function hideTalk() {
  clearTimeout(talkTimer);
  talkTimer = 0;
  els.talkView.hidden = true;
}

/**
 * A line spoken between two characters, shown in the same plate as the chat but
 * docked at the top, with the speaker's portrait alternating sides.
 */
function showTalk(frame) {
  const from = findAgent(frame.from);
  const to = findAgent(frame.to);
  const fromName = from?.name ?? frame.fromName ?? frame.from ?? "agent";
  const toName = to?.name ?? frame.toName ?? frame.to ?? "agent";
  els.talkName.textContent = `${fromName} ⇢ ${toName}`;
  els.talkText.textContent = frame.text ?? "";
  paintPortrait(els.talkPortrait, from);
  // First line on the left like a usual dialogue box, then alternate.
  els.talkView.classList.toggle("side-right", talkSide);
  talkSide = !talkSide;
  els.talkView.hidden = false;
  clearTimeout(talkTimer);
  talkTimer = setTimeout(hideTalk, 9000);
}

/* ---------- activity bubbles ---------- */

function setActivity(agentId, patch) {
  if (!agentId) return;
  const current = state.activity.get(agentId) ?? { busy: false, text: "" };
  state.activity.set(agentId, { ...current, ...patch });
  paintActivity(agentId);
}

function paintActivity(agentId) {
  const actor = actorEl(agentId);
  if (!actor) return;
  const activity = state.activity.get(agentId) ?? { busy: false, text: "" };
  actor.classList.toggle("working", Boolean(activity.busy));
  const bubble = actor.querySelector(".actor-bubble");
  if (!bubble) return;
  bubble.textContent = activity.text ?? "";
  bubble.classList.toggle("show", Boolean(activity.text));
}

function paintAllActivity() {
  for (const agent of state.agents) paintActivity(agent.id);
}

/* ---------- agent sheet ---------- */

function formField(labelText, control) {
  const wrap = el("label", "field");
  wrap.append(el("span", null, labelText), control);
  return wrap;
}

function textInput(name, value, options = {}) {
  const input = document.createElement("input");
  input.type = options.type ?? "text";
  input.name = name;
  input.value = value ?? "";
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.maxLength) input.maxLength = options.maxLength;
  return input;
}

function textArea(name, value, placeholder) {
  const area = document.createElement("textarea");
  area.name = name;
  area.value = value ?? "";
  area.rows = 6;
  if (placeholder) area.placeholder = placeholder;
  return area;
}

function selectInput(name, value, options) {
  const select = document.createElement("select");
  select.name = name;
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    select.append(node);
  }
  select.value = value ?? "";
  return select;
}

function checklist(name, items, selected) {
  const wrap = el("div", "checklist");
  if (!items || items.length === 0) {
    wrap.append(el("span", "muted", "ยังไม่มีของติดตั้ง"));
    return wrap;
  }
  for (const item of items) {
    const label = el("label", "check");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.name = name;
    box.value = item;
    box.checked = selected == null ? true : selected.includes(item);
    label.append(box, el("span", null, item));
    wrap.append(label);
  }
  return wrap;
}

/**
 * Lets the operator choose the three real states instead of guessing what an
 * unchecked box means: every installed item, an explicit list, or none.
 */
function selectionField(labelText, name, items, selected) {
  const mode = selected == null ? "all" : selected.length === 0 ? "none" : "pick";
  const wrap = el("div", "selection");
  const modes = el("div", "tri");
  const list = checklist(name, items, selected);
  list.hidden = mode !== "pick";

  for (const [value, text] of [
    ["all", "ใช้ทั้งหมด"],
    ["pick", "เลือกเอง"],
    ["none", "ไม่ใช้"],
  ]) {
    const label = el("label", "tri-opt");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `${name}-mode`;
    radio.value = value;
    radio.checked = value === mode;
    radio.addEventListener("change", () => {
      list.hidden = value !== "pick";
    });
    label.append(radio, el("span", null, text));
    modes.append(label);
  }

  wrap.append(
    modes,
    el("p", "hint", "ใช้ทั้งหมด = รวมของที่ติดตั้งใหม่ภายหลัง · เลือกเอง = เฉพาะที่ติ๊ก · ไม่ใช้ = ปิดกลุ่มนี้ทั้งหมด"),
    list,
  );
  return formField(labelText, wrap);
}

function openAgentSheet(id) {
  const agent = id ? findAgent(id) : null;
  state.sheetAgentId = agent?.id ?? null;
  state.creating = !agent;

  els.agentSheetTitle.textContent = agent ? `ตั้งค่า · ${agent.name}` : "สร้าง Agent ใหม่";
  els.agentError.textContent = "";
  renderAgentForm(agent);
  els.agentChat.hidden = !agent;
  els.agentReset.hidden = !agent;
  els.agentDelete.hidden = !agent;

  els.agentSheet.classList.add("open");
  els.agentSheet.setAttribute("aria-hidden", "false");
  closeDrawer();
}

function renderAgentForm(agent) {
  els.agentForm.innerHTML = "";
  const form = el("div", "form");

  const nameRow = el("div", "row");
  nameRow.append(formField("ชื่อ", textInput("agent-name", agent?.name ?? "", { placeholder: "เช่น Nova", maxLength: 40 })));
  const emojiWrap = formField("อีโมจิ", textInput("agent-emoji", agent?.emoji ?? "🤖", { maxLength: 4 }));
  emojiWrap.classList.add("narrow");
  nameRow.append(emojiWrap);
  form.append(nameRow);

  form.append(
    formField("บทบาท", textInput("agent-role", agent?.role ?? "", { placeholder: "เช่น นักเขียนคอนเทนต์" })),
  );

  const modelOptions = [
    { value: "", label: "ตามค่าเริ่มต้นของระบบ" },
    ...state.models.map((model) => ({ value: model.ref, label: model.ref })),
  ];
  form.append(formField("โมเดล", selectInput("agent-model", agent?.model ?? "", modelOptions)));

  const styleRow = el("div", "row");
  const colorWrap = formField("สี", textInput("agent-color", agent?.color ?? "#6ee7b7", { type: "color" }));
  colorWrap.classList.add("narrow");
  const characterOptions = [
    { value: "", label: "อีโมจิ" },
    ...(state.office.characters ?? []).map((entry) => ({ value: entry.id, label: entry.name })),
  ];
  styleRow.append(colorWrap, formField("ตัวละคร", selectInput("agent-sprite", agent?.sprite ?? "", characterOptions)));
  form.append(styleRow);

  form.append(
    formField(
      "ตัวตน / บุคลิก (identity)",
      textArea("agent-identity", agent?.identity ?? "", "เขียนบุคลิก วิธีพูด และสิ่งที่ห้ามทำ"),
    ),
  );

  form.append(selectionField("Skills", "agent-skill", state.extensions.skills ?? [], agent ? agent.skills : null));
  form.append(
    selectionField("Plugins", "agent-plugin", state.extensions.plugins ?? [], agent ? agent.plugins : null),
  );
  form.append(selectionField("MCP", "agent-mcp", state.extensions.mcp ?? [], agent ? agent.mcp : null));

  els.agentForm.append(form);
}

function readAgentForm() {
  const val = (name) => els.agentForm.querySelector(`[name="${name}"]`)?.value ?? "";
  const checked = (name) =>
    [...els.agentForm.querySelectorAll(`input[name="${name}"]:checked`)].map((node) => node.value);

  // null = every installed item (including future installs), [] = this kind off.
  const selection = (key) => {
    const mode = els.agentForm.querySelector(`input[name="agent-${key}-mode"]:checked`)?.value ?? "all";
    if (mode === "all") return null;
    if (mode === "none") return [];
    return checked(`agent-${key}`);
  };

  return {
    name: val("agent-name").trim(),
    emoji: val("agent-emoji").trim(),
    role: val("agent-role").trim(),
    model: val("agent-model") || null,
    color: val("agent-color") || null,
    sprite: val("agent-sprite") || null,
    identity: val("agent-identity"),
    skills: selection("skill"),
    plugins: selection("plugin"),
    mcp: selection("mcp"),
  };
}

function saveAgent() {
  const payload = readAgentForm();
  if (!payload.name) {
    els.agentError.textContent = "ใส่ชื่อ agent ก่อน";
    return;
  }
  if (state.creating) {
    send({ type: "agent.create", ...payload });
    toast("สร้าง agent แล้ว");
  } else {
    send({ type: "agent.update", id: state.sheetAgentId, ...payload });
    toast("บันทึกแล้ว");
  }
  closeAgentSheet();
}

/* ---------- models / sessions ---------- */

function renderModels(models, defaultRef) {
  state.models = models;
  state.defaultModel = defaultRef ?? state.defaultModel;
  if (!state.currentModel) setModelChip(defaultRef);
  els.modelBtn.disabled = models.length === 0;
  if (els.modelSheet.classList.contains("open")) renderModelOptions();
}

function renderModelOptions() {
  const defaultRef = state.models.find((model) => model.default)?.ref ?? state.defaultModel;
  const current = state.currentModel;
  els.modelOptions.innerHTML = "";
  for (const model of state.models) {
    const button = el("button", "model-option");
    button.type = "button";
    if (model.ref === current) button.classList.add("selected");

    const info = el("div");
    info.append(el("div", "ref", model.ref));
    info.append(el("div", "sub", `${model.providerLabel}${model.ref === defaultRef ? " · default" : ""}`));

    const check = el("span", "check", model.ref === current ? "✓" : "");
    button.append(info, check);
    button.addEventListener("click", () => {
      if (state.sessionId) {
        send({
          type: "model.set",
          sessionId: state.sessionId,
          model: model.ref,
          agentId: state.agentId ?? undefined,
        });
      }
      setModelChip(model.ref);
      storage.set(MODEL_KEY, model.ref);
      closeModelSheet();
    });
    els.modelOptions.append(button);
  }
}

function renderSessions(sessions) {
  els.sessionList.innerHTML = "";
  const mine = sessions.filter((session) => session.id.startsWith("board:"));
  const others = sessions.filter((session) => !session.id.startsWith("board:"));

  for (const session of [...mine, ...others]) {
    const li = el("li");
    if (session.id === state.sessionId) li.classList.add("active");

    const agent = findAgent(sessionAgentId(session.id));
    li.append(
      el("span", null, agent ? `${agent.emoji || "🤖"} ${agent.name}` : session.title || session.id.replace(/^board:/, "").slice(0, 12)),
    );
    li.append(
      el("span", "meta", `${session.channel} · ${session.model} · ${session.messages} msg`),
    );
    li.addEventListener("click", () => {
      setView("chat");
      openSession(session.id, session.model);
      closeDrawer();
    });
    els.sessionList.append(li);
  }
}

function openSession(sessionId, model) {
  state.sessionId = sessionId;
  state.agentId = sessionAgentId(sessionId);
  storage.set(SESSION_KEY, sessionId);
  els.messages.innerHTML = "";
  state.toolChips.clear();
  stopTyping();
  setBusy(false);
  if (model) setModelChip(model);
  const agent = findAgent(state.agentId);
  setChatHeader(agent ? agent.name : "แชท", "loading…");
  send({ type: "session.history", sessionId });
  renderAgentList();
  renderOffice();
}

/* ---------- websocket ---------- */

function connect(token) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`;
  setStatus("", "connecting…");

  let socket;
  try {
    socket = new WebSocket(url);
  } catch {
    setStatus("offline", "invalid gateway url");
    return;
  }
  state.ws = socket;

  socket.addEventListener("open", () => {
    state.retries = 0;
    setStatus("online", "gateway online");
    clearInterval(state.pingTimer);
    state.pingTimer = setInterval(() => {
      if (state.ws?.readyState === WebSocket.OPEN) send({ type: "ping" });
    }, 30000);
  });

  socket.addEventListener("message", (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    handleFrame(frame);
  });

  socket.addEventListener("close", (event) => {
    setStatus("offline", "disconnected");
    setBusy(false);
    clearInterval(state.pingTimer);
    if (event.code === 1008 || event.code === 4401) {
      showLogin("Gateway rejected the token.");
      return;
    }
    if (state.token && state.retries < 6) {
      state.retries += 1;
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(() => connect(state.token), 1200 * state.retries);
    }
  });

  socket.addEventListener("error", () => {
    setStatus("offline", "connection error");
  });
}

function send(frame) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify(frame));
}

function applyAgentState(frame) {
  if (Array.isArray(frame.agents)) state.agents = frame.agents;
  if ("scene" in frame) state.scene = frame.scene ?? null;
  if (frame.office && Array.isArray(frame.office.scenes)) state.office = frame.office;
  if (frame.extensions) state.extensions = frame.extensions;

  if (state.scene == null && (state.office.scenes ?? []).length > 0) {
    state.scene = state.office.scenes[0].id;
  }
  if (state.agentId && !findAgent(state.agentId)) state.agentId = null;
  if (!state.agentId && state.view === "office" && state.agents[0]) state.agentId = state.agents[0].id;
  if (state.sheetAgentId && !findAgent(state.sheetAgentId) && !state.creating) closeAgentSheet();

  renderOffice();
}

function handleFrame(frame) {
  switch (frame.type) {
    case "ready": {
      els.login.hidden = true;
      state.tools = frame.tools ?? [];
      els.toolList.textContent = `tools: ${state.tools.join(", ") || "none"}`;
      if (frame.extensions) state.extensions = frame.extensions;
      state.extensionWrites = frame.extensionWrites ?? state.extensionWrites;
      renderExtensions(frame.diagnostics ?? []);
      renderApprovals(frame.approvals ?? []);
      renderModels(frame.models ?? [], frame.defaultModel ?? null);

      const profiles = frame.agents ?? [];
      if (!state.sessionId) {
        const saved = storage.get(SESSION_KEY);
        if (saved) state.sessionId = saved;
        else if (profiles[0]) state.sessionId = agentSessionId(profiles[0].id);
        else state.sessionId = newSessionId();
        state.agentId = sessionAgentId(state.sessionId);
      }
      applyAgentState({ agents: profiles, scene: frame.scene ?? null, office: frame.office ?? null });

      const agent = findAgent(state.agentId);
      setChatHeader(agent ? agent.name : "แชท", "loading…");
      send({ type: "sessions.list" });
      send({ type: "session.history", sessionId: state.sessionId });
      send({ type: "approvals.list" });
      break;
    }

    case "approvals.state":
      state.extensionWrites = frame.writes ?? state.extensionWrites;
      renderExtensions(frame.diagnostics ?? []);
      renderApprovals(frame.requests ?? []);
      break;

    case "approval.result":
      toast(frame.message ?? (frame.ok ? "อนุมัติแล้ว" : "ไม่สำเร็จ"));
      send({ type: "approvals.list" });
      if (frame.ok) send({ type: "agents.list" });
      break;

    case "agents.state":
      applyAgentState(frame);
      break;

    case "office.talk": {
      // One character handed work to another: the line is spoken in the plate at
      // the top of the screen while both walk to meet.
      const from = findAgent(frame.from);
      const to = findAgent(frame.to);
      showTalk(frame);
      setActivity(frame.from, { busy: true, text: `⇢ ${to?.name ?? frame.toName ?? frame.to}` });
      setActivity(frame.to, {
        busy: true,
        text: `… ${from?.name ?? frame.fromName ?? frame.from}`,
      });
      break;
    }

    case "models.list":
      renderModels(frame.models ?? [], frame.default ?? null);
      break;

    case "sessions.list":
      renderSessions(frame.sessions ?? []);
      break;

    case "session.history": {
      if (frame.sessionId !== state.sessionId) return;
      els.messages.innerHTML = "";
      state.toolChips.clear();
      const visible = (frame.messages ?? []).filter((message) => typeof message.content === "string");
      for (const message of visible) addBubble(message.role, message.content);
      if (frame.model) setModelChip(frame.model);
      const agent = findAgent(sessionAgentId(frame.sessionId));
      setChatHeader(agent ? agent.name : "แชท", null);
      updateMeta({ messages: visible, model: frame.model ?? "" });
      scrollToBottom(true);
      break;
    }

    case "model.set":
      setModelChip(frame.model);
      storage.set(MODEL_KEY, frame.model);
      setChatMeta(`model: ${frame.model}`);
      break;

    case "session.reset":
      els.messages.innerHTML = "";
      state.toolChips.clear();
      setChatMeta("ยังไม่มีข้อความ");
      break;

    case "event":
      handleAgentEvent(frame.event);
      break;

    case "error":
      if (els.agentSheet.classList.contains("open")) els.agentError.textContent = frame.message ?? "gateway error";
      else {
        toast(frame.message ?? "gateway error");
        if (state.view === "chat") addBubble("error", frame.message ?? "gateway error");
      }
      setBusy(false);
      break;

    default:
      break;
  }
}

function handleAgentEvent(event) {
  const agentOfSession = sessionAgentId(event.sessionId);
  const isCurrent = event.sessionId === state.sessionId;

  switch (event.type) {
    case "turn.start":
      if (agentOfSession) setActivity(agentOfSession, { busy: true, text: "กำลังคิด…" });
      if (isCurrent) {
        setBusy(true);
        showTyping();
      }
      break;
    case "tool.start":
      if (agentOfSession) setActivity(agentOfSession, { busy: true, text: `⚙ ${event.name}` });
      if (isCurrent) addToolChip(event.callId, event.name, event.args, "running");
      break;
    case "tool.result":
      if (isCurrent) finishToolChip(event);
      if (agentOfSession) setActivity(agentOfSession, { busy: true, text: `${event.ok ? "✓" : "✗"} ${event.name}` });
      break;
    case "assistant.message":
      if (agentOfSession) setActivity(agentOfSession, { busy: true, text: short(event.text, 64) });
      if (isCurrent) addBubble("assistant", event.text);
      break;
    case "error":
      if (agentOfSession) setActivity(agentOfSession, { busy: false, text: "⚠ ผิดพลาด" });
      if (isCurrent) addBubble("error", event.message);
      break;
    case "turn.end":
      if (agentOfSession) setActivity(agentOfSession, { busy: false, text: "" });
      if (isCurrent) setBusy(false);
      send({ type: "sessions.list" });
      // The agent may have queued an extension change during this turn.
      send({ type: "approvals.list" });
      break;
    default:
      break;
  }
}

/* ---------- login ---------- */

function showLogin(error) {
  closeDrawer();
  els.login.hidden = false;
  els.loginError.textContent = error ?? "";
  els.tokenInput.focus();
}

els.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = els.tokenInput.value.trim();
  if (!token) {
    els.loginError.textContent = "Enter the gateway token.";
    return;
  }
  state.token = token;
  storage.set(TOKEN_KEY, token);
  els.loginError.textContent = "";
  connect(token);
});

/* ---------- interaction ---------- */

els.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.input.value.trim();
  if (!text || state.busy) return;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    addBubble("error", "Gateway is not connected.");
    return;
  }
  addBubble("user", text);
  send({ type: "chat.send", sessionId: state.sessionId, agentId: state.agentId ?? undefined, text });
  els.input.value = "";
  els.input.style.height = "auto";
  setBusy(true);
  showTyping();
});

els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});

els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
});

els.talkClose.addEventListener("click", hideTalk);
els.menu.addEventListener("click", openDrawer);
els.drawerClose.addEventListener("click", closeDrawer);
els.drawerPin?.addEventListener("click", () => setDrawerPinned(!drawerIsPinned()));
try {
  setDrawerPinned(localStorage.getItem(PIN_KEY) !== "0");
} catch {
  setDrawerPinned(true);
}
els.scrim.addEventListener("click", closeDrawer);
els.modelBtn.addEventListener("click", openModelSheet);
els.sheetClose.addEventListener("click", closeModelSheet);
els.agentSheetClose.addEventListener("click", closeAgentSheet);
els.viewToggle.addEventListener("click", () => setView(state.view === "office" ? "chat" : "office"));

els.newAgent.addEventListener("click", () => openAgentSheet(null));
els.addAgent.addEventListener("click", () => openAgentSheet(null));
els.agentSave.addEventListener("click", saveAgent);
els.approvalsBtn.addEventListener("click", openApprovalSheet);
els.approvalSheetClose.addEventListener("click", closeApprovalSheet);

els.agentChat.addEventListener("click", () => {
  const agent = findAgent(state.sheetAgentId);
  if (!agent) return;
  closeAgentSheet();
  setView("chat");
  openSession(agentSessionId(agent.id), agent.model ?? undefined);
});

els.agentReset.addEventListener("click", () => {
  const agent = findAgent(state.sheetAgentId);
  if (!agent) return;
  send({ type: "session.reset", sessionId: agentSessionId(agent.id) });
  toast(`ล้างประวัติของ ${agent.name} แล้ว`);
});

els.agentDelete.addEventListener("click", () => {
  const agent = findAgent(state.sheetAgentId);
  if (!agent) return;
  if (!window.confirm(`ลบ ${agent.name} ออกจากออฟฟิศ?`)) return;
  send({ type: "agent.delete", id: agent.id });
  toast(`ลบ ${agent.name} แล้ว`);
  closeAgentSheet();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeDrawer();
  closeModelSheet();
  closeAgentSheet();
  closeApprovalSheet();
});

/* ---------- app lifecycle ---------- */

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!state.token) return;
  if (!state.ws || state.ws.readyState === WebSocket.CLOSED) {
    state.retries = 0;
    connect(state.token);
  }
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installEvent = event;
  els.install.hidden = false;
});

els.install.addEventListener("click", async () => {
  const prompt = state.installEvent;
  if (!prompt) return;
  prompt.prompt();
  await prompt.userChoice.catch(() => undefined);
  state.installEvent = null;
  els.install.hidden = true;
  closeDrawer();
});

window.addEventListener("resize", layoutSceneFrame);
window.addEventListener("orientationchange", layoutSceneFrame);

if (window.matchMedia("(display-mode: standalone)").matches) {
  els.install.hidden = true;
}

if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

/* ---------- boot ---------- */

const params = new URLSearchParams(location.search);
const urlToken = params.get("token");
if (urlToken) {
  storage.set(TOKEN_KEY, urlToken);
  params.delete("token");
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}`);
}

setView("office");

const savedToken = storage.get(TOKEN_KEY);
if (savedToken) {
  state.token = savedToken;
  connect(savedToken);
} else {
  showLogin();
}
