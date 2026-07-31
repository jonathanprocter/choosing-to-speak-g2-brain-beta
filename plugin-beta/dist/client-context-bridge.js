(function () {
  "use strict";

  if (window.__choosingToSpeakClientContextBridgeInstalled) return;
  window.__choosingToSpeakClientContextBridgeInstalled = true;

  var CONTEXT_KEY = "cts.clientContext.v1";
  var DISMISSED_KEY = "cts.dismissedCandidates.v1";
  var CANDIDATE_ROUTES = [
    "/v1/coach",
    "/v1/live_brain",
    "/v1/debrief",
    "/v1/coach_review",
    "/v1/question_cues",
    "/v1/client_candidate"
  ];
  var ui = null;
  var privatePanel = null;
  var currentCandidate = null;
  var lastCandidateResult = null;
  var candidateTimer = null;

  function runtime() {
    return window.VelvetSpeakAlphaRuntime || window.__VELVETSPEAK_ALPHA_RUNTIME__ || {};
  }

  function backendBaseUrl() {
    return String(runtime().backendBaseUrl || "").replace(/\/+$/, "");
  }

  function authToken() {
    return String(runtime().sessionAuthToken || "").trim();
  }

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }

  function readJson(key, fallback) {
    try {
      var raw = window.localStorage && window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      window.localStorage && window.localStorage.setItem(key, JSON.stringify(value));
    } catch (_error) {}
  }

  function removeJson(key) {
    try {
      window.localStorage && window.localStorage.removeItem(key);
    } catch (_error) {}
  }

  function getContext() {
    return readJson(CONTEXT_KEY, null);
  }

  function setContext(value, options) {
    var source = isRecord(value) ? value : {};
    var clientId = clean(source.clientId || source.client_id || "");
    var displayName = clean(source.displayName || source.clientName || source.name || "");
    if (!clientId && displayName) clientId = "manual-" + hashText(displayName).slice(0, 16);
    if (!displayName && clientId) displayName = clientId;
    if (!clientId && !displayName) return null;
    var context = Object.assign({}, source, {
      clientId: clientId,
      displayName: displayName,
      selectedAt: new Date().toISOString(),
      source: clean(source.source || "client-context-bridge")
    });
    writeJson(CONTEXT_KEY, context);
    window.dispatchEvent(new CustomEvent("choosingToSpeakClientContextChanged", { detail: context }));
    if (!options || options.sync !== false) syncClientContext(context);
    hideCandidateUi();
    return context;
  }

  function clearContext() {
    removeJson(CONTEXT_KEY);
    window.dispatchEvent(new CustomEvent("choosingToSpeakClientContextChanged", { detail: null }));
    renderPrivateDashboard();
  }

  function dismissedForToday() {
    var date = easternDate(new Date());
    var store = readJson(DISMISSED_KEY, {});
    var list = Array.isArray(store[date]) ? store[date] : [];
    return { date: date, store: store, list: list };
  }

  function dismissCandidate(candidate) {
    var target = candidate || currentCandidate;
    if (!target) return;
    var state = dismissedForToday();
    var id = clean(target.clientId || target.displayName);
    if (id && state.list.indexOf(id) < 0) state.list.push(id);
    state.store[state.date] = state.list.slice(-24);
    writeJson(DISMISSED_KEY, state.store);
    clearContext();
    hideCandidateUi();
    refreshCandidate();
  }

  function mergeContextIntoBody(body) {
    if (!isRecord(body)) return body;
    var context = getContext();
    var dismissed = dismissedForToday().list;
    var additions = {
      at: new Date().toISOString(),
      dismissedClientIds: dismissed
    };
    if (context) {
      additions.clientId = context.clientId;
      additions.clientName = context.displayName;
      additions.clientContext = context;
    }
    var next = Object.assign({}, body, additions);
    if (isRecord(body.input)) {
      next.input = Object.assign({}, body.input, additions);
    }
    return next;
  }

  function shouldPatchFetch(input) {
    try {
      var url = new URL(typeof input === "string" ? input : input.url, window.location.href);
      return CANDIDATE_ROUTES.some(function (route) {
        return url.pathname.replace(/\/+$/, "") === route;
      });
    } catch (_error) {
      return false;
    }
  }

  function installFetchPatch() {
    if (typeof window.fetch !== "function" || window.__choosingToSpeakFetchPatched) return;
    window.__choosingToSpeakFetchPatched = true;
    var originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      if (!shouldPatchFetch(input)) return originalFetch(input, init);
      var nextInit = Object.assign({}, init || {});
      var body = nextInit.body;
      if (!body && typeof Request !== "undefined" && input instanceof Request) body = input.body;
      if (typeof body !== "string") return originalFetch(input, init);
      try {
        nextInit.body = JSON.stringify(mergeContextIntoBody(JSON.parse(body)));
      } catch (_error) {
        return originalFetch(input, init);
      }
      return originalFetch(input, nextInit);
    };
  }

  function parseUrlContext() {
    try {
      var params = new URLSearchParams(window.location.search || "");
      var encoded = params.get("clientContext");
      if (encoded) {
        var decoded = decodeContextParam(encoded);
        if (decoded) return decoded;
      }
      var displayName = clean(params.get("clientName") || params.get("name"));
      var clientId = clean(params.get("clientId"));
      if (!displayName && !clientId) return null;
      return {
        clientId: clientId,
        displayName: displayName,
        lensId: clean(params.get("lensId") || params.get("activeLensId") || "clinical"),
        summary: clean(params.get("clientSummary")),
        bestQuestions: clean(params.get("clientQuestion") || params.get("question")),
        goal: clean(params.get("clientGoal")),
        source: "url"
      };
    } catch (_error) {
      return null;
    }
  }

  function decodeContextParam(value) {
    var text = clean(value);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_jsonError) {
      try {
        return JSON.parse(atob(text));
      } catch (_base64Error) {
        return null;
      }
    }
  }

  async function apiPost(route, body) {
    var base = backendBaseUrl();
    var token = authToken();
    if (!base || !token) return null;
    try {
      var response = await fetch(base + route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify(body || {})
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (_error) {
      return null;
    }
  }

  function syncClientContext(context) {
    if (!context) return Promise.resolve(null);
    if (!hasPrepContext(context)) {
      return Promise.resolve(null);
    }
    return apiPost("/v1/client_context", context);
  }

  async function uploadRoster(roster) {
    var result = await apiPost("/v1/day_roster", roster);
    refreshCandidate();
    renderPrivateDashboard();
    return result;
  }

  async function refreshCandidate() {
    if (candidateTimer) clearTimeout(candidateTimer);
    candidateTimer = null;
    if (getContext()) {
      renderPrivateDashboard();
      return null;
    }
    var params = new URLSearchParams(window.location.search || "");
    var result = await apiPost("/v1/client_candidate", {
      lensId: clean(params.get("lensId") || params.get("activeLensId") || "clinical"),
      at: new Date().toISOString(),
      dismissedClientIds: dismissedForToday().list
    });
    lastCandidateResult = result;
    currentCandidate = result && result.selected ? result.selected : null;
    if (currentCandidate) renderCandidateUi(currentCandidate);
    else hideCandidateUi();
    renderPrivateDashboard();
    return result;
  }

  function renderCandidateUi(candidate) {
    if (!document.body) return;
    if (!ui) {
      ui = document.createElement("div");
      ui.className = "cts-client-candidate";
      ui.innerHTML = [
        '<div class="cts-client-candidate__name"></div>',
        '<div class="cts-client-candidate__actions">',
        '<button type="button" data-cts-client-action="use">Use</button>',
        '<button type="button" data-cts-client-action="dismiss">No</button>',
        '<button type="button" data-cts-client-action="manual">Name</button>',
        '</div>'
      ].join("");
      ui.addEventListener("click", function (event) {
        var button = event.target && event.target.closest("[data-cts-client-action]");
        if (!button) return;
        var action = button.getAttribute("data-cts-client-action");
        if (action === "use") setContext(currentCandidate || candidate);
        if (action === "dismiss") dismissCandidate(currentCandidate || candidate);
        if (action === "manual") setManualName();
      });
      document.body.appendChild(ui);
      installCandidateStyles();
    }
    var name = ui.querySelector(".cts-client-candidate__name");
    if (name) name.textContent = "Today: " + candidate.displayName + candidateTimeSuffix(candidate);
    ui.hidden = false;
  }

  function hideCandidateUi() {
    if (ui) ui.hidden = true;
  }

  function setManualName() {
    var name = window.prompt ? window.prompt("Client name") : "";
    name = clean(name);
    if (!name) return;
    setContext({ displayName: name, lensId: "clinical", source: "manual" });
  }

  function candidateTimeSuffix(candidate) {
    var time = formatEasternTime(candidate && candidate.startsAt);
    return time ? " at " + time : "";
  }

  function formatEasternTime(value) {
    try {
      if (!value) return "";
      var date = new Date(value);
      if (!Number.isFinite(date.getTime())) return "";
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit"
      }).format(date);
    } catch (_error) {
      return "";
    }
  }

  function installPrivateUx() {
    installPrivateStyles();
    renderPrivateDashboard();
    hideAdminPanels();
    var observer = new MutationObserver(function () {
      hideAdminPanels();
      renderPrivateDashboard();
    });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function hideAdminPanels() {
    if (!document.body) return;
    var selectors = [
      ".account-devices-panel",
      ".account-connect-form",
      ".account-block[aria-label='Sign in']",
      ".account-block[aria-label='Connect this device']",
      ".account-block[aria-label='Active keys and usage']"
    ];
    selectors.forEach(function (selector) {
      document.querySelectorAll(selector).forEach(markHiddenAdmin);
    });
    ["Account & devices", "Paste the full key", "Beta app key", "Sign-in not configured", "Connect this device"].forEach(function (text) {
      findTextNodes(text).forEach(function (node) {
        var panel = closestPanel(node.parentElement);
        if (panel) markHiddenAdmin(panel);
      });
    });
  }

  function markHiddenAdmin(element) {
    if (!element || element === privatePanel) return;
    element.setAttribute("data-cts-private-hidden", "true");
  }

  function findTextNodes(text) {
    if (!document.body || !text) return [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var nodes = [];
    var node = null;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.indexOf(text) >= 0) nodes.push(node);
      if (nodes.length >= 12) break;
    }
    return nodes;
  }

  function closestPanel(element) {
    var node = element;
    while (node && node !== document.body) {
      if (node.getAttribute && node.getAttribute("data-cts-private-dashboard") === "true") return null;
      if (
        node.matches &&
        (node.matches("section") ||
          node.matches(".transcript-debug") ||
          node.matches(".account-block") ||
          node.matches(".account-connect-form"))
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function ensurePrivatePanel() {
    if (privatePanel && privatePanel.isConnected) return privatePanel;
    if (!document.body) return null;
    privatePanel = document.createElement("section");
    privatePanel.className = "transcript-debug cts-private-dashboard";
    privatePanel.setAttribute("data-cts-private-dashboard", "true");
    privatePanel.innerHTML = [
      '<div class="cts-private-dashboard__head">',
      '<div>',
      '<p class="cts-private-dashboard__eyebrow">Your default</p>',
      '<h3>Counselor Colleague</h3>',
      '<p class="cts-private-dashboard__sub">Transcript-first, max assist, clinical cues.</p>',
      '</div>',
      '<span class="cts-private-dashboard__badge">On</span>',
      '</div>',
      '<div class="cts-private-dashboard__grid">',
      '<div><span>Client</span><strong data-cts-private-client>Checking today...</strong></div>',
      '<div><span>Prep</span><strong data-cts-private-prep>Awaiting Notion prep</strong></div>',
      '<div><span>Calendar</span><strong>SimplePractice2, Eastern</strong></div>',
      '<div><span>Glasses</span><strong>Transcript default</strong></div>',
      '</div>',
      '<p class="cts-private-dashboard__brief" data-cts-private-brief></p>',
      '<div class="cts-private-dashboard__actions">',
      '<button type="button" data-cts-client-action="use">Use client</button>',
      '<button type="button" data-cts-client-action="dismiss">Dismiss</button>',
      '<button type="button" data-cts-client-action="manual">Name</button>',
      '<button type="button" data-cts-client-action="refresh">Refresh</button>',
      '</div>'
    ].join("");
    privatePanel.addEventListener("click", function (event) {
      var button = event.target && event.target.closest("[data-cts-client-action]");
      if (!button) return;
      var action = button.getAttribute("data-cts-client-action");
      if (action === "use") setContext(currentCandidate || (lastCandidateResult && lastCandidateResult.selected));
      if (action === "dismiss") dismissCandidate(currentCandidate || (lastCandidateResult && lastCandidateResult.selected));
      if (action === "manual") setManualName();
      if (action === "refresh") refreshCandidate();
    });
    var anchor = document.querySelector(".account-devices-panel") || document.querySelector("[aria-label='Account & devices']");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(privatePanel, anchor);
    else document.getElementById("root")?.appendChild(privatePanel) || document.body.appendChild(privatePanel);
    return privatePanel;
  }

  function renderPrivateDashboard() {
    var panel = ensurePrivatePanel();
    if (!panel) return;
    var selectedContext = getContext();
    var candidate = selectedContext || currentCandidate || (lastCandidateResult && lastCandidateResult.selected);
    var hints = Array.isArray(lastCandidateResult && lastCandidateResult.contextHints)
      ? lastCandidateResult.contextHints
      : [];
    var clientText = candidate
      ? clean(candidate.displayName || candidate.clientName || candidate.name || candidate.clientId) + candidateTimeSuffix(candidate)
      : "No client selected yet";
    var prepText = hints.length
      ? hints.length + " prep hint" + (hints.length === 1 ? "" : "s") + " loaded"
      : hasPrepContext(selectedContext)
        ? "Prep loaded"
        : "Waiting for Notion prep";
    var brief = selectedContext && (selectedContext.summary || selectedContext.bestQuestions || selectedContext.goal || previousNotesBrief(selectedContext))
      ? clean(selectedContext.summary || selectedContext.bestQuestions || selectedContext.goal || previousNotesBrief(selectedContext))
      : hints[0] || "Client suggestions appear here from today's SimplePractice2 roster. Dismiss or name manually when the match is wrong.";
    var clientNode = panel.querySelector("[data-cts-private-client]");
    var prepNode = panel.querySelector("[data-cts-private-prep]");
    var briefNode = panel.querySelector("[data-cts-private-brief]");
    if (clientNode) clientNode.textContent = clientText;
    if (prepNode) prepNode.textContent = prepText;
    if (briefNode) briefNode.textContent = truncateText(brief, 180);
    panel.dataset.hasClient = candidate ? "true" : "false";
  }

  function truncateText(text, max) {
    var value = clean(text);
    return value.length <= max ? value : value.slice(0, Math.max(0, max - 1)).trimEnd() + "...";
  }

  function hasPrepContext(context) {
    return Boolean(context && (
      context.summary ||
      context.items ||
      context.bestQuestions ||
      context.questionsToAsk ||
      context.questionCues ||
      context.goal ||
      context.risks ||
      context.previousSessionNotes ||
      context.previousNotes ||
      context.recentSessionNotes ||
      context.recentNotes ||
      context.notionSessionNotes ||
      context.notionNotes
    ));
  }

  function previousNotesBrief(context) {
    var notes = []
      .concat(Array.isArray(context && context.previousSessionNotes) ? context.previousSessionNotes : [])
      .concat(Array.isArray(context && context.previousNotes) ? context.previousNotes : [])
      .concat(Array.isArray(context && context.recentSessionNotes) ? context.recentSessionNotes : [])
      .concat(Array.isArray(context && context.recentNotes) ? context.recentNotes : [])
      .concat(Array.isArray(context && context.notionSessionNotes) ? context.notionSessionNotes : [])
      .concat(Array.isArray(context && context.notionNotes) ? context.notionNotes : []);
    for (var index = 0; index < notes.length && index < 5; index += 1) {
      var note = notes[index];
      var text = typeof note === "string"
        ? note
        : isRecord(note)
          ? note.summary || note.sessionSummary || note.clinicalSummary || note.note || note.notes || note.text || note.content || note.title || note.name
          : "";
      text = clean(text);
      if (text) return text;
    }
    return "";
  }

  function ensureDefaultQueryParams() {
    try {
      var url = new URL(window.location.href);
      var defaults = {
        activeLensId: "custom",
        lens: "custom",
        assistLevel: "6",
        assistFrequency: "high",
        autoOpenConfidence: "0.86",
        cueDelivery: "auto",
        answerDelivery: "coaching",
        answerLength: "medium",
        maxLongPages: "3",
        liveMicSource: "g2Mic"
      };
      var changed = false;
      Object.keys(defaults).forEach(function (key) {
        if (url.searchParams.get(key) !== defaults[key]) {
          url.searchParams.set(key, defaults[key]);
          changed = true;
        }
      });
      if (changed) window.history.replaceState(window.history.state, "", url.toString());
    } catch (_error) {}
  }

  function installCandidateStyles() {
    if (document.getElementById("cts-client-candidate-style")) return;
    var style = document.createElement("style");
    style.id = "cts-client-candidate-style";
    style.textContent = [
      ".cts-client-candidate{position:fixed;left:8px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:2147483647;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:1px solid rgba(255,255,255,.18);background:rgba(18,24,22,.94);color:#f4f7f4;font:13px/1.25 system-ui,-apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.28)}",
      ".cts-client-candidate[hidden]{display:none}",
      ".cts-client-candidate__name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".cts-client-candidate__actions{display:flex;gap:6px;flex:0 0 auto}",
      ".cts-client-candidate button{appearance:none;border:1px solid rgba(255,255,255,.22);background:#24302b;color:#f4f7f4;border-radius:6px;padding:5px 8px;font:inherit}",
      ".cts-client-candidate button:first-child{background:#d7efe1;color:#13211a;border-color:#d7efe1}"
    ].join("");
    document.head.appendChild(style);
  }

  function installPrivateStyles() {
    if (document.getElementById("cts-private-dashboard-style")) return;
    var style = document.createElement("style");
    style.id = "cts-private-dashboard-style";
    style.textContent = [
      "[data-cts-private-hidden='true']{display:none!important}",
      ".cts-private-dashboard{border:1px solid rgba(218,241,232,.13);background:rgba(19,26,23,.86);color:#ecf8f0;margin:18px 0;padding:16px;border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.18)}",
      ".cts-private-dashboard__head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}",
      ".cts-private-dashboard__eyebrow{margin:0 0 3px;color:#91a49b;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}",
      ".cts-private-dashboard h3{margin:0;color:#f0fff6;font-size:22px;line-height:1.08}",
      ".cts-private-dashboard__sub{margin:5px 0 0;color:#a7b8b0;font-size:14px;line-height:1.35}",
      ".cts-private-dashboard__badge{border:1px solid rgba(64,191,166,.52);color:#8fe7d4;border-radius:999px;padding:4px 10px;font-weight:700;font-size:12px;white-space:nowrap}",
      ".cts-private-dashboard__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0}",
      ".cts-private-dashboard__grid div{min-width:0;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.03);border-radius:6px;padding:10px}",
      ".cts-private-dashboard__grid span{display:block;color:#91a49b;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}",
      ".cts-private-dashboard__grid strong{display:block;color:#ecf8f0;font-size:14px;line-height:1.25;overflow-wrap:anywhere}",
      ".cts-private-dashboard__brief{margin:10px 0 0;color:#b9c9c1;font-size:14px;line-height:1.38}",
      ".cts-private-dashboard__actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:14px}",
      ".cts-private-dashboard button{appearance:none;border:1px solid rgba(255,255,255,.15);background:#202b27;color:#ecf8f0;border-radius:6px;padding:8px 6px;font:700 13px/1.2 system-ui,-apple-system,BlinkMacSystemFont,sans-serif}",
      ".cts-private-dashboard button:first-child{background:#d8efe1;color:#102018;border-color:#d8efe1}",
      ".cts-private-dashboard[data-has-client='false'] button:first-child{opacity:.56}",
      "@media (max-width:420px){.cts-private-dashboard{margin:14px 0;padding:14px}.cts-private-dashboard__grid{grid-template-columns:1fr}.cts-private-dashboard__actions{grid-template-columns:repeat(2,minmax(0,1fr))}.cts-private-dashboard h3{font-size:20px}}"
    ].join("");
    document.head.appendChild(style);
  }

  function easternDate(date) {
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    var map = {};
    parts.forEach(function (part) { map[part.type] = part.value; });
    return map.year + "-" + map.month + "-" + map.day;
  }

  function hashText(text) {
    var hash = 5381;
    for (var index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
    }
    return (hash >>> 0).toString(16);
  }

  function handleMessage(payload) {
    var message = isRecord(payload && payload.data) ? payload.data : payload;
    if (!isRecord(message)) return;
    if (message.type === "choosing_to_speak.client_context") setContext(message.payload || message.context || message);
    if (message.type === "choosing_to_speak.day_roster" || message.type === "choosing_to_speak.google_calendar_day") {
      uploadRoster(message.payload || message.roster || message.events || message);
    }
    if (message.type === "choosing_to_speak.client_candidate.dismiss") dismissCandidate(message.payload || currentCandidate);
    if (message.type === "choosing_to_speak.client_candidate.refresh") refreshCandidate();
  }

  ensureDefaultQueryParams();
  installFetchPatch();
  window.addEventListener("message", handleMessage);
  window.addEventListener("choosingToSpeakClientContext", function (event) {
    setContext(event.detail || {});
  });
  window.addEventListener("choosingToSpeakDayRoster", function (event) {
    uploadRoster(event.detail || {});
  });

  window.ChoosingToSpeakClientContext = {
    get: getContext,
    set: setContext,
    clear: clearContext,
    dismiss: dismissCandidate,
    refreshCandidate: refreshCandidate,
    status: function () {
      return {
        clientContext: getContext(),
        currentCandidate: currentCandidate,
        candidateResult: lastCandidateResult,
        dismissedClientIds: dismissedForToday().list
      };
    },
    sync: syncClientContext,
    uploadRoster: uploadRoster,
    uploadClientContext: function (context) {
      var next = setContext(context, { sync: false });
      return syncClientContext(next);
    }
  };

  var urlContext = parseUrlContext();
  if (urlContext) setContext(urlContext);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      installPrivateUx();
      candidateTimer = setTimeout(refreshCandidate, 1200);
    }, { once: true });
  } else {
    installPrivateUx();
    candidateTimer = setTimeout(refreshCandidate, 1200);
  }
}());
