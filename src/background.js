const DEFAULT_RULES = ["cloud.oppoer.me"];
const MAX_LOGS = 250;

const STORAGE_KEYS = {
  autoTranslate: "autoTranslate",
  logs: "logs",
  rules: "rules"
};

const ICON_PATHS = {
  idle: {
    16: "icons/idle-16.png",
    32: "icons/idle-32.png",
    48: "icons/idle-48.png",
    128: "icons/idle-128.png"
  },
  matched: {
    16: "icons/matched-16.png",
    32: "icons/matched-32.png",
    48: "icons/matched-48.png",
    128: "icons/matched-128.png"
  },
  translating: {
    16: "icons/translating-16.png",
    32: "icons/translating-32.png",
    48: "icons/translating-48.png",
    128: "icons/translating-128.png"
  },
  success: {
    16: "icons/success-16.png",
    32: "icons/success-32.png",
    48: "icons/success-48.png",
    128: "icons/success-128.png"
  },
  error: {
    16: "icons/error-16.png",
    32: "icons/error-32.png",
    48: "icons/error-48.png",
    128: "icons/error-128.png"
  },
  disabled: {
    16: "icons/disabled-16.png",
    32: "icons/disabled-32.png",
    48: "icons/disabled-48.png",
    128: "icons/disabled-128.png"
  }
};

const BADGES = {
  idle: { text: "", color: "#6B7280" },
  matched: { text: "ON", color: "#22C55E" },
  translating: { text: "...", color: "#2563EB" },
  success: { text: "\u2713", color: "#22C55E" },
  error: { text: "ERR", color: "#EF4444" },
  disabled: { text: "OFF", color: "#6B7280" }
};

const tabIconStates = new Map();

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

async function getConfig() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.autoTranslate,
    STORAGE_KEYS.rules
  ]);

  return {
    autoTranslate: stored[STORAGE_KEYS.autoTranslate] !== false,
    rules: Array.isArray(stored[STORAGE_KEYS.rules])
      ? stored[STORAGE_KEYS.rules].map(normalizeRule).filter(Boolean)
      : []
  };
}

async function ensureDefaults() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.autoTranslate,
    STORAGE_KEYS.logs,
    STORAGE_KEYS.rules
  ]);
  const updates = {};

  if (!Array.isArray(stored[STORAGE_KEYS.rules])) {
    updates[STORAGE_KEYS.rules] = DEFAULT_RULES;
  }

  if (typeof stored[STORAGE_KEYS.autoTranslate] !== "boolean") {
    updates[STORAGE_KEYS.autoTranslate] = true;
  }

  if (!Array.isArray(stored[STORAGE_KEYS.logs])) {
    updates[STORAGE_KEYS.logs] = [];
  }

  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
  }
}

async function addLog(entry) {
  const normalizedEntry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: new Date().toISOString(),
    category: entry.category || "lifecycle",
    code: entry.code || "INFO",
    level: entry.level || "info",
    message: entry.message || "",
    details: entry.details || {}
  };

  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.logs);
    const logs = Array.isArray(stored[STORAGE_KEYS.logs])
      ? stored[STORAGE_KEYS.logs]
      : [];
    await chrome.storage.local.set({
      [STORAGE_KEYS.logs]: [normalizedEntry, ...logs].slice(0, MAX_LOGS)
    });
  } catch {
    // Logging should never block translation or icon updates.
  }
}

async function createContextMenus() {
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: "auto-page-translator-translate",
    title: "Translate page to English",
    contexts: ["page"],
    documentUrlPatterns: ["<all_urls>"]
  });

  chrome.contextMenus.create({
    id: "auto-page-translator-restore",
    title: "Restore original text",
    contexts: ["page"],
    documentUrlPatterns: ["<all_urls>"]
  });
}

async function setBadge(tabId, iconState) {
  const badge = BADGES[iconState] || BADGES.idle;
  await chrome.action.setBadgeText({ tabId, text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });

  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ tabId, color: "#FFFFFF" });
  }
}

async function setTabIcon(tabId, iconState, reason = "state update") {
  if (!tabId || !ICON_PATHS[iconState]) {
    return;
  }

  const previousState = tabIconStates.get(tabId);

  try {
    await chrome.action.setIcon({ tabId, path: ICON_PATHS[iconState] });
    await setBadge(tabId, iconState);
    tabIconStates.set(tabId, iconState);

    if (previousState !== iconState) {
      await addLog({
        category: "icon",
        code: `ICON_${iconState.toUpperCase()}`,
        level: iconState === "error" ? "error" : iconState === "success" ? "success" : "info",
        message: `Icon state -> ${iconState.toUpperCase()}`,
        details: { tabId, reason }
      });
    }
  } catch {
    // Action icons cannot be updated for every internal Chrome page.
  }
}

function iconStateFromStatus(status) {
  if (status?.autoTranslate === false) {
    return "disabled";
  }

  if (status?.state === "error") {
    return "error";
  }

  if (status?.state === "translating") {
    return "translating";
  }

  if (status?.state === "translated") {
    return "success";
  }

  if (status?.matchedRule) {
    return "matched";
  }

  return "idle";
}

async function iconStateFromUrl(url) {
  const config = await getConfig();

  if (!config.autoTranslate) {
    return "disabled";
  }

  return findMatchingRule(url, config.rules) ? "matched" : "idle";
}

async function updateTabFromUrl(tabId, url, reason = "tab update") {
  if (!tabId || !url) {
    return;
  }

  const iconState = await iconStateFromUrl(url);
  await setTabIcon(tabId, iconState, reason);
}

async function updateAllTabs(reason = "settings update") {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => updateTabFromUrl(tab.id, tab.url, reason)));
}

async function sendTabMessage(tab, message) {
  if (!tab || typeof tab.id !== "number") {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/content.js"]
      });
      await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      await addLog({
        category: "error",
        code: "PERMISSION_ERROR",
        level: "warning",
        message: "Unable to send command to this tab",
        details: { tabId: tab.id, url: tab.url }
      });
    }
  }
}

async function handleInstalled(details) {
  await ensureDefaults();
  await createContextMenus();
  await addLog({
    category: "lifecycle",
    code: details.reason === "install" ? "EXTENSION_INSTALLED" : "EXTENSION_UPDATED",
    level: "success",
    message: details.reason === "install" ? "Extension installed" : "Extension updated"
  });
  await updateAllTabs("extension installed");
}

chrome.runtime.onInstalled.addListener((details) => {
  handleInstalled(details);
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  await createContextMenus();
  await addLog({
    category: "lifecycle",
    code: "EXTENSION_ENABLED",
    level: "success",
    message: "Extension enabled"
  });
  await updateAllTabs("extension startup");
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "auto-page-translator-translate") {
    addLog({
      category: "user",
      code: "USER_TRANSLATE_NOW",
      level: "info",
      message: "User clicked context menu translate"
    });
    sendTabMessage(tab, { type: "TRANSLATE_NOW", force: true });
    return;
  }

  if (info.menuItemId === "auto-page-translator-restore") {
    addLog({
      category: "user",
      code: "USER_RESTORE",
      level: "info",
      message: "User clicked context menu restore"
    });
    sendTabMessage(tab, { type: "RESTORE_ORIGINAL" });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "STATUS_UPDATE" && sender.tab?.id) {
      await setTabIcon(
        sender.tab.id,
        iconStateFromStatus(message.status),
        message.status?.state || "content status"
      );
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "LOG_EVENT") {
      await addLog(message.entry || {});
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false });
  })();

  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes[STORAGE_KEYS.rules]) {
    const oldRules = Array.isArray(changes[STORAGE_KEYS.rules].oldValue)
      ? changes[STORAGE_KEYS.rules].oldValue.map(normalizeRule)
      : [];
    const newRules = Array.isArray(changes[STORAGE_KEYS.rules].newValue)
      ? changes[STORAGE_KEYS.rules].newValue.map(normalizeRule)
      : [];

    newRules
      .filter((rule) => !oldRules.includes(rule))
      .forEach((rule) => addLog({
        category: "rule",
        code: "RULE_ADDED",
        level: "success",
        message: `Rule added: ${rule}`
      }));

    oldRules
      .filter((rule) => !newRules.includes(rule))
      .forEach((rule) => addLog({
        category: "rule",
        code: "RULE_DELETED",
        level: "warning",
        message: `Rule deleted: ${rule}`
      }));
  }

  if (changes[STORAGE_KEYS.autoTranslate]) {
    const enabled = changes[STORAGE_KEYS.autoTranslate].newValue !== false;
    addLog({
      category: "lifecycle",
      code: enabled ? "EXTENSION_RESUMED" : "EXTENSION_PAUSED",
      level: enabled ? "success" : "warning",
      message: enabled ? "Extension resumed by user" : "Extension paused by user"
    });
  }

  if (changes[STORAGE_KEYS.rules] || changes[STORAGE_KEYS.autoTranslate]) {
    updateAllTabs("settings changed");
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    addLog({
      category: "page",
      code: "URL_CHANGED",
      level: "info",
      message: `URL changed: ${changeInfo.url}`,
      details: { tabId }
    });
    updateTabFromUrl(tabId, changeInfo.url, "url changed");
    return;
  }

  if (changeInfo.status === "loading" && tab.url) {
    addLog({
      category: "page",
      code: "PAGE_LOADED",
      level: "info",
      message: `Page loaded: ${tab.url}`,
      details: { tabId }
    });
    updateTabFromUrl(tabId, tab.url, "page loading");
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    await addLog({
      category: "page",
      code: "TAB_ACTIVATED",
      level: "info",
      message: `Tab activated: ${activeInfo.tabId}`,
      details: { tabId: activeInfo.tabId }
    });
    await updateTabFromUrl(tab.id, tab.url, "tab activated");
  } catch {
    // Ignore closed or inaccessible tabs.
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabIconStates.delete(tabId);
});
