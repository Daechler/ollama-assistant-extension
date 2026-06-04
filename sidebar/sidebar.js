// sidebar/sidebar.js

// ── State ─────────────────────────────────────────────────────────────────────
let conversationHistory = [];
let pageContext  = "";
let currentScope = "free";
let isStreaming  = false;
let stopRequested = false;
let streamCounter = 0;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const messagesEl  = document.getElementById("messages");
const userInput   = document.getElementById("user-input");
const sendBtn     = document.getElementById("send-btn");
const stopBtn     = document.getElementById("stop-btn");
const clearBtn    = document.getElementById("clear-btn");
const modelLabel  = document.getElementById("model-label");
const headerTitle = document.getElementById("header-title");
const ctxBanner   = document.getElementById("context-banner");
const ctxTag      = document.getElementById("ctx-tag");
const ctxDesc     = document.getElementById("ctx-desc");

// ── Config ────────────────────────────────────────────────────────────────────
let cfg = { serverUrl: "http://localhost:11434", apiToken: "", model: "llama3" };

async function loadConfig() {
  const s = await browser.storage.local.get(["serverUrl", "apiToken", "model"]);
  cfg.serverUrl = s.serverUrl || "http://localhost:11434";
  cfg.apiToken  = s.apiToken  || "";
  cfg.model     = s.model     || "llama3";
  modelLabel.textContent = cfg.model;
}

// ── Boot: check for a pending task written by background before sidebar opened ─
async function boot() {
  await loadConfig();

  const storage = await browser.storage.local.get("pendingTask");
  if (storage.pendingTask) {
    const task = storage.pendingTask;
    // Clear it so it doesn't replay on next open
    await browser.storage.local.remove("pendingTask");
    handleTask(task);
  }
}

boot();

// ── Watch storage for tasks written AFTER the sidebar is already open ─────────
// (e.g. user triggers a second context-menu action without closing sidebar)
browser.storage.onChanged.addListener(async (changes, area) => {
  if (area === "local" && changes.pendingTask && changes.pendingTask.newValue) {
    const task = changes.pendingTask.newValue;
    await browser.storage.local.remove("pendingTask");
    handleTask(task);
  }
});

// ── Runtime messages (stream chunks from background) ─────────────────────────
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STREAM_CHUNK") handleChunk(msg.streamId, msg.token);
  if (msg.type === "STREAM_DONE")  handleStreamDone(msg.streamId);
  if (msg.type === "STREAM_ERROR") handleStreamError(msg.streamId, msg.error);
});

// ── Task handler ──────────────────────────────────────────────────────────────
async function handleTask(task) {
  await loadConfig();
  resetChat();

  pageContext  = task.content || "";
  currentScope = task.scope  || "free";

  if (task.scope === "page") {
    ctxTag.textContent  = "PAGE";
    ctxDesc.textContent = "Context: full page content";
    ctxBanner.classList.add("visible");
    headerTitle.textContent = "Page · Ollama";
  } else if (task.scope === "selection") {
    ctxTag.textContent  = "SELECTION";
    ctxDesc.textContent = truncate(pageContext, 50);
    ctxBanner.classList.add("visible");
    headerTitle.textContent = "Selection · Ollama";
  } else {
    ctxBanner.classList.remove("visible");
    headerTitle.textContent = "Chat · Ollama";
  }

  if (task.mode === "summarize") {
    const label  = task.scope === "selection" ? "selected text" : "page";
    const ctx    = truncateContext(pageContext);
    const prompt = `Summarize the following ${label} in 3-5 bullet points. Be concise; omit boilerplate, navigation, and ads. Highlight only the key facts, arguments, or findings.\n\n${ctx}`;
    await sendMessage(prompt, true);
  } else if (task.mode === "ask") {
    userInput.placeholder = "Ask about the " + (task.scope === "selection" ? "selection" : "page") + "…";
    userInput.focus();
  } else {
    userInput.placeholder = "Ask anything…";
    userInput.focus();
  }
}

// ── Context truncation ────────────────────────────────────────────────────────
// Keep context under ~6000 chars (~1500 tokens) to leave room for conversation
const CTX_CHAR_LIMIT = 6000;

function truncateContext(text) {
  if (text.length <= CTX_CHAR_LIMIT) return text;
  // Keep the first 60% and last 20% — preserves intro + conclusion
  const head = Math.floor(CTX_CHAR_LIMIT * 0.6);
  const tail = Math.floor(CTX_CHAR_LIMIT * 0.2);
  return text.slice(0, head) + "\n\n[... content truncated ...]\n\n" + text.slice(-tail);
}

// ── Build system message ──────────────────────────────────────────────────────
function buildSystemMessage() {
  if (!pageContext || currentScope === "free") {
    return "You are a helpful assistant. Answer questions clearly and concisely.";
  }
  const label = currentScope === "selection" ? "selected text" : "webpage";
  const ctx   = truncateContext(pageContext);
  return `You are a helpful assistant. The user has provided the following ${label} as context. Use it to answer questions accurately and concisely.\n\n---\n${ctx}\n---`;
}

// Keep only the last N turns to avoid ballooning context on long chats.
// Each turn = 1 user + 1 assistant message, so 10 turns = 20 messages.
const MAX_HISTORY_TURNS = 10;

function trimmedHistory() {
  const maxMsgs = MAX_HISTORY_TURNS * 2;
  return conversationHistory.length > maxMsgs
    ? conversationHistory.slice(-maxMsgs)
    : conversationHistory;
}

// ── Send message ──────────────────────────────────────────────────────────────
async function sendMessage(text, isAuto = false) {
  if (isStreaming || !text.trim()) return;

  hideEmpty();

  appendUserMsg(isAuto ? "⟳ Summarize" : text, isAuto);
  conversationHistory.push({ role: "user", content: text });

  const aiEl     = appendAiMsg();
  isStreaming    = true;
  stopRequested  = false;
  stopBtn.classList.add("visible");
  sendBtn.disabled = true;

  const streamId = ++streamCounter;
  window._streamTarget = { streamId, el: aiEl, content: "" };

  browser.runtime.sendMessage({
    type:     "OLLAMA_STREAM",
    url:      cfg.serverUrl,
    token:    cfg.apiToken,
    model:    cfg.model,
    streamId,
    messages: [
      { role: "system", content: buildSystemMessage() },
      ...trimmedHistory()
    ]
  });
}

// ── Stream handlers ───────────────────────────────────────────────────────────
function handleChunk(streamId, token) {
  if (!window._streamTarget || window._streamTarget.streamId !== streamId) return;
  if (stopRequested) return;
  window._streamTarget.content += token;
  const bubble = window._streamTarget.el.querySelector(".msg-bubble");
  bubble.innerHTML = renderMarkdown(window._streamTarget.content) + '<span class="cursor"></span>';
  scrollBottom();
}

function handleStreamDone(streamId) {
  if (!window._streamTarget || window._streamTarget.streamId !== streamId) return;
  const bubble = window._streamTarget.el.querySelector(".msg-bubble");
  bubble.innerHTML = renderMarkdown(window._streamTarget.content);
  conversationHistory.push({ role: "assistant", content: window._streamTarget.content });
  window._streamTarget = null;
  isStreaming = false;
  stopBtn.classList.remove("visible");
  sendBtn.disabled = false;
  scrollBottom();
}

function handleStreamError(streamId, error) {
  if (!window._streamTarget || window._streamTarget.streamId !== streamId) return;
  const bubble = window._streamTarget.el.querySelector(".msg-bubble");
  bubble.textContent = "Error: " + error;
  window._streamTarget.el.classList.add("error");
  window._streamTarget = null;
  isStreaming = false;
  stopBtn.classList.remove("visible");
  sendBtn.disabled = false;
  scrollBottom();
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function appendUserMsg(text, muted = false) {
  const div = document.createElement("div");
  div.className = "msg user";
  div.innerHTML = `
    <div class="msg-role">you</div>
    <div class="msg-bubble" style="${muted ? "color:var(--muted);font-style:italic" : ""}">${escHtml(text)}</div>`;
  messagesEl.appendChild(div);
  scrollBottom();
  return div;
}

function appendAiMsg() {
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.innerHTML = `
    <div class="msg-role">ollama · ${cfg.model}</div>
    <div class="msg-bubble"><span class="cursor"></span></div>`;
  messagesEl.appendChild(div);
  scrollBottom();
  return div;
}

function hideEmpty() {
  const es = document.getElementById("empty-state");
  if (es) es.remove();
}

function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function resetChat() {
  conversationHistory = [];
  pageContext = "";
  messagesEl.innerHTML = `
    <div id="empty-state">
      <div class="big-o">○</div>
      <p>Ask a question or<br/>summarize the page.</p>
    </div>`;
}

function truncate(str, n) { return str.length > n ? str.slice(0, n) + "…" : str; }
function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function renderMarkdown(text) {
  let h = escHtml(text);
  h = h.replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c.trim()}</code></pre>`);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/\*(.+?)\*/g, "<em>$1</em>");
  h = h.replace(/^#{1,3} (.+)$/gm, "<strong>$1</strong>");
  h = h.replace(/^[-*] (.+)$/gm, "• $1");
  return h;
}

// ── Input events ──────────────────────────────────────────────────────────────
userInput.addEventListener("input", () => {
  userInput.style.height = "auto";
  userInput.style.height = Math.min(userInput.scrollHeight, 140) + "px";
});

userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const text = userInput.value.trim();
    if (text) { userInput.value = ""; userInput.style.height = "auto"; sendMessage(text); }
  }
});

sendBtn.addEventListener("click", () => {
  const text = userInput.value.trim();
  if (text) { userInput.value = ""; userInput.style.height = "auto"; sendMessage(text); }
});

stopBtn.addEventListener("click", () => {
  stopRequested = true;
  if (window._streamTarget) {
    const bubble = window._streamTarget.el.querySelector(".msg-bubble");
    bubble.innerHTML = renderMarkdown(window._streamTarget.content) + " <em style='color:var(--muted)'>[stopped]</em>";
    conversationHistory.push({ role: "assistant", content: window._streamTarget.content });
    window._streamTarget = null;
  }
  isStreaming = false;
  stopBtn.classList.remove("visible");
  sendBtn.disabled = false;
});

clearBtn.addEventListener("click", () => {
  resetChat();
  ctxBanner.classList.remove("visible");
  headerTitle.textContent = "Ollama Assistant";
  userInput.placeholder = "Ask anything…";
});
