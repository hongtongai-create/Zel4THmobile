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
  chatMic: document.getElementById("chat-mic"),
  chatSpeak: document.getElementById("chat-speak"),
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
  chatAlpha: document.getElementById("chat-alpha"),
  chatClose: document.getElementById("chat-close"),
  talkAlpha: document.getElementById("talk-alpha"),
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
  targetsBtn: document.getElementById("targets-btn"),
  studioBtn: document.getElementById("studio-btn"),
  studioSheet: document.getElementById("studio-sheet"),
  studioClose: document.getElementById("studio-close"),
  studioForm: document.getElementById("studio-form"),
  targetsSheet: document.getElementById("targets-sheet"),
  targetsSheetClose: document.getElementById("targets-sheet-close"),
  targetsList: document.getElementById("targets-list"),
  targetsForm: document.getElementById("targets-form"),
  targetSave: document.getElementById("target-save"),
  targetNew: document.getElementById("target-new"),
  targetError: document.getElementById("target-error"),
  toast: document.getElementById("toast"),
};

const ALPHA_KEY = "clawgate.dlgAlpha";
/** Opacity of the dialogue plates: default, then more see-through, then solid. */
const ALPHA_STEPS = [80, 62, 92];
const SESSION_KEY = "clawgate.session";
const TOKEN_KEY = "clawgate.token";
const MODEL_KEY = "clawgate.model";
const AGENT_PREFIX = "board:agent:";
/** Signature of the installed machine tools, so the agent sheet refreshes only on real changes. */
let lastPluginToolsSig = "";
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
  ui: { theme: { accent: "#6ee7b7" }, sizes: { character: 1, text: 15 }, props: [] },
  targets: [],
  targetsReady: true,
  editingTarget: null,
  activeTargetPlugin: null,
  probeResults: new Map(),
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
  const label = agent?.name ?? "Zel4THmobile";
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

/* ---------- voice: speech to speech ---------- */

const SPEAK_KEY = "clawgate.voiceSpeak";
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;

const voice = {
  speak: storage.get(SPEAK_KEY) === "1",
  listening: false,
  recognition: null,
  last: "",
};

/** Prefers a Thai system voice, then any voice the device offers. */
function pickVoice() {
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  const thai = voices.filter((entry) => /^th/i.test(entry.lang));
  return thai[0] ?? voices.find((entry) => /^en/i.test(entry.lang)) ?? null;
}

function updateVoiceChrome() {
  const on = voice.speak && "speechSynthesis" in window;
  els.chatSpeak?.classList.toggle("on", on);
  els.chatSpeak?.setAttribute("aria-pressed", on ? "true" : "false");
  if (els.chatSpeak) els.chatSpeak.hidden = !("speechSynthesis" in window);
}

/** Reads an agent reply aloud, dropping code blocks and markdown noise. */
function speak(text) {
  if (!voice.speak || !("speechSynthesis" in window)) return;
  const clean = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  if (!clean) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(clean);
  const chosen = pickVoice();
  if (chosen) {
    utterance.voice = chosen;
    utterance.lang = chosen.lang;
  }
  utterance.rate = 1.05;
  window.speechSynthesis.speak(utterance);
}

function stopSpeaking() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

/** Mic button: listen, put the transcript in the composer, then send it. */
function toggleListening() {
  if (!Recognition) {
    toast("เบราว์เซอร์นี้ไม่รองรับการฟังเสียง ลองใช้ Chrome หรือ Safari เวอร์ชันใหม่");
    return;
  }
  if (voice.listening) {
    voice.recognition?.stop();
    return;
  }
  stopSpeaking();
  const recognition = new Recognition();
  recognition.lang = /^th/i.test(document.documentElement.lang || "") ? "th-TH" : navigator.language || "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  let finalText = "";
  recognition.onresult = (event) => {
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    els.input.value = (finalText || interim).trim();
  };
  recognition.onerror = (event) => {
    if (event.error === "aborted") return;
    toast(event.error === "not-allowed" ? "ไม่ได้รับอนุญาตให้ใช้ไมโครโฟน" : `ฟังเสียงไม่สำเร็จ: ${event.error}`);
  };
  recognition.onend = () => {
    voice.listening = false;
    voice.recognition = null;
    els.chatMic?.classList.remove("listening");
    const text = els.input.value.trim();
    if (text && !state.busy) els.composer.requestSubmit();
  };

  voice.recognition = recognition;
  voice.listening = true;
  els.chatMic?.classList.add("listening");
  try {
    recognition.start();
  } catch {
    voice.listening = false;
    els.chatMic?.classList.remove("listening");
  }
}

function initVoice() {
  updateVoiceChrome();
  if (els.chatMic) els.chatMic.hidden = !Recognition;
  els.chatMic?.addEventListener("click", toggleListening);
  els.chatSpeak?.addEventListener("click", () => {
    voice.speak = !voice.speak;
    storage.set(SPEAK_KEY, voice.speak ? "1" : "0");
    updateVoiceChrome();
    if (voice.speak && voice.last) speak(voice.last);
    else stopSpeaking();
  });
  // Voice lists load asynchronously on some browsers.
  if ("speechSynthesis" in window) window.speechSynthesis.addEventListener?.("voiceschanged", updateVoiceChrome);
}

function addBubble(role, text, options = {}) {
  hideEmpty();
  const div = el("div", `msg ${role}`, text);
  els.messages.append(div);
  scrollToBottom(role === "user");
  if (role === "assistant") {
    voice.last = String(text ?? "");
    // Replayed history is silent; only fresh replies are spoken.
    if (options.speak !== false) speak(text);
  }
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

/* ---------- dialogue opacity ---------- */

let alphaIndex = 0;

/** Both plates share one --dlg-alpha, so they always see through alike. */
function applyDialogAlpha(percent) {
  document.documentElement.style.setProperty("--dlg-alpha", `${percent}%`);
  const transparency = `${100 - percent}%`;
  for (const button of [els.chatAlpha, els.talkAlpha]) {
    if (!button) continue;
    button.dataset.alpha = String(percent);
    button.title = `โปร่งแสง ${transparency} — กดเพื่อสลับ`;
    button.setAttribute("aria-label", `โปร่งแสง ${transparency}`);
  }
}

function cycleDialogAlpha() {
  alphaIndex = (alphaIndex + 1) % ALPHA_STEPS.length;
  const percent = ALPHA_STEPS[alphaIndex];
  applyDialogAlpha(percent);
  storage.set(ALPHA_KEY, String(percent));
  toast(`หน้าต่างโปร่งแสง ${100 - percent}%`);
}

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
  const scale = state.ui?.sizes?.character ?? 1;
  const actorSize = Math.round(clamp(Math.min(w, h) * 0.19, 104, 160) * scale);
  document.documentElement.style.setProperty("--actor-size", `${actorSize}px`);
  const propSize = Math.round(clamp(Math.min(w, h) * 0.16, 60, 150));
  document.documentElement.style.setProperty("--prop-size", `${propSize}px`);
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

/* ---------- studio: theme, sizes and stage props ---------- */

/** Applies the shared office UI (accent, text size, character size, props). */
function applyUi() {
  const ui = state.ui ?? {};
  const root = document.documentElement.style;
  const accent = ui.theme?.accent ?? "#6ee7b7";
  root.setProperty("--accent", accent);
  root.setProperty("--chat-font", `${ui.sizes?.text ?? 15}px`);
  renderProps();
  layoutSceneFrame();
}

const isModelFile = (image) => /\.glb$/i.test(image ?? "");

let model3dPromise = null;
/** three.js only loads when a .glb prop is actually on the stage. */
function loadModel3d() {
  model3dPromise ??= import("/model3d.js");
  return model3dPromise;
}

async function mountProp(host, url) {
  try {
    const { mountModel } = await loadModel3d();
    if (host.isConnected) mountModel(host, url);
  } catch {
    host.dataset.state = "error";
  }
}

async function unmountProp(host) {
  try {
    const { unmountModel } = await loadModel3d();
    unmountModel(host);
  } catch {
    /* the module never loaded, so there is nothing to release */
  }
}

/**
 * Props sit between the scene art and the characters, positioned in percent.
 * Nodes are reconciled by id so a WebGL viewer is created once, not on every
 * settings change.
 */
function renderProps() {
  const frame = els.sceneFrame;
  if (!frame) return;
  let layer = frame.querySelector(".prop-layer");
  if (!layer) {
    layer = el("div", "prop-layer");
    frame.prepend(layer);
  }
  const props = (state.ui?.props ?? []).filter((prop) => prop?.image);
  const wanted = new Set(props.map((prop) => prop.id));

  for (const node of [...layer.children]) {
    if (wanted.has(node.dataset.id)) continue;
    if (node.dataset.kind === "model") void unmountProp(node);
    node.remove();
  }

  for (const prop of props) {
    const model = isModelFile(prop.image);
    let node = layer.querySelector(`[data-id="${CSS.escape(prop.id)}"]`);
    if (node && (node.dataset.kind === "model") !== model) {
      if (node.dataset.kind === "model") void unmountProp(node);
      node.remove();
      node = null;
    }
    if (!node) {
      node = el(model ? "div" : "img", model ? "prop prop-model" : "prop");
      node.dataset.id = prop.id;
      node.dataset.kind = model ? "model" : "image";
      if (!model) node.alt = prop.name ?? "";
      layer.append(node);
      if (model) void mountProp(node, prop.image);
    }
    if (!model) node.src = prop.image;
    const width = Math.round(140 * (prop.scale ?? 1));
    node.style.left = `${prop.x}%`;
    node.style.top = `${prop.y}%`;
    node.style.width = `${width}px`;
    if (model) node.style.height = `${Math.round(width * 1.35)}px`;
  }
}

function studioNumber(label, value, min, max, step, onInput) {
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => onInput(Number(input.value)));
  return formField(`${label} · ${value}`, input);
}

function studioUpload(label, kind) {
  const wrap = el("div", "field");
  wrap.append(el("span", null, label));
  const input = document.createElement("input");
  input.type = "file";
  input.accept = kind === "props" ? "image/*,.glb" : "image/*";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    void uploadAsset(kind, file);
    input.value = "";
  });
  wrap.append(input);
  return wrap;
}

async function uploadAsset(kind, file) {
  const url = `/api/assets?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(file.name)}&token=${encodeURIComponent(state.token ?? "")}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `อัปโหลดไม่สำเร็จ (${response.status})`);
    if (kind === "props") {
      pushProp(result.image, file.name);
    } else {
      toast(`อัปโหลด ${file.name} แล้ว`);
    }
  } catch (error) {
    toast(`อัปโหลดไม่สำเร็จ: ${error.message}`);
  }
}

function pushProp(image, name) {
  const props = [...(state.ui.props ?? [])];
  props.push({ id: `prop-${Date.now().toString(36)}`, name: name.replace(/\.[^.]+$/, ""), image, x: 50, y: 85, scale: 1 });
  saveUi({ ...state.ui, props });
}

function saveUi(next) {
  state.ui = next;
  applyUi();
  send({ type: "ui.update", ui: next });
}

function renderStudio() {
  if (!els.studioForm) return;
  els.studioForm.innerHTML = "";
  const ui = state.ui;
  // Each control edits the LIVE settings, never the snapshot taken when the form
  // was drawn, so moving two sliders in a row keeps both changes.
  const patch = (build) => saveUi(build(state.ui));

  const uploads = el("div", "field");
  uploads.append(el("span", null, "อัปโหลด (ได้ผลทันที)"));
  uploads.append(
    studioUpload("ฉากหลังใหม่ (jpg/png/webp)", "scenes"),
    studioUpload("ตัวละครใหม่ (sprite sheet ก็ได้)", "characters"),
    studioUpload("เฟอนิเจอร์ / ของตกแต่ง (png โปร่งใส หรือ .glb)", "props"),
  );
  els.studioForm.append(uploads);

  els.studioForm.append(
    studioNumber("ขนาดตัวละคร", ui.sizes.character, 0.5, 2, 0.05, (value) =>
      patch((cur) => ({ ...cur, sizes: { ...cur.sizes, character: value } })),
    ),
  );
  els.studioForm.append(
    studioNumber("ขนาดตัวอักษรแชท (px)", ui.sizes.text, 11, 22, 1, (value) =>
      patch((cur) => ({ ...cur, sizes: { ...cur.sizes, text: value } })),
    ),
  );

  const accent = document.createElement("input");
  accent.type = "color";
  accent.value = ui.theme.accent;
  accent.addEventListener("input", () =>
    patch((cur) => ({ ...cur, theme: { ...cur.theme, accent: accent.value } })),
  );
  els.studioForm.append(formField("สีเน้น (accent)", accent));

  // Sheets uploaded through the studio arrive with one frame, so the walk cycle
  // is set here instead of by editing office.json.
  const characters = state.office.characters ?? [];
  if (characters.length > 0) {
    const section = el("div", "field");
    section.append(el("span", null, "เฟรมการเดินของตัวละคร (จำนวนเฟรมในไฟล์ + fps)"));
    for (const character of characters) {
      const anim = state.ui.characters?.[character.id] ?? {
        frames: character.frames ?? 1,
        fps: character.fps ?? 0,
      };
      const row = el("div", "prop-row");
      row.append(el("span", "prop-name", character.name || character.id));
      const framesInput = document.createElement("input");
      framesInput.type = "number";
      framesInput.min = "1";
      framesInput.max = "16";
      framesInput.value = String(anim.frames);
      const fpsInput = document.createElement("input");
      fpsInput.type = "number";
      fpsInput.min = "0";
      fpsInput.max = "24";
      fpsInput.value = String(anim.fps);
      const apply = () =>
        patch((cur) => ({
          ...cur,
          characters: {
            ...cur.characters,
            [character.id]: {
              frames: Math.max(1, Math.min(16, Number(framesInput.value) || 1)),
              fps: Math.max(0, Math.min(24, Number(fpsInput.value) || 0)),
            },
          },
        }));
      framesInput.addEventListener("change", apply);
      fpsInput.addEventListener("change", apply);
      row.append(formField("เฟรม", framesInput), formField("fps", fpsInput));
      section.append(row);
    }
    els.studioForm.append(section);
  }

  if ((ui.props ?? []).length > 0) {
    const list = el("div", "field");
    list.append(el("span", null, "ของตกแต่งบนฉาก"));
    for (const prop of ui.props) {
      const row = el("div", "prop-row");
      row.append(el("span", "prop-name", prop.name || prop.id));
      row.append(
        studioNumber("x", prop.x, 0, 100, 1, (value) => updateProp(prop.id, { x: value })),
        studioNumber("y", prop.y, 0, 100, 1, (value) => updateProp(prop.id, { y: value })),
        studioNumber("ขนาด", prop.scale, 0.2, 3, 0.05, (value) => updateProp(prop.id, { scale: value })),
      );
      const remove = el("button", "ghost", "ลบ");
      remove.type = "button";
      remove.addEventListener("click", () => {
        patch((cur) => ({ ...cur, props: cur.props.filter((entry) => entry.id !== prop.id) }));
        renderStudio();
      });
      row.append(remove);
      list.append(row);
    }
    els.studioForm.append(list);
  }
}

function updateProp(id, patch) {
  const props = state.ui.props.map((prop) => (prop.id === id ? { ...prop, ...patch } : prop));
  saveUi({ ...state.ui, props });
}

function openStudio() {
  closeDrawer();
  els.studioSheet.classList.add("open");
  els.studioSheet.setAttribute("aria-hidden", "false");
  send({ type: "ui.get" });
  renderStudio();
}

function closeStudio() {
  els.studioSheet.classList.remove("open");
  els.studioSheet.setAttribute("aria-hidden", "true");
}

function renderOffice() {
  const scenes = state.office.scenes ?? [];
  const scene = scenes.find((entry) => entry.id === state.scene) ?? scenes[0] ?? null;
  applyScene(scene);
  renderProps();

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

/** Frame count + fps of the sheet an agent renders with, for change detection. */
function animSignature(agent) {
  const { asset } = characterImage(agent);
  return `${asset?.frames ?? 1}:${asset?.fps ?? 0}`;
}

function buildActor(agent) {
  const actor = el("div", "actor");
  actor.dataset.id = agent.id;
  actor.dataset.sprite = agent.sprite ?? "";
  actor.dataset.anim = animSignature(agent);
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
    // The sheet only plays while the character walks; standing still shows the
    // first frame instead of flickering through every pose.
    const frames = Math.max(1, asset?.frames ?? 1);
    sprite.style.setProperty("--frames", String(frames));
    sprite.dataset.frames = String(frames);
    sprite.dataset.fps = String(asset?.fps ?? 0);
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
    if (
      current.dataset.sprite !== (agent.sprite ?? "") ||
      current.dataset.anim !== animSignature(agent)
    ) {
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

/** Runs or stops the walk cycle on one character's sprite sheet. */
function setWalkAnim(actor, on) {
  const sprite = actor.querySelector(".actor-sprite");
  if (!sprite) return;
  const frames = Number(sprite.dataset.frames || 1);
  const fps = Number(sprite.dataset.fps || 0);
  if (!on || frames <= 1 || fps <= 0) {
    sprite.style.animation = "";
    return;
  }
  sprite.style.animation = `sprite-play ${Math.round((1000 / fps) * frames)}ms steps(${frames}, end) infinite`;
}

/** Cancel a walk in progress so dragging stays direct. */
function stopWalk(actor) {
  const walk = walks.get(actor);
  if (!walk) return;
  if (walk.frame) cancelAnimationFrame(walk.frame);
  walks.delete(actor);
  actor.style.transform = "";
  setWalkAnim(actor, false);
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
  // Face the way it is going: -1 walks left, 1 walks right.
  actor.style.setProperty("--face", x < from.x ? "-1" : "1");
  setWalkAnim(actor, true);
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
    setWalkAnim(actor, false);
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

/**
 * Per-tool bans inside plugins the agent may use: "you can reach the phone,
 * but never write a file there". Enforced at invoke time by the gateway.
 */
/**
 * Fills the allow list from the machines that are installed right now. `decide`
 * answers "may this agent call that tool?", so the first render can use the deny
 * list and a refresh can keep whatever the operator has already ticked.
 */
function fillAllowList(wrap, decide) {
  wrap.innerHTML = "";
  const entries = Object.entries(state.extensions.pluginTools ?? {}).filter(
    ([, tools]) => Array.isArray(tools) && tools.length > 0,
  );
  if (entries.length === 0) {
    wrap.append(el("p", "hint", "ยังไม่มีเครื่องที่ติดตั้งไว้ — กดเพิ่มเครื่องด้านล่างได้เลย"));
    return;
  }

  for (const [plugin, tools] of entries) {
    const group = el("div", "deny-group");
    group.append(el("p", "hint", plugin));
    const list = el("div", "checklist");
    for (const tool of tools) {
      const label = el("label", "check");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.name = "agent-allow";
      box.value = tool;
      box.checked = decide(tool);
      label.append(box, el("span", null, tool));
      list.append(label);
    }
    group.append(list);
    wrap.append(group);
  }
}

function denyToolField(agent) {
  /* Positive framing on purpose: a tick means "this agent may call it".
     The stored field is still the deny list (agents.json -> denyTools), so
     unticked tools are written there on save. */
  const host = el("div", "field");
  host.id = "agent-tools-field";
  host.append(el("span", null, "TOOL ที่ใช้ได้ (ติ๊ก = อนุญาต)"));

  const wrap = el("div", "selection");
  const denied = agent?.denyTools ?? [];
  fillAllowList(wrap, (tool) => !denied.includes(tool));
  host.append(wrap);

  // Adding a machine is data, not code: this jumps to the machines sheet, which
  // writes a plugin folder and reloads extensions by itself.
  const addMachine = el("button", "ghost wide", "＋ เพิ่มเครื่อง / IP ใหม่");
  addMachine.type = "button";
  addMachine.addEventListener("click", () => {
    closeAgentSheet();
    openTargetsSheet();
  });
  host.append(addMachine);

  host.append(
    el(
      "p",
      "hint",
      "ติ๊ก = ใช้ได้ · เอาติ๊กออก = ห้ามใช้ tool นั้น (ยังเห็นปลั๊กอินอยู่ แต่เรียกไม่ได้) · เพิ่มเครื่องแล้วรายการนี้จะอัปเดตให้เอง",
    ),
  );
  return host;
}

/** Keeps the sheet open and current when a machine is added or removed elsewhere. */
function refreshAgentTools() {
  const host = document.getElementById("agent-tools-field");
  const wrap = host?.querySelector(".selection");
  if (!wrap) return;

  const known = new Set([...wrap.querySelectorAll('input[name="agent-allow"]')].map((box) => box.value));
  const ticked = new Set(
    [...wrap.querySelectorAll('input[name="agent-allow"]:checked')].map((box) => box.value),
  );
  // Tools that were already on screen keep the operator's choice; a brand new
  // machine arrives allowed, which matches the default for an agent.
  fillAllowList(wrap, (tool) => (known.has(tool) ? ticked.has(tool) : true));
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

  // Role, reply prefix and identity are separate boxes on purpose: role is the
  // one-line title, the prefix is the exact greeting, identity is the free text.
  form.append(
    formField("บทบาท (ROLE) — บรรทัดเดียว", textInput("agent-role", agent?.role ?? "", { placeholder: "เช่น Agency Director / Grand Strategist" })),
  );

  form.append(
    formField(
      "คำนำหน้าตอบ (reply prefix)",
      textInput("agent-reply-prefix", agent?.replyPrefix ?? "", {
        placeholder: "เช่น เคบั๊บ..บอส!! ☄️",
        maxLength: 80,
      }),
    ),
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
      "ตัวตน / บุคลิก (IDENTITY) — หน้าที่ กติกา วิธีพูด",
      textArea("agent-identity", agent?.identity ?? "", "เขียนบทบาท หน้าที่ ข้อห้าม และโทนการพูด (ไม่ต้องใส่คำนำหน้าตอบ ซ้ำ)"),
    ),
  );

  form.append(selectionField("Skills", "agent-skill", state.extensions.skills ?? [], agent ? agent.skills : null));
  form.append(
    selectionField("Plugins", "agent-plugin", state.extensions.plugins ?? [], agent ? agent.plugins : null),
  );
  form.append(selectionField("MCP", "agent-mcp", state.extensions.mcp ?? [], agent ? agent.mcp : null));
  form.append(denyToolField(agent));

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
    replyPrefix: val("agent-reply-prefix").trim() || null,
    model: val("agent-model") || null,
    color: val("agent-color") || null,
    sprite: val("agent-sprite") || null,
    identity: val("agent-identity"),
    skills: selection("skill"),
    plugins: selection("plugin"),
    mcp: selection("mcp"),
    denyTools: denyFromAllowed(checked("agent-allow")),
  };
}

/** Unticked tools (plus any deny entry left over from a removed plugin) become denyTools. */
function denyFromAllowed(allowed) {
  const installed = Object.values(state.extensions.pluginTools ?? {}).flat();
  const known = new Set(installed);
  const existing = findAgent(state.sheetAgentId)?.denyTools ?? [];
  const leftover = existing.filter((tool) => !known.has(tool));
  const unchecked = installed.filter((tool) => !allowed.includes(tool));
  return [...new Set([...leftover, ...unchecked])];
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

/* ---------- remote machines (targets) ---------- */

const TARGET_TOOLS = [
  ["run", "สั่งคำสั่ง (run)"],
  ["read", "อ่านไฟล์ (read)"],
  ["write", "เขียนไฟล์ (write)"],
];

function openTargetsSheet() {
  closeDrawer();
  els.targetsSheet.classList.add("open");
  els.targetsSheet.setAttribute("aria-hidden", "false");
  els.targetError.textContent = "";
  renderTargets();
  renderTargetForm(state.editingTarget);
  send({ type: "targets.list" });
}

function closeTargetsSheet() {
  els.targetsSheet.classList.remove("open");
  els.targetsSheet.setAttribute("aria-hidden", "true");
}

function renderTargets() {
  els.targetsList.innerHTML = "";
  if (state.targetsReady === false) {
    els.targetsList.append(el("p", "muted", "extension system ไม่พร้อมใช้งานบน gateway นี้"));
    return;
  }
  if (state.targets.length === 0) {
    els.targetsList.append(el("p", "muted", "ยังไม่มีเครื่อง — ใส่ IP ด้านล่างเพื่อเพิ่มเครื่องแรก"));
    return;
  }

  for (const target of state.targets) {
    const card = el("div", "target-card");
    card.dataset.plugin = target.plugin;
    const head = el("div", "target-head");
    head.append(el("strong", null, target.label));
    head.append(
      el("span", "target-addr", `${target.user ? `${target.user}@` : ""}${target.host}:${target.port}`),
    );
    card.append(head);

    const tools = el("div", "target-tools");
    for (const [name, text] of TARGET_TOOLS) {
      const on = target.tools.includes(name);
      tools.append(el("span", `badge ${on ? "on" : "off"}`, `${text} ${on ? "✓" : "–"}`));
    }
    card.append(tools);
    card.append(el("p", "hint", `tool: ${target.prefix}_run · ${target.prefix}_read · ${target.prefix}_write`));

    const actions = el("div", "target-actions");
    const test = el("button", "ghost", "ทดสอบ");
    test.type = "button";
    test.addEventListener("click", () => {
      test.disabled = true;
      test.textContent = "กำลังทดสอบ…";
      state.probeResults.delete(target.plugin);
      renderTargets();
      send({ type: "target.probe", plugin: target.plugin });
      setTimeout(() => {
        test.disabled = false;
        test.textContent = "ทดสอบ";
      }, 12000);
    });

    const edit = el("button", "ghost", "แก้ไข");
    edit.type = "button";
    edit.addEventListener("click", () => {
      state.editingTarget = target;
      els.targetError.textContent = "";
      renderTargetForm(target);
    });

    const remove = el("button", "ghost danger", "ลบ");
    remove.type = "button";
    remove.addEventListener("click", () => {
      if (!window.confirm(`ลบ ${target.label} (${target.host}) ออก? โฟลเดอร์จะถูกย้ายไป .removed กู้คืนได้`)) return;
      send({ type: "target.delete", plugin: target.plugin });
    });

    actions.append(test, edit, remove);
    card.append(actions);

    const probe = state.probeResults.get(target.plugin);
    if (probe) card.append(el("p", `probe ${probe.ok ? "ok" : "bad"}`, `${probe.ok ? "✓" : "✗"} ${probe.message}`));
    els.targetsList.append(card);
  }
}

/**
 * After a save, briefly focus the newly saved card so the operator (and any
 * downstream automation reading the visible list) can find it immediately.
 */
function highlightTargetCard(plugin) {
  const list = els.targetsList;
  if (!list) return;
  const card = list.querySelector(`[data-plugin="${CSS.escape(plugin)}"]`);
  if (!card) return;
  [...list.querySelectorAll(".target-card.active")].forEach((n) => n.classList.remove("active"));
  card.classList.add("active");
  requestAnimationFrame(() => {
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function renderTargetForm(target) {
  els.targetsForm.innerHTML = "";
  const form = el("div", "form");

  form.append(
    formField(
      "IP เครื่อง (Tailscale)",
      textInput("target-host", target?.host ?? "", { placeholder: "100.126.244.52" }),
    ),
  );
  form.append(
    formField(
      "ชื่อเรียก (ไม่บังคับ)",
      textInput("target-nickname", target?.prefix ?? "", { placeholder: "vivo", maxLength: 16 }),
    ),
  );

  const tools = el("div", "checklist");
  const enabled = target ? target.tools : TARGET_TOOLS.map(([name]) => name);
  for (const [name, text] of TARGET_TOOLS) {
    const label = el("label", "check");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.name = "target-tool";
    box.value = name;
    box.checked = enabled.includes(name);
    label.append(box, el("span", null, text));
    tools.append(label);
  }
  form.append(formField("ให้ agent ทำอะไรได้บ้าง", tools));

  const details = el("details", "target-more");
  details.append(el("summary", null, "ตั้งค่าขั้นสูง"));
  const row = el("div", "row");
  row.append(
    formField("port", textInput("target-port", target ? String(target.port) : "", { placeholder: "22" })),
    formField(
      "user",
      textInput("target-user", target?.user ?? "", { placeholder: "เว้นว่าง = ผู้ใช้เดียวกับ gateway" }),
    ),
  );
  details.append(
    row,
    formField(
      "หมายเหตุถึง agent",
      textInput("target-notes", target?.notes ?? "", { placeholder: "เช่น Termux ไม่มี GNU tools" }),
    ),
  );
  if (target) details.append(el("p", "hint", `ปลั๊กอิน: ${target.plugin}`));

  const hidden = document.createElement("input");
  hidden.type = "hidden";
  hidden.name = "target-plugin";
  hidden.value = target?.plugin ?? "";
  form.append(details, hidden);

  els.targetsForm.append(form);
}

function readTargetForm() {
  const val = (name) => els.targetsForm.querySelector(`[name="${name}"]`)?.value?.trim() ?? "";
  const tools = [...els.targetsForm.querySelectorAll('input[name="target-tool"]:checked')].map(
    (node) => node.value,
  );
  return {
    plugin: val("target-plugin") || undefined,
    host: val("target-host"),
    nickname: val("target-nickname") || undefined,
    port: val("target-port") || undefined,
    user: val("target-user") || undefined,
    notes: val("target-notes") || undefined,
    tools,
  };
}

function saveTarget() {
  const payload = readTargetForm();
  if (!payload.host) {
    els.targetError.textContent = "ใส่ IP ของเครื่องก่อน";
    return;
  }
  if (payload.tools.length === 0) {
    els.targetError.textContent = "เลือกอย่างน้อย 1 อย่าง (สั่งคำสั่ง / อ่านไฟล์ / เขียนไฟล์)";
    return;
  }
  els.targetError.textContent = "";
  send({ type: "target.save", ...payload });
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

  // A machine was added or removed: refresh the open agent sheet's tool list.
  const toolsSig = JSON.stringify(Object.entries(state.extensions.pluginTools ?? {}));
  if (toolsSig !== lastPluginToolsSig) {
    lastPluginToolsSig = toolsSig;
    refreshAgentTools();
  }

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
      if (frame.ui) state.ui = frame.ui;
      applyUi();
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

    case "ui.state": {
      if (frame.ui) state.ui = frame.ui;
      if (frame.office && Array.isArray(frame.office.scenes)) state.office = frame.office;
      applyUi();
      renderOffice();
      if (els.studioSheet?.classList.contains("open")) renderStudio();
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
      for (const message of visible) addBubble(message.role, message.content, { speak: false });
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

    case "targets.state":
      state.targets = Array.isArray(frame.targets) ? frame.targets : [];
      state.targetsReady = frame.ready !== false;
      renderTargets();
      {
        const plugin = state.activeTargetPlugin;
        if (plugin) {
          const card = els.targetsList?.querySelector(`[data-plugin="${CSS.escape(plugin)}"]`);
          if (card) card.classList.add("active");
          state.activeTargetPlugin = null;
        }
      }
      break;

    case "target.saved": {
      const target = frame.target;
      // After a save, return the form to clean "add a machine" mode so the next
      // IP entry starts fresh, while the card for the machine we just touched is
      // briefly highlighted so the operator (and any automation reading the list)
      // can find it immediately.
      state.editingTarget = null;
      if (target?.plugin) state.probeResults.delete(target.plugin);
      els.targetError.textContent = "";
      renderTargetForm(null);
      toast(`บันทึก ${target?.label ?? "เครื่อง"} แล้ว`);
      if (target?.plugin) {
        state.activeTargetPlugin = target.plugin;
      }
      break;
    }

    case "target.deleted":
      state.probeResults.delete(frame.plugin);
      if (state.editingTarget?.plugin === frame.plugin) {
        state.editingTarget = null;
        renderTargetForm(null);
      }
      toast("ลบเครื่องแล้ว (กู้คืนได้จาก extensions/plugins/.removed)");
      break;

    case "target.probe":
      state.probeResults.set(frame.plugin, { ok: Boolean(frame.ok), message: frame.message ?? "" });
      renderTargets();
      toast(frame.ok ? `ทดสอบผ่าน: ${frame.message}` : `ทดสอบไม่ผ่าน: ${frame.message}`);
      break;

    case "error":
      if (els.agentSheet.classList.contains("open")) els.agentError.textContent = frame.message ?? "gateway error";
      else if (els.targetsSheet.classList.contains("open")) els.targetError.textContent = frame.message ?? "gateway error";
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
  stopSpeaking();
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
els.chatClose.addEventListener("click", () => {
  stopSpeaking();
  setView("office");
});
els.chatAlpha?.addEventListener("click", cycleDialogAlpha);
els.talkAlpha?.addEventListener("click", cycleDialogAlpha);
try {
  const savedAlpha = Number.parseInt(storage.get(ALPHA_KEY) ?? "", 10);
  alphaIndex = ALPHA_STEPS.indexOf(savedAlpha);
  if (alphaIndex < 0) alphaIndex = 0;
} catch {
  alphaIndex = 0;
}
applyDialogAlpha(ALPHA_STEPS[alphaIndex]);
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
els.targetsBtn?.addEventListener("click", openTargetsSheet);
els.studioBtn?.addEventListener("click", openStudio);
els.studioClose?.addEventListener("click", closeStudio);
initVoice();
els.targetsSheetClose?.addEventListener("click", closeTargetsSheet);
els.targetSave?.addEventListener("click", saveTarget);
els.targetNew?.addEventListener("click", () => {
  state.editingTarget = null;
  els.targetError.textContent = "";
  renderTargetForm(null);
});

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
  closeTargetsSheet();
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
