// popup.js

const $ = id => document.getElementById(id);

// ── Load saved settings ───────────────────────────────────────────────────────
browser.storage.local.get(["serverUrl", "apiToken", "model"]).then(s => {
  $("server-url").value = s.serverUrl || "http://localhost:11434";
  $("api-token").value  = s.apiToken  || "";
  $("model").value      = s.model     || "llama3";
});

// ── Toggle settings panel ─────────────────────────────────────────────────────
$("toggle-settings").addEventListener("click", () => {
  $("settings-panel").classList.toggle("open");
});

// ── Save settings ─────────────────────────────────────────────────────────────
$("save-settings").addEventListener("click", () => {
  const serverUrl = $("server-url").value.trim();
  const apiToken  = $("api-token").value.trim();
  const model     = $("model").value.trim();

  browser.storage.local.set({ serverUrl, apiToken, model }).then(() => {
    $("saved-msg").textContent = "Saved.";
    setTimeout(() => { $("saved-msg").textContent = ""; }, 2000);
  });
});

// ── Summarize page ────────────────────────────────────────────────────────────
$("btn-summarize-page").addEventListener("click", async () => {
  const { text } = await browser.runtime.sendMessage({ type: "GET_PAGE_TEXT" });
  browser.runtime.sendMessage({
    type: "OPEN_SIDEBAR",
    task: { mode: "summarize", scope: "page", content: text }
  });
  window.close();
});

// ── Ask about page ────────────────────────────────────────────────────────────
$("btn-ask-page").addEventListener("click", async () => {
  const { text } = await browser.runtime.sendMessage({ type: "GET_PAGE_TEXT" });
  browser.runtime.sendMessage({
    type: "OPEN_SIDEBAR",
    task: { mode: "ask", scope: "page", content: text }
  });
  window.close();
});

// ── Open free chat ────────────────────────────────────────────────────────────
$("btn-open-chat").addEventListener("click", () => {
  browser.runtime.sendMessage({
    type: "OPEN_SIDEBAR",
    task: { mode: "chat", scope: "free", content: "" }
  });
  window.close();
});
