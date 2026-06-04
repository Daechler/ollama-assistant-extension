// background.js

// ── Context menu setup ──────────────────────────────────────────────────────

function createMenus() {
  browser.contextMenus.removeAll(() => {
    browser.contextMenus.create({ id: "summarize-selection", title: "Summarize selection",  contexts: ["selection"] });
    browser.contextMenus.create({ id: "ask-selection",       title: "Ask about selection…", contexts: ["selection"] });
    browser.contextMenus.create({ id: "summarize-page",      title: "Summarize page",        contexts: ["page"] });
    browser.contextMenus.create({ id: "ask-page",            title: "Ask about page…",       contexts: ["page"] });
  });
}

createMenus();

// ── Context menu click ───────────────────────────────────────────────────────

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = info.menuItemId;

  if (id === "summarize-selection") {
    await queueAndOpen({ mode: "summarize", scope: "selection", content: info.selectionText.trim() });

  } else if (id === "ask-selection") {
    await queueAndOpen({ mode: "ask", scope: "selection", content: info.selectionText.trim() });

  } else if (id === "summarize-page") {
    const content = await getPageText(tab.id);
    await queueAndOpen({ mode: "summarize", scope: "page", content });

  } else if (id === "ask-page") {
    const content = await getPageText(tab.id);
    await queueAndOpen({ mode: "ask", scope: "page", content });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getPageText(tabId) {
  try {
    const results = await browser.tabs.executeScript(tabId, { code: `document.body.innerText` });
    return results[0] || "";
  } catch (_) { return ""; }
}

// Write task to storage first, THEN open sidebar.
// The sidebar reads pending task on load and also watches for storage changes.
async function queueAndOpen(task) {
  await browser.storage.local.set({ pendingTask: task });
  await browser.sidebarAction.open();
}

// ── Messages from popup ──────────────────────────────────────────────────────

browser.runtime.onMessage.addListener(async (msg, sender) => {

  if (msg.type === "OPEN_SIDEBAR") {
    if (msg.task) {
      await browser.storage.local.set({ pendingTask: msg.task });
    }
    await browser.sidebarAction.open();
    return Promise.resolve({ ok: true });
  }

  if (msg.type === "GET_PAGE_TEXT") {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      const text = await getPageText(tabs[0].id);
      return Promise.resolve({ text });
    }
    return Promise.resolve({ text: "" });
  }

  if (msg.type === "OLLAMA_STREAM") {
    streamOllama(msg);
    return Promise.resolve({ ok: true });
  }
});

// ── Ollama streaming ─────────────────────────────────────────────────────────

async function streamOllama({ url, token, model, messages, streamId }) {
  const endpoint = url.replace(/\/$/, "") + "/api/chat";
  const headers  = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages, stream: true })
    });
  } catch (err) {
    broadcastToSidebar({ type: "STREAM_ERROR", streamId, error: err.message });
    return;
  }

  if (!response.ok) {
    const errText = await response.text();
    broadcastToSidebar({ type: "STREAM_ERROR", streamId, error: `HTTP ${response.status}: ${errText}` });
    return;
  }

  const reader  = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) { broadcastToSidebar({ type: "STREAM_DONE", streamId }); break; }

    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split("\n").filter(l => l.trim())) {
      try {
        const json  = JSON.parse(line);
        const piece = json?.message?.content || "";
        if (piece) broadcastToSidebar({ type: "STREAM_CHUNK", streamId, token: piece });
        if (json.done) { broadcastToSidebar({ type: "STREAM_DONE", streamId }); return; }
      } catch (_) {}
    }
  }
}

// Send to all extension pages (sidebar is one of them)
function broadcastToSidebar(msg) {
  browser.runtime.sendMessage(msg).catch(() => {});
}
