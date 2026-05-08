(() => {
  if (window.__AUTO_PAGE_TRANSLATOR_LOADED__) {
    return;
  }

  window.__AUTO_PAGE_TRANSLATOR_LOADED__ = true;

  const STORAGE_KEYS = {
    autoTranslate: "autoTranslate",
    rules: "rules"
  };

  const SKIP_SELECTOR = [
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "canvas",
    "code",
    "pre",
    "[translate='no']",
    "[data-auto-page-translator-ignore]"
  ].join(",");

  const TRANSLATABLE_ATTRIBUTES = ["title", "aria-label", "placeholder", "alt"];
  const CHINESE_TEXT = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const MAX_TEXT_LENGTH = 1200;

  const translatedTextNodes = new Map();
  const translatedAttributes = new Map();
  const translationCache = new Map();

  let translatorInstance = null;
  let isTranslating = false;
  let observer = null;
  let autoTranslateTimer = null;
  let statusPublishTimer = null;
  let urlWatcherTimer = null;
  let lastMatchLogKey = "";
  let lastUrl = location.href;

  let status = {
    state: "ready",
    progress: 0,
    translatedCount: 0,
    totalCount: 0,
    message: "Extension is active and waiting.",
    error: "",
    matchedRule: null,
    autoTranslate: true,
    rulesCount: 0,
    canRestore: false,
    url: location.href
  };

  function hasChromeRuntime() {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime && chrome.storage);
  }

  function sendRuntimeMessage(message) {
    if (!hasChromeRuntime()) {
      return;
    }

    try {
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // Some restricted pages do not allow extension messaging.
    }
  }

  function logEvent(category, code, message, level = "info", details = {}) {
    sendRuntimeMessage({
      type: "LOG_EVENT",
      entry: {
        category,
        code,
        level,
        message,
        details: {
          url: location.href,
          ...details
        }
      }
    });
  }

  function scheduleStatusPublish() {
    clearTimeout(statusPublishTimer);
    statusPublishTimer = setTimeout(() => {
      sendRuntimeMessage({
        type: "STATUS_UPDATE",
        status: getPublicStatus()
      });
    }, 150);
  }

  function compactWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
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

  async function getConfig() {
    const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
    const rules = Array.isArray(stored[STORAGE_KEYS.rules])
      ? stored[STORAGE_KEYS.rules].map(normalizeRule).filter(Boolean)
      : [];

    return {
      rules,
      autoTranslate: stored[STORAGE_KEYS.autoTranslate] !== false
    };
  }

  function getRestorableCount() {
    let attributeCount = 0;
    translatedAttributes.forEach((attrs) => {
      attributeCount += attrs.size;
    });

    return translatedTextNodes.size + attributeCount;
  }

  function setStatus(partial) {
    status = {
      ...status,
      ...partial,
      url: location.href,
      canRestore: getRestorableCount() > 0
    };
    scheduleStatusPublish();
  }

  async function refreshMatchStatus() {
    const config = await getConfig();
    const matchedRule = findMatchingRule(location.href, config.rules);

    setStatus({
      matchedRule,
      autoTranslate: config.autoTranslate,
      rulesCount: config.rules.length
    });

    const matchLogKey = `${location.href}::${matchedRule || "none"}::${config.rules.length}`;
    if (matchLogKey !== lastMatchLogKey) {
      lastMatchLogKey = matchLogKey;

      if (matchedRule) {
        logEvent("rule", "RULE_MATCH", `Matched rule: ${matchedRule}`, "success", { matchedRule });
      } else if (config.rules.length) {
        logEvent("rule", "RULE_NOT_FOUND", "No matching rule found", "warning");
      }
    }

    return { config, matchedRule };
  }

  function isElementSkipped(element) {
    if (!element) {
      return true;
    }

    if (element.closest(SKIP_SELECTOR)) {
      return true;
    }

    if (element.isContentEditable) {
      return true;
    }

    return false;
  }

  function isUsefulText(value) {
    const trimmed = compactWhitespace(value);
    return trimmed.length > 0 && trimmed.length <= MAX_TEXT_LENGTH && CHINESE_TEXT.test(trimmed);
  }

  function preserveOuterWhitespace(original, translated) {
    const leading = original.match(/^\s*/)?.[0] || "";
    const trailing = original.match(/\s*$/)?.[0] || "";
    return `${leading}${translated}${trailing}`;
  }

  function collectTextTargets(root) {
    const targets = [];
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.parentElement || isElementSkipped(node.parentElement)) {
            return NodeFilter.FILTER_REJECT;
          }

          if (translatedTextNodes.has(node)) {
            return NodeFilter.FILTER_REJECT;
          }

          return isUsefulText(node.nodeValue)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      }
    );

    while (walker.nextNode()) {
      targets.push({
        type: "text",
        node: walker.currentNode,
        original: walker.currentNode.nodeValue
      });
    }

    return targets;
  }

  function isButtonValueTranslatable(element) {
    if (!(element instanceof HTMLInputElement)) {
      return false;
    }

    return ["button", "submit", "reset"].includes(element.type);
  }

  function collectAttributeTargets(root) {
    const targets = [];
    const elements = root.querySelectorAll("*");

    elements.forEach((element) => {
      if (isElementSkipped(element)) {
        return;
      }

      TRANSLATABLE_ATTRIBUTES.forEach((attribute) => {
        const value = element.getAttribute(attribute);
        const translatedForElement = translatedAttributes.get(element);

        if (translatedForElement?.has(attribute) || !value || !isUsefulText(value)) {
          return;
        }

        targets.push({
          type: "attribute",
          element,
          attribute,
          original: value
        });
      });

      if (isButtonValueTranslatable(element)) {
        const translatedForElement = translatedAttributes.get(element);
        if (!translatedForElement?.has("value") && isUsefulText(element.value)) {
          targets.push({
            type: "attribute",
            element,
            attribute: "value",
            original: element.value
          });
        }
      }
    });

    return targets;
  }

  function collectTargets(root = document.body) {
    if (!root) {
      return [];
    }

    return [
      ...collectTextTargets(root),
      ...collectAttributeTargets(root)
    ];
  }

  async function getTranslator() {
    if (translatorInstance) {
      return translatorInstance;
    }

    if (!globalThis.Translator || typeof globalThis.Translator.create !== "function") {
      throw new Error("Translator is not available in this Chrome version.");
    }

    const availability = typeof globalThis.Translator.availability === "function"
      ? await globalThis.Translator.availability({
        sourceLanguage: "zh",
        targetLanguage: "en"
      })
      : "available";

    if (availability === "unavailable") {
      throw new Error("Chinese to English translation is unavailable in this Chrome version.");
    }

    translatorInstance = await globalThis.Translator.create({
      sourceLanguage: "zh",
      targetLanguage: "en"
    });

    if (translatorInstance.ready) {
      await translatorInstance.ready;
    }

    return translatorInstance;
  }

  async function translateText(value) {
    const trimmed = compactWhitespace(value);

    if (translationCache.has(trimmed)) {
      return translationCache.get(trimmed);
    }

    const translator = await getTranslator();
    const translated = compactWhitespace(String(await translator.translate(trimmed)));
    const result = translated || trimmed;
    translationCache.set(trimmed, result);
    return result;
  }

  function rememberAttributeOriginal(element, attribute, original) {
    let attributes = translatedAttributes.get(element);

    if (!attributes) {
      attributes = new Map();
      translatedAttributes.set(element, attributes);
    }

    if (!attributes.has(attribute)) {
      attributes.set(attribute, original);
    }
  }

  function applyTranslation(target, translated) {
    if (target.type === "text") {
      if (!target.node.isConnected || target.node.nodeValue !== target.original) {
        return false;
      }

      translatedTextNodes.set(target.node, target.original);
      target.node.nodeValue = preserveOuterWhitespace(target.original, translated);
      return true;
    }

    if (!target.element.isConnected) {
      return false;
    }

    if (target.attribute === "value") {
      if (target.element.value !== target.original) {
        return false;
      }

      rememberAttributeOriginal(target.element, target.attribute, target.original);
      target.element.value = translated;
      return true;
    }

    if (target.element.getAttribute(target.attribute) !== target.original) {
      return false;
    }

    rememberAttributeOriginal(target.element, target.attribute, target.original);
    target.element.setAttribute(target.attribute, translated);
    return true;
  }

  async function translatePage(options = {}) {
    if (isTranslating) {
      return getPublicStatus();
    }

    const { force = false } = options;
    const { matchedRule } = await refreshMatchStatus();

    logEvent("translation", "TRANSLATE_START", "Translation started", "info", {
      force,
      matchedRule
    });

    if (force) {
      restoreOriginal({ silent: true });
    }

    const targets = collectTargets();
    logEvent("translation", "TRANSLATE_FOUND", `Found ${targets.length} translatable elements`, "info", {
      count: targets.length
    });

    if (!targets.length) {
      setStatus({
        state: "translated",
        progress: 100,
        totalCount: 0,
        message: matchedRule ? "No Chinese text found on this page." : "Manual translation completed.",
        error: "",
        canRestore: getRestorableCount() > 0
      });
      logEvent("translation", "TRANSLATE_COMPLETE", "Translation completed with no Chinese text found", "success", {
        translatedCount: 0
      });
      return getPublicStatus();
    }

    isTranslating = true;
    let appliedCount = 0;

    setStatus({
      state: "translating",
      progress: 0,
      totalCount: targets.length,
      translatedCount: 0,
      message: "Please wait while we translate the page content.",
      error: ""
    });

    try {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        const translated = await translateText(target.original);

        if (applyTranslation(target, translated)) {
          appliedCount += 1;
        }

        setStatus({
          progress: Math.round(((index + 1) / targets.length) * 100),
          translatedCount: appliedCount
        });
      }

      setStatus({
        state: "translated",
        progress: 100,
        translatedCount: appliedCount,
        message: appliedCount === 1
          ? "1 element translated."
          : `${appliedCount} elements translated.`,
        error: ""
      });
      logEvent("translation", "TRANSLATE_COMPLETE", "Translation completed successfully", "success", {
        translatedCount: appliedCount,
        totalCount: targets.length
      });
    } catch (error) {
      const message = error?.message || "Translator is not available in this Chrome version.";
      setStatus({
        state: "error",
        progress: 0,
        message: "Translator unavailable",
        error: message
      });
      logEvent("error", "TRANSLATE_ERROR", "Translation failed", "error", { error: message });

      if (/translator|api|unavailable/i.test(message)) {
        logEvent("error", "API_ERROR", "Translator API unavailable", "error", { error: message });
      } else {
        logEvent("error", "DOM_ERROR", "Error processing page content", "error", { error: message });
      }
    } finally {
      isTranslating = false;
    }

    return getPublicStatus();
  }

  function restoreOriginal(options = {}) {
    translatedTextNodes.forEach((original, node) => {
      if (node.isConnected) {
        node.nodeValue = original;
      }
    });

    translatedAttributes.forEach((attributes, element) => {
      if (!element.isConnected) {
        return;
      }

      attributes.forEach((original, attribute) => {
        if (attribute === "value" && "value" in element) {
          element.value = original;
          return;
        }

        element.setAttribute(attribute, original);
      });
    });

    const restoredCount = getRestorableCount();

    translatedTextNodes.clear();
    translatedAttributes.clear();

    if (!options.silent) {
      setStatus({
        state: "ready",
        progress: 0,
        translatedCount: 0,
        totalCount: 0,
        message: "Original text restored.",
        error: ""
      });
      logEvent("translation", "TRANSLATE_RESTORE", "Original content restored", "success", {
        restoredCount
      });
    }
  }

  async function maybeAutoTranslate() {
    const { config, matchedRule } = await refreshMatchStatus();

    if (!matchedRule) {
      if (status.state !== "translating" && status.state !== "translated") {
        setStatus({
          state: config.rules.length ? "no_match" : "ready",
          progress: 0,
          message: config.rules.length
            ? "This page will not be translated automatically."
            : "No rules added yet.",
          error: ""
        });
      }
      return;
    }

    if (!config.autoTranslate) {
      if (status.state !== "translated" && status.state !== "translating") {
        setStatus({
          state: "ready",
          progress: 0,
          message: "Auto translate is paused.",
          error: ""
        });
      }
      return;
    }

    if (!isTranslating) {
      await translatePage({ force: false });
    }
  }

  function scheduleAutoTranslate(delay = 450) {
    clearTimeout(autoTranslateTimer);
    autoTranslateTimer = setTimeout(() => {
      maybeAutoTranslate();
    }, delay);
  }

  function startObserver() {
    if (observer || !document.documentElement) {
      return;
    }

    observer = new MutationObserver(() => {
      if (!isTranslating) {
        scheduleAutoTranslate(650);
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function handlePotentialUrlChange() {
    setTimeout(() => {
      if (location.href === lastUrl) {
        return;
      }

      lastUrl = location.href;
      logEvent("page", "URL_CHANGED", `URL changed: ${location.href}`, "info");
      setStatus({
        state: "ready",
        progress: 0,
        translatedCount: 0,
        totalCount: 0,
        message: "Extension is active and waiting.",
        error: ""
      });
      scheduleAutoTranslate(700);
    }, 50);
  }

  function patchHistoryForSpaNavigation() {
    try {
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;

      history.pushState = function pushState(...args) {
        const result = originalPushState.apply(this, args);
        handlePotentialUrlChange();
        return result;
      };

      history.replaceState = function replaceState(...args) {
        const result = originalReplaceState.apply(this, args);
        handlePotentialUrlChange();
        return result;
      };
    } catch {
      // URL polling below still handles SPA route changes if history cannot be patched.
    }

    window.addEventListener("popstate", handlePotentialUrlChange);
  }

  function startUrlWatcher() {
    if (urlWatcherTimer) {
      return;
    }

    urlWatcherTimer = setInterval(handlePotentialUrlChange, 800);
  }

  function getPublicStatus() {
    return {
      ...status,
      canRestore: getRestorableCount() > 0,
      url: location.href
    };
  }

  function waitForBody() {
    if (document.body) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (document.body) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  }

  function registerMessageHandlers() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      (async () => {
        if (message?.type === "GET_STATUS") {
          await refreshMatchStatus();
          sendResponse(getPublicStatus());
          return;
        }

        if (message?.type === "TRANSLATE_NOW") {
          sendResponse(await translatePage({ force: Boolean(message.force) }));
          return;
        }

        if (message?.type === "RESTORE_ORIGINAL") {
          restoreOriginal();
          await refreshMatchStatus();
          sendResponse(getPublicStatus());
          return;
        }

        sendResponse(getPublicStatus());
      })();

      return true;
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") {
        return;
      }

      if (changes[STORAGE_KEYS.rules] || changes[STORAGE_KEYS.autoTranslate]) {
        scheduleAutoTranslate(300);
      }
    });
  }

  async function init() {
    if (!hasChromeRuntime()) {
      return;
    }

    registerMessageHandlers();
    await waitForBody();
    await refreshMatchStatus();
    logEvent("page", "PAGE_LOADED", `Page loaded: ${location.href}`, "info");
    patchHistoryForSpaNavigation();
    startUrlWatcher();
    startObserver();
    scheduleAutoTranslate(300);
  }

  init();
})();
