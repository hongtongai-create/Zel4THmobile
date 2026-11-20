const els = {
  drawer: document.getElementById("drawer"),
  scrim: document.getElementById("scrim"),
  menu: document.getElementById("menu"),
  drawerClose: document.getElementById("drawer-close"),
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
  sessionList: document.getElementById("session-list"),
  newChat: document.getElementById("new-chat"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  sessionTitle: document.getElementById("session-title"),
  sessionMeta: document.getElementById("session-meta"),
  toolList: document.getElementById("tool-list"),
};

const SESSION_KEY = "clawgate.session";
const TOKEN_KEY = "clawgate.token";
const MODEL_KEY = "clawgate.model";

const state = {
  ws: null,
  token: null,
  sessionId: null,
  models: [],
  currentModel: null,
  tools: [],
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

function newSessionId() {
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `board:${id}`;
}

function setStatus(kind, text) {
  els.statusDot.className = `dot ${kind}`;
  els.statusText.textContent = text;
}

function setModelChip(model) {
  state.currentModel = model;
  els.modelChipText.textContent = model || "no model";
  els.modelBtn.disabled = state.models.length === 0;
}

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
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  els.messages.append(div);
  scrollToBottom(role === "user");
  return div;
}

function addToolChip(callId, name, args, phase) {
  hideEmpty();
  const chip = document.createElement("div");
  chip.className = "tool";
  chip.dataset.callId = callId;

  const head = document.createElement("div");
  head.className = "head";
  const icon = document.createElement("span");
  icon.textContent = phase === "running" ? "⋯" : "✓";
  const label = document.createElement("span");
  label.className = "name";
  label.textContent = name;
  const status = document.createElement("span");
  status.textContent = phase === "running" ? "running" : "done";
  head.append(icon, label, status);

  const payload = document.createElement("div");
  payload.className = "payload";
  payload.textContent = typeof args === "string" ? args : JSON.stringify(args);

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
  const div = document.createElement("div");
  div.className = "typing";
  div.textContent = "agent is working";
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
  els.sessionMeta.textContent = count
    ? `${count} messages · ${session.model ?? state.currentModel ?? ""}`
    : "no messages yet";
  if (session?.title) els.sessionTitle.textContent = session.title;
}

/* ---------- drawer / sheet ---------- */

function openDrawer() {
  els.drawer.classList.add("open");
  els.scrim.classList.add("show");
}

function closeDrawer() {
  els.drawer.classList.remove("open");
  els.scrim.classList.remove("show");
}

function openModelSheet() {
  if (state.models.length === 0) {
    addBubble("error", "No models configured on the gateway yet.");
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

/* ---------- rendering ---------- */

function renderModels(models, defaultRef) {
  state.models = models;
  if (!state.currentModel) setModelChip(defaultRef);
  els.modelBtn.disabled = models.length === 0;
  if (els.modelSheet.classList.contains("open")) renderModelOptions();
}

function renderModelOptions() {
  const defaultRef = state.models.find((model) => model.default)?.ref ?? null;
  const current = state.currentModel;
  els.modelOptions.innerHTML = "";
  for (const model of state.models) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "model-option";
    if (model.ref === current) button.classList.add("selected");

    const info = document.createElement("div");
    const ref = document.createElement("div");
    ref.className = "ref";
    ref.textContent = model.ref;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = `${model.providerLabel}${model.ref === defaultRef ? " · default" : ""}`;
    info.append(ref, sub);

    const check = document.createElement("span");
    check.className = "check";
    check.textContent = model.ref === current ? "✓" : "";

    button.append(info, check);
    button.addEventListener("click", () => {
      if (state.sessionId) send({ type: "model.set", sessionId: state.sessionId, model: model.ref });
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
    const li = document.createElement("li");
    if (session.id === state.sessionId) li.classList.add("active");

    const title = document.createElement("span");
    title.textContent = session.title || session.id.replace(/^board:/, "").slice(0, 12);

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${session.channel} · ${session.model} · ${session.messages} msg`;

    li.append(title, meta);
    li.addEventListener("click", () => {
      openSession(session.id, session.model);
      closeDrawer();
    });
    els.sessionList.append(li);
  }
}

function openSession(sessionId, model) {
  state.sessionId = sessionId;
  storage.set(SESSION_KEY, sessionId);
  els.messages.innerHTML = "";
  state.toolChips.clear();
  stopTyping();
  setBusy(false);
  if (model) setModelChip(model);
  els.sessionTitle.textContent = "Conversation";
  els.sessionMeta.textContent = "loading…";
  send({ type: "session.history", sessionId });
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

function handleFrame(frame) {
  switch (frame.type) {
    case "ready":
      els.login.hidden = true;
      state.tools = frame.tools ?? [];
      els.toolList.textContent = `tools: ${state.tools.join(", ") || "none"}`;
      renderModels(frame.models ?? [], frame.defaultModel ?? null);
      if (!state.sessionId) {
        state.sessionId = storage.get(SESSION_KEY) || newSessionId();
        storage.set(SESSION_KEY, state.sessionId);
      }
      send({ type: "sessions.list" });
      send({ type: "session.history", sessionId: state.sessionId });
      break;

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
      updateMeta({ messages: visible, model: frame.model ?? "" });
      if (visible.length === 0) {
        els.sessionTitle.textContent = "New conversation";
        els.sessionMeta.textContent = "no messages yet";
      }
      scrollToBottom(true);
      break;
    }

    case "model.set":
      setModelChip(frame.model);
      storage.set(MODEL_KEY, frame.model);
      els.sessionMeta.textContent = `model: ${frame.model}`;
      break;

    case "session.reset":
      els.messages.innerHTML = "";
      state.toolChips.clear();
      els.sessionTitle.textContent = "New conversation";
      els.sessionMeta.textContent = "no messages yet";
      break;

    case "event":
      handleAgentEvent(frame.event);
      break;

    case "error":
      addBubble("error", frame.message ?? "gateway error");
      setBusy(false);
      break;

    default:
      break;
  }
}

function handleAgentEvent(event) {
  switch (event.type) {
    case "turn.start":
      setBusy(true);
      showTyping();
      break;
    case "tool.start":
      addToolChip(event.callId, event.name, event.args, "running");
      break;
    case "tool.result":
      finishToolChip(event);
      break;
    case "assistant.message":
      addBubble("assistant", event.text);
      break;
    case "error":
      addBubble("error", event.message);
      break;
    case "turn.end":
      setBusy(false);
      send({ type: "sessions.list" });
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
  send({ type: "chat.send", sessionId: state.sessionId, text });
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

els.menu.addEventListener("click", openDrawer);
els.drawerClose.addEventListener("click", closeDrawer);
els.scrim.addEventListener("click", closeDrawer);
els.modelBtn.addEventListener("click", openModelSheet);
els.sheetClose.addEventListener("click", closeModelSheet);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeDrawer();
  closeModelSheet();
});

els.newChat.addEventListener("click", () => {
  const sessionId = newSessionId();
  state.sessionId = sessionId;
  storage.set(SESSION_KEY, sessionId);
  els.messages.innerHTML = "";
  state.toolChips.clear();
  stopTyping();
  setBusy(false);
  els.sessionTitle.textContent = "New conversation";
  els.sessionMeta.textContent = "no messages yet";
  closeDrawer();
  send({ type: "sessions.list" });
  els.input.focus();
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

const savedToken = storage.get(TOKEN_KEY);
if (savedToken) {
  state.token = savedToken;
  connect(savedToken);
} else {
  showLogin();
}
