const STORAGE_KEYS = {
  autoTranslate: "autoTranslate",
  logs: "logs",
  rules: "rules"
};

const autoToggle = document.querySelector("#auto-toggle");
const clearLogsButton = document.querySelector("#clear-logs");
const logsGrid = document.querySelector("#logs-grid");
const ruleForm = document.querySelector("#rule-form");
const ruleInput = document.querySelector("#rule-input");
const rulesList = document.querySelector("#rules-list");

const LOG_GROUPS = [
  { category: "rule", title: "Rule engine logs", color: "#7C3AED" },
  { category: "translation", title: "Translation engine logs", color: "#2563EB" },
  { category: "error", title: "Error logs", color: "#EF4444" },
  { category: "icon", title: "Icon state logs", color: "#16A34A" },
  { category: "lifecycle", title: "Extension lifecycle logs", color: "#F97316" },
  { category: "page", title: "Page & tab logs", color: "#0D9488" },
  { category: "user", title: "User action logs", color: "#2563EB" }
];

let logs = [];
let rules = [];

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function normalizeRule(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

function sendLog(category, code, message, level = "info", details = {}) {
  chrome.runtime.sendMessage({
    type: "LOG_EVENT",
    entry: { category, code, level, message, details }
  }, () => {
    void chrome.runtime.lastError;
  });
}

async function saveRules(nextRules) {
  rules = [...new Set(nextRules.map(normalizeRule).filter(Boolean))];
  await chrome.storage.local.set({ [STORAGE_KEYS.rules]: rules });
  renderRules();
}

function renderRules() {
  if (!rules.length) {
    rulesList.innerHTML = '<div class="empty">No rules added yet.</div>';
    return;
  }

  rulesList.innerHTML = rules.map((rule) => `
    <div class="rule-row">
      <strong>${escapeHtml(rule)}</strong>
      <button type="button" data-rule="${escapeHtml(rule)}">Delete</button>
    </div>
  `).join("");

  rulesList.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const rule = button.dataset.rule;
      sendLog("user", "USER_REMOVE_RULE", `User removed rule: ${rule}`, "info");
      saveRules(rules.filter((existing) => existing !== rule));
    });
  });
}

function formatTime(timestamp) {
  if (!timestamp) {
    return "";
  }

  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(timestamp));
  } catch {
    return "";
  }
}

function renderLogGroup(group) {
  const groupLogs = logs
    .filter((entry) => entry.category === group.category)
    .slice(0, 12);

  const entries = groupLogs.length
    ? groupLogs.map((entry) => `
      <div class="log-entry level-${escapeHtml(entry.level || "info")}">
        <code>[${escapeHtml(entry.code)}]</code>
        <span>${escapeHtml(entry.message)}</span>
        <small>${escapeHtml(formatTime(entry.timestamp))}</small>
      </div>
    `).join("")
    : '<div class="log-empty">No logs yet.</div>';

  return `
    <article class="log-card">
      <h3><span style="background:${group.color}"></span>${escapeHtml(group.title)}</h3>
      <div class="log-list">${entries}</div>
    </article>
  `;
}

function renderLogs() {
  logsGrid.innerHTML = LOG_GROUPS.map(renderLogGroup).join("");
}

async function loadState() {
  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  rules = Array.isArray(stored[STORAGE_KEYS.rules])
    ? stored[STORAGE_KEYS.rules].map(normalizeRule).filter(Boolean)
    : [];
  logs = Array.isArray(stored[STORAGE_KEYS.logs]) ? stored[STORAGE_KEYS.logs] : [];
  autoToggle.checked = stored[STORAGE_KEYS.autoTranslate] !== false;

  renderRules();
  renderLogs();
}

autoToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ [STORAGE_KEYS.autoTranslate]: autoToggle.checked });
  sendLog("user", "USER_TOGGLE_AUTO", `Auto translate toggled: ${autoToggle.checked ? "ON" : "OFF"}`, "info");
});

ruleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const normalized = normalizeRule(ruleInput.value);
  if (!normalized) {
    return;
  }

  const isNewRule = !rules.includes(normalized);
  await saveRules([...rules, normalized]);
  if (isNewRule) {
    sendLog("user", "USER_ADD_RULE", `User added rule: ${normalized}`, "info");
  }
  ruleInput.value = "";
});

clearLogsButton.addEventListener("click", async () => {
  logs = [];
  await chrome.storage.local.set({ [STORAGE_KEYS.logs]: [] });
  renderLogs();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes[STORAGE_KEYS.logs]) {
    logs = Array.isArray(changes[STORAGE_KEYS.logs].newValue)
      ? changes[STORAGE_KEYS.logs].newValue
      : [];
    renderLogs();
  }

  if (changes[STORAGE_KEYS.rules]) {
    rules = Array.isArray(changes[STORAGE_KEYS.rules].newValue)
      ? changes[STORAGE_KEYS.rules].newValue.map(normalizeRule).filter(Boolean)
      : [];
    renderRules();
  }

  if (changes[STORAGE_KEYS.autoTranslate]) {
    autoToggle.checked = changes[STORAGE_KEYS.autoTranslate].newValue !== false;
  }
});

loadState();
