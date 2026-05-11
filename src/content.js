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
  const BATCH_MAX_CHARS = 3500;
  const BATCH_MAX_ITEMS = 40;
  const FIRST_PAINT_BATCH_ITEMS = 12;
  const BATCH_MARKER_PREFIX = "__APT_";
  const BATCH_MARKER_SUFFIX = "__";
  const PROGRESS_UPDATE_INTERVAL_MS = 180;
  const TRANSLATION_CONCURRENCY = 6;

  const translatedTextNodes = new Map();
  const translatedAttributes = new Map();
  const translationCache = new Map();

  let translatorCreationPromise = null;
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

  function getTargetElement(target) {
    if (target.type === "text") {
      return target.node?.parentElement || null;
    }

    return target.element || null;
  }

  function getTargetPriority(target) {
    const element = getTargetElement(target);
    if (!element || typeof element.getBoundingClientRect !== "function") {
      return Number.MAX_SAFE_INTEGER;
    }

    const rect = element.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    const isVisible = rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= viewportHeight;

    if (isVisible) {
      return Math.max(0, rect.top);
    }

    const distanceFromViewport = rect.top < 0
      ? Math.abs(rect.bottom)
      : Math.abs(rect.top - viewportHeight);

    return 100000 + distanceFromViewport;
  }

  function prioritizeTargets(targets) {
    return [...targets].sort((left, right) => getTargetPriority(left) - getTargetPriority(right));
  }

  async function getTranslator() {
    if (translatorInstance) {
      return translatorInstance;
    }

    if (translatorCreationPromise) {
      return translatorCreationPromise;
    }

    translatorCreationPromise = (async () => {
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
    })();

    try {
      return await translatorCreationPromise;
    } catch (error) {
      translatorCreationPromise = null;
      throw error;
    }
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

  function createBatchMarker(index) {
    return `${BATCH_MARKER_PREFIX}${index}${BATCH_MARKER_SUFFIX}`;
  }

  function createTranslationChunks(texts) {
    const chunks = [];
    let currentChunk = [];
    let currentLength = 0;

    texts.forEach((text) => {
      const markerLength = createBatchMarker(currentChunk.length).length + 2;
      const nextLength = currentLength + markerLength + text.length + 1;
      const shouldStartNewChunk = currentChunk.length > 0
        && (currentChunk.length >= BATCH_MAX_ITEMS || nextLength > BATCH_MAX_CHARS);

      if (shouldStartNewChunk) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentLength = 0;
      }

      currentChunk.push(text);
      currentLength += markerLength + text.length + 1;
    });

    if (currentChunk.length) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  function buildBatchPayload(texts) {
    return texts
      .map((text, index) => `${createBatchMarker(index)}\n${text}`)
      .join("\n");
  }

  function parseBatchTranslation(rawTranslation, sourceTexts) {
    const output = String(rawTranslation || "");
    const markerPattern = /__APT_(\d+)__/g;
    const markers = [];
    let match = markerPattern.exec(output);

    while (match) {
      markers.push({
        index: Number(match[1]),
        start: match.index,
        end: markerPattern.lastIndex
      });
      match = markerPattern.exec(output);
    }

    if (markers.length !== sourceTexts.length) {
      return null;
    }

    const parsed = new Map();
    for (let index = 0; index < markers.length; index += 1) {
      const marker = markers[index];
      const nextMarker = markers[index + 1];
      const sourceText = sourceTexts[marker.index];
      const translated = compactWhitespace(output.slice(marker.end, nextMarker ? nextMarker.start : output.length));

      if (!sourceText || !translated) {
        return null;
      }

      parsed.set(sourceText, translated);
    }

    return parsed.size === sourceTexts.length ? parsed : null;
  }

  async function translateBatch(texts) {
    if (texts.length === 1) {
      return new Map([[texts[0], await translateText(texts[0])]]);
    }

    const translator = await getTranslator();
    const rawTranslation = await translator.translate(buildBatchPayload(texts));
    const parsed = parseBatchTranslation(rawTranslation, texts);

    if (!parsed) {
      logEvent("translation", "TRANSLATE_BATCH_FALLBACK", "Batch translation fallback used", "warning", {
        count: texts.length
      });
      const fallbackEntries = await Promise.all(texts.map(async (text) => [text, await translateText(text)]));
      return new Map(fallbackEntries);
    }

    parsed.forEach((translated, sourceText) => {
      translationCache.set(sourceText, translated);
    });

    return parsed;
  }

  function getTranslationKey(value) {
    return compactWhitespace(value);
  }

  function yieldToBrowser() {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          setTimeout(resolve, 0);
        });
        return;
      }

      setTimeout(resolve, 0);
    });
  }

  async function translateUniqueTexts(targets, onProgress, onChunkTranslated) {
    const uniqueTexts = [...new Set(targets.map((target) => getTranslationKey(target.original)))];
    const translatedByText = new Map();
    const cachedTexts = new Map();
    const pendingTexts = [];

    uniqueTexts.forEach((text) => {
      if (translationCache.has(text)) {
        const cachedTranslation = translationCache.get(text);
        translatedByText.set(text, cachedTranslation);
        cachedTexts.set(text, cachedTranslation);
        return;
      }

      pendingTexts.push(text);
    });

    if (cachedTexts.size) {
      onChunkTranslated(cachedTexts);
    }

    if (!pendingTexts.length) {
      onProgress(uniqueTexts.length, uniqueTexts.length);
      return translatedByText;
    }

    const firstPaintChunk = pendingTexts.slice(0, FIRST_PAINT_BATCH_ITEMS);
    const remainingTexts = pendingTexts.slice(FIRST_PAINT_BATCH_ITEMS);
    const chunks = createTranslationChunks(remainingTexts);
    let completed = uniqueTexts.length - pendingTexts.length;
    let nextIndex = 0;

    async function translateAndPublishChunk(chunk) {
      if (!chunk.length) {
        return;
      }

      const translatedChunk = await translateBatch(chunk);
      translatedChunk.forEach((translated, sourceText) => {
        translatedByText.set(sourceText, translated);
      });
      completed += chunk.length;
      onChunkTranslated(translatedChunk);
      onProgress(completed, uniqueTexts.length);
      await yieldToBrowser();
    }

    await translateAndPublishChunk(firstPaintChunk);

    async function worker() {
      while (nextIndex < chunks.length) {
        const chunk = chunks[nextIndex];
        nextIndex += 1;
        await translateAndPublishChunk(chunk);
      }
    }

    onProgress(completed, uniqueTexts.length);

    const workerCount = Math.min(TRANSLATION_CONCURRENCY, chunks.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return translatedByText;
  }

  function createProgressReporter(totalCount) {
    let lastUpdate = 0;

    return (completedCount, translatedCount = status.translatedCount || 0, force = false) => {
      const now = Date.now();
      if (!force && now - lastUpdate < PROGRESS_UPDATE_INTERVAL_MS && completedCount < totalCount) {
        return;
      }

      lastUpdate = now;
      setStatus({
        progress: totalCount ? Math.round((completedCount / totalCount) * 100) : 100,
        translatedCount
      });
    };
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

    const targets = prioritizeTargets(collectTargets());
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
      const reportTranslationProgress = createProgressReporter(targets.length);
      const targetsByText = new Map();
      const appliedTargets = new Set();

      targets.forEach((target) => {
        const key = getTranslationKey(target.original);
        const groupedTargets = targetsByText.get(key) || [];
        groupedTargets.push(target);
        targetsByText.set(key, groupedTargets);
      });

      function applyTranslatedChunk(translatedChunk) {
        translatedChunk.forEach((translated, sourceText) => {
          const groupedTargets = targetsByText.get(sourceText) || [];

          groupedTargets.forEach((target) => {
            if (appliedTargets.has(target)) {
              return;
            }

            appliedTargets.add(target);
            if (translated && applyTranslation(target, translated)) {
              appliedCount += 1;
            }
          });
        });

        reportTranslationProgress(appliedTargets.size, appliedCount, true);
      }

      const translatedByText = await translateUniqueTexts(targets, (completed, total) => {
        const estimatedCompletedTargets = Math.round((completed / total) * targets.length);
        reportTranslationProgress(Math.max(appliedTargets.size, estimatedCompletedTargets), appliedCount);
      }, applyTranslatedChunk);

      targets.forEach((target, index) => {
        if (appliedTargets.has(target)) {
          return;
        }

        const translated = translatedByText.get(getTranslationKey(target.original));

        if (translated && applyTranslation(target, translated)) {
          appliedCount += 1;
        }

        appliedTargets.add(target);
        reportTranslationProgress(index + 1, appliedCount);
      });

      reportTranslationProgress(targets.length, appliedCount, true);

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

  function nodeMayContainChinese(node) {
    if (!node) {
      return false;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return CHINESE_TEXT.test(node.nodeValue || "");
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    const element = node;
    if (isElementSkipped(element)) {
      return false;
    }

    if (CHINESE_TEXT.test(element.textContent || "")) {
      return true;
    }

    return TRANSLATABLE_ATTRIBUTES.some((attribute) => {
      const value = element.getAttribute(attribute);
      return value && CHINESE_TEXT.test(value);
    });
  }

  function mutationsMayContainChinese(mutations) {
    return mutations.some((mutation) => {
      if (mutation.type === "characterData") {
        return nodeMayContainChinese(mutation.target);
      }

      return Array.from(mutation.addedNodes || []).some(nodeMayContainChinese);
    });
  }

  function startObserver() {
    if (observer || !document.documentElement) {
      return;
    }

    observer = new MutationObserver((mutations) => {
      if (!isTranslating && mutationsMayContainChinese(mutations)) {
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
