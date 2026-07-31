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
  var currentCandidate = null;
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
    if (!context.summary && !context.items && !context.bestQuestions && !context.questionsToAsk && !context.questionCues) {
      return Promise.resolve(null);
    }
    return apiPost("/v1/client_context", context);
  }

  async function uploadRoster(roster) {
    var result = await apiPost("/v1/day_roster", roster);
    refreshCandidate();
    return result;
  }

  async function refreshCandidate() {
    if (candidateTimer) clearTimeout(candidateTimer);
    candidateTimer = null;
    if (getContext()) return null;
    var params = new URLSearchParams(window.location.search || "");
    var result = await apiPost("/v1/client_candidate", {
      lensId: clean(params.get("lensId") || params.get("activeLensId") || "clinical"),
      at: new Date().toISOString(),
      dismissedClientIds: dismissedForToday().list
    });
    currentCandidate = result && result.selected ? result.selected : null;
    if (currentCandidate) renderCandidateUi(currentCandidate);
    else hideCandidateUi();
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
    if (name) name.textContent = "Likely: " + candidate.displayName;
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
    if (message.type === "choosing_to_speak.day_roster") uploadRoster(message.payload || message.roster || message);
    if (message.type === "choosing_to_speak.client_candidate.dismiss") dismissCandidate(message.payload || currentCandidate);
    if (message.type === "choosing_to_speak.client_candidate.refresh") refreshCandidate();
  }

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
      candidateTimer = setTimeout(refreshCandidate, 1200);
    }, { once: true });
  } else {
    candidateTimer = setTimeout(refreshCandidate, 1200);
  }
}());
