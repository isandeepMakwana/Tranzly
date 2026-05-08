const STORAGE_KEYS = {
  autoTranslate: "autoTranslate",
  rules: "rules"
};

const SELECTORS = {
  modeChip: "#mode-chip",
  settingsButton: "#settings-button",
  currentUrl: "#current-url",
  matchRow: "#match-row",
  translateButton: "#translate-button",
  secondaryButton: "#secondary-button",
  autoToggle: "#auto-toggle",
  ruleForm: "#rule-form",
  ruleInput: "#rule-input",
  rulesContainer: "#rules-container",
  statusCard: "#status-card",
  statusTitle: "#status-title",
  statusMessage: "#status-message",
  progressWrap: "#progress-wrap",
  progressBar: "#progress-bar",
  progressLabel: "#progress-label",
  statusActions: "#status-actions",
  retryButton: "#retry-button",
  optionsLink: "#options-link"
};

const state = {
  tab: null,
  rules: [],
  autoTranslate: true,
  contentStatus: null,
  pollTimer: null
};

function $(selector) {
  return document.querySelector(selector);
}

function icon(name) {
  const icons = {
    globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>',
    delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L11 4.93"/><path d="M14 11a5 5 0 0 0-7.07 0L4.8 13.12a5 5 0 0 0 7.07 7.07L13 19.07"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 12 3 3 7-7"/><circle cx="12" cy="12" r="10"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
    warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 19-9-16-9 16Z"/><path d="M12 9v4M12 17h.01"/></svg>',
    error: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 19-9-16-9 16Z"/><path d="M12 9v4M12 17h.01"/></svg>',
    spinner: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 1-9 9"/></svg>',
    restore: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-2"/></svg>',
    translate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.3 6.4"/><path d="M3 12A9 9 0 0 1 18.3 5.6"/><path d="M21 5v5h-5"/><path d="M3 19v-5h5"/></svg>'
  };

  return icons[name] || icons.info;
}

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

function findMatchingRule(url, rules) {
  const normalizedUrl = String(url || "").toLowerCase();
  return (rules || []).find((rule) => {
    const normalizedRule = normalizeRule(rule);
    return normalizedRule && normalizedUrl.includes(normalizedRule);
  }) || null;
}

function getCurrentHostname() {
  try {
    return new URL(state.tab?.url || "").hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function shortenUrl(url) {
  if (!url) {
    return "No active tab";
  }

  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.origin}${path}`;
  } catch {
    return url;
  }
}

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0] || null);
    });
  });
}

function sendTabMessage(message) {
  return new Promise((resolve) => {
    if (!state.tab?.id) {
      resolve(null);
      return;
    }

    chrome.tabs.sendMessage(state.tab.id, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      resolve(response || null);
    });
  });
}

function injectContentScript() {
  return new Promise((resolve) => {
    if (!state.tab?.id || !chrome.scripting?.executeScript) {
      resolve(false);
      return;
    }

    chrome.scripting.executeScript({
      target: { tabId: state.tab.id },
      files: ["src/content.js"]
    }, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

async function sendTabMessageWithRecovery(message) {
  const firstResponse = await sendTabMessage(message);
  if (firstResponse) {
    return firstResponse;
  }

  const injected = await injectContentScript();
  if (!injected) {
    return null;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, 120);
  });

  return sendTabMessage(message);
}

function sendLog(category, code, message, level = "info", details = {}) {
  chrome.runtime.sendMessage({
    type: "LOG_EVENT",
    entry: { category, code, level, message, details }
  }, () => {
    void chrome.runtime.lastError;
  });
}

function inaccessiblePageStatus() {
  return {
    state: "error",
    progress: 0,
    translatedCount: 0,
    totalCount: 0,
    canRestore: false,
    error: "This page cannot be accessed by the extension."
  };
}

async function loadStorage() {
  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  state.rules = Array.isArray(stored[STORAGE_KEYS.rules])
    ? stored[STORAGE_KEYS.rules].map(normalizeRule).filter(Boolean)
    : [];
  state.autoTranslate = stored[STORAGE_KEYS.autoTranslate] !== false;
}

async function saveRules(rules) {
  const unique = [...new Set(rules.map(normalizeRule).filter(Boolean))];
  state.rules = unique;
  await chrome.storage.local.set({ [STORAGE_KEYS.rules]: unique });
}

async function addRule(value) {
  const normalized = normalizeRule(value);
  if (!normalized) {
    return;
  }

  const isNewRule = !state.rules.includes(normalized);
  await saveRules([...state.rules, normalized]);
  if (isNewRule) {
    sendLog("user", "USER_ADD_RULE", `User added rule: ${normalized}`, "info");
  }
  $(SELECTORS.ruleInput).value = "";
  render();
}

async function removeRule(rule) {
  await saveRules(state.rules.filter((existing) => existing !== rule));
  sendLog("user", "USER_REMOVE_RULE", `User removed rule: ${rule}`, "info");
  render();
}

async function refreshContentStatus() {
  const response = await sendTabMessageWithRecovery({ type: "GET_STATUS" });
  state.contentStatus = response;
  render();
}

function renderHeader() {
  const chip = $(SELECTORS.modeChip);
  chip.textContent = state.autoTranslate ? "Active" : "Paused";
  chip.className = state.autoTranslate ? "chip chip-success" : "chip";
  $(SELECTORS.autoToggle).checked = state.autoTranslate;
}

function renderCurrentPage() {
  const url = state.tab?.url || "";
  const matchedRule = findMatchingRule(url, state.rules);
  const isTranslating = state.contentStatus?.state === "translating";
  const isTranslated = state.contentStatus?.state === "translated" && state.contentStatus?.canRestore;

  $(SELECTORS.currentUrl).textContent = shortenUrl(url);

  const matchRow = $(SELECTORS.matchRow);
  if (matchedRule) {
    matchRow.innerHTML = '<span class="status-dot status-success"></span><span>Matches rule: ' + escapeHtml(matchedRule) + "</span>";
  } else {
    matchRow.innerHTML = '<span class="status-dot status-warning"></span><span>No matching rule</span>';
  }

  const translateButton = $(SELECTORS.translateButton);
  translateButton.disabled = isTranslating;
  translateButton.innerHTML = `${icon("translate")}<span>${isTranslating ? "Translating..." : isTranslated ? "Translate again" : "Translate now"}</span>`;

  const secondaryButton = $(SELECTORS.secondaryButton);
  if (matchedRule) {
    secondaryButton.disabled = isTranslating || !state.contentStatus?.canRestore;
    secondaryButton.className = secondaryButton.disabled
      ? "button button-secondary button-muted"
      : "button button-secondary";
    secondaryButton.dataset.action = "restore";
    secondaryButton.innerHTML = `${icon("restore")}<span>Restore original</span>`;
  } else {
    secondaryButton.disabled = !getCurrentHostname();
    secondaryButton.className = "button button-secondary";
    secondaryButton.dataset.action = "add-domain";
    secondaryButton.innerHTML = '<span>Add current domain</span>';
  }
}

function renderRules() {
  const container = $(SELECTORS.rulesContainer);

  if (!state.rules.length) {
    container.innerHTML = `
      <div class="empty-rules">
        <div class="empty-icon">${icon("link")}</div>
        <h3>No rules yet.</h3>
        <p>Add part of a URL to start<br>automatic translation.</p>
        <button id="empty-add-domain" type="button">Add current domain</button>
      </div>
    `;

    const emptyButton = $("#empty-add-domain");
    emptyButton.disabled = !getCurrentHostname();
    emptyButton.addEventListener("click", () => addRule(getCurrentHostname()));
    return;
  }

  container.innerHTML = `
    <div class="rule-list">
      ${state.rules.map((rule) => `
        <div class="rule-item">
          ${icon("globe")}
          <span class="truncate" title="${escapeHtml(rule)}">${escapeHtml(rule)}</span>
          <button class="delete-rule" type="button" data-rule="${escapeHtml(rule)}" title="Delete rule" aria-label="Delete ${escapeHtml(rule)}">
            ${icon("delete")}
          </button>
        </div>
      `).join("")}
    </div>
  `;

  container.querySelectorAll(".delete-rule").forEach((button) => {
    button.addEventListener("click", () => removeRule(button.dataset.rule));
  });
}

function renderStatus() {
  const status = state.contentStatus || {};
  const card = $(SELECTORS.statusCard);
  const title = $(SELECTORS.statusTitle);
  const message = $(SELECTORS.statusMessage);
  const progressWrap = $(SELECTORS.progressWrap);
  const progressBar = $(SELECTORS.progressBar);
  const progressLabel = $(SELECTORS.progressLabel);
  const statusActions = $(SELECTORS.statusActions);
  const matchedRule = findMatchingRule(state.tab?.url || "", state.rules);

  progressWrap.hidden = true;
  statusActions.hidden = true;

  if (!state.rules.length) {
    card.className = "notice notice-info";
    card.querySelector(".notice-icon").innerHTML = icon("info");
    title.textContent = "Ready";
    message.textContent = "No rules added yet.";
    return;
  }

  if (!matchedRule) {
    const hostname = getCurrentHostname();
    card.className = "notice notice-warning";
    card.querySelector(".notice-icon").innerHTML = icon("warning");
    title.textContent = "No matching rule";
    message.innerHTML = hostname
      ? `This page won't be translated automatically.<br><a href="#" id="add-current-host">Add rule for ${escapeHtml(hostname)}</a>`
      : "This page won't be translated automatically.";

    const addLink = $("#add-current-host");
    if (addLink) {
      addLink.addEventListener("click", (event) => {
        event.preventDefault();
        addRule(hostname);
      });
    }
    return;
  }

  if (status.state === "translating") {
    const progress = Math.max(0, Math.min(100, Number(status.progress) || 0));
    card.className = "notice notice-info";
    card.querySelector(".notice-icon").innerHTML = icon("spinner");
    title.textContent = "Translating...";
    message.textContent = "Please wait while we translate the page content.";
    progressWrap.hidden = false;
    progressBar.style.width = `${progress}%`;
    progressLabel.textContent = `${progress}%`;
    return;
  }

  if (status.state === "error") {
    card.className = "notice notice-error";
    card.querySelector(".notice-icon").innerHTML = icon("error");
    title.textContent = "Translator unavailable";
    message.textContent = status.error || "Translator is not available in this Chrome version.";
    statusActions.hidden = false;
    return;
  }

  if (status.state === "translated") {
    card.className = "notice notice-success";
    card.querySelector(".notice-icon").innerHTML = icon("check");
    title.textContent = status.translatedCount > 0 ? "Translated successfully" : "Nothing to translate";
    message.innerHTML = status.translatedCount > 0
      ? `${status.translatedCount} elements translated<br>Just now`
      : "No Chinese text found on this page.";
    return;
  }

  card.className = "notice notice-success";
  card.querySelector(".notice-icon").innerHTML = icon("check");
  title.textContent = "Ready";
  message.textContent = "Extension is active and waiting.";
}

function render() {
  renderHeader();
  renderCurrentPage();
  renderRules();
  renderStatus();
}

function bindEvents() {
  $(SELECTORS.ruleForm).addEventListener("submit", (event) => {
    event.preventDefault();
    addRule($(SELECTORS.ruleInput).value);
  });

  $(SELECTORS.autoToggle).addEventListener("change", async (event) => {
    state.autoTranslate = event.target.checked;
    await chrome.storage.local.set({ [STORAGE_KEYS.autoTranslate]: state.autoTranslate });
    sendLog("user", "USER_TOGGLE_AUTO", `Auto translate toggled: ${state.autoTranslate ? "ON" : "OFF"}`, "info");
    render();
  });

  $(SELECTORS.translateButton).addEventListener("click", async () => {
    sendLog("user", "USER_TRANSLATE_NOW", "User clicked translate now", "info");
    state.contentStatus = { state: "translating", progress: 0 };
    render();
    state.contentStatus = await sendTabMessageWithRecovery({ type: "TRANSLATE_NOW", force: true }) || inaccessiblePageStatus();
    render();
  });

  $(SELECTORS.secondaryButton).addEventListener("click", async () => {
    const action = $(SELECTORS.secondaryButton).dataset.action;

    if (action === "add-domain") {
      await addRule(getCurrentHostname());
      return;
    }

    sendLog("user", "USER_RESTORE", "User clicked restore original", "info");
    state.contentStatus = await sendTabMessageWithRecovery({ type: "RESTORE_ORIGINAL" });
    render();
  });

  $(SELECTORS.retryButton).addEventListener("click", async () => {
    sendLog("user", "USER_TRANSLATE_NOW", "User clicked retry translate", "info");
    state.contentStatus = { state: "translating", progress: 0 };
    render();
    state.contentStatus = await sendTabMessageWithRecovery({ type: "TRANSLATE_NOW", force: true }) || inaccessiblePageStatus();
    render();
  });

  $(SELECTORS.settingsButton).addEventListener("click", () => {
    sendLog("user", "USER_OPEN_OPTIONS", "Options page opened", "info");
    chrome.runtime.openOptionsPage();
  });

  $(SELECTORS.optionsLink).addEventListener("click", () => {
    sendLog("user", "USER_OPEN_OPTIONS", "Options page opened", "info");
    chrome.runtime.openOptionsPage();
  });
}

async function init() {
  bindEvents();
  await loadStorage();
  state.tab = await queryActiveTab();
  render();
  await refreshContentStatus();

  state.pollTimer = setInterval(refreshContentStatus, 1000);
}

window.addEventListener("unload", () => {
  clearInterval(state.pollTimer);
});

init();
