// ==UserScript==
// @name         Instagram Oldest Posts (v2.8) — backward date-fill + resilient + UI
// @namespace    provereno-media
// @version      2.8
// @description  Collects Instagram profile post history: DOM seeding for initially rendered posts + backward pagination (before/last) to recover their dates + forward pagination (after/first), resilient to failures, dedup by shortcode, with a UI panel.
// @match        https://www.instagram.com/*
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEY = "ig_oldest_posts_state_v2";

  const ESSENTIAL_FIELDS = [
    "av", "__user", "__a", "__d",
    "doc_id", "variables",
    "fb_dtsg", "jazoest", "lsd",
    "server_timestamps",
    "fb_api_caller_class", "fb_api_req_friendly_name",
  ];

  if (!window.__igHookInstalled) {
    window.__igHookInstalled = true;
    window._igXHR = window._igXHR || null;
    const oldOpen = XMLHttpRequest.prototype.open;
    const oldSend = XMLHttpRequest.prototype.send;
    const oldSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method, url) {
      this._igMethod = method;
      this._igUrl = url;
      this._igHeaders = {};
      return oldOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      this._igHeaders[name] = value;
      return oldSetHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (
          this._igUrl &&
          this._igUrl.includes("/graphql/query") &&
          typeof body === "string" &&
          body.includes("PolarisProfilePostsTabContentQuery_connection")
        ) {
          window._igXHR = {
            url: this._igUrl,
            method: this._igMethod,
            headers: { ...this._igHeaders },
            body,
            capturedAt: Date.now(),
          };
          IGTool.log("XHR captured", "ok");
          IGTool.setState("captured");
        }
      } catch (e) {
        IGTool.log("Hook error: " + e.message, "err");
      }
      return oldSend.apply(this, arguments);
    };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (base) => base + Math.random() * base * 0.5;

  function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || null;
    } catch {
      return null;
    }
  }

  function buildMinimalParams(fullParams) {
    const minimal = new URLSearchParams();
    for (const key of ESSENTIAL_FIELDS) {
      if (fullParams.has(key)) minimal.set(key, fullParams.get(key));
    }
    return minimal;
  }

  // Collect posts already rendered by Instagram on initial page load
  // (SSR / initial hydration) — these never go through XHR. Match by
  // substring (href*=), since links may be absolute
  // ("https://www.instagram.com/p/CODE/").
  function scrapeDomPosts() {
    const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
    const seen = new Map();
    links.forEach((a) => {
      let href;
      try {
        href = a.href;
      } catch {
        href = a.getAttribute("href") || "";
      }
      const m = href.match(/\/(?:p|reel)\/([^/?#]+)/);
      if (!m) return;
      const code = m[1];
      if (!seen.has(code)) {
        seen.set(code, {
          code,
          id: null,
          taken_at: null,
          url: "https://www.instagram.com/p/" + code + "/",
        });
      }
    });

    if (seen.size === 0) {
      const allLinks = [...document.querySelectorAll("a[href]")]
        .map((a) => a.href)
        .filter((h) => h && !h.includes("javascript:"))
        .slice(0, 15);
      IGTool.log("DOM: 0 matches. Sample of the first links on the page (for diagnostics):", "warn");
      allLinks.forEach((h) => IGTool.log("  " + h, "info"));
    }

    return [...seen.values()];
  }

  async function fetchWithRetry(url, opts, { maxRetries = 5, baseDelay = 2500 } = {}) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res;
      try {
        res = await fetch(url, opts);
      } catch (netErr) {
        if (attempt === maxRetries) throw netErr;
        const wait = jitter(baseDelay * 2 ** attempt);
        IGTool.log(`Network error, retrying in ${Math.round(wait)} ms (attempt ${attempt + 1})`, "warn");
        await sleep(wait);
        continue;
      }
      if (res.status === 429 || res.status === 503) {
        if (attempt === maxRetries) return res;
        const retryAfterHeader = res.headers.get("Retry-After");
        const wait = retryAfterHeader
          ? Number(retryAfterHeader) * 1000
          : jitter(baseDelay * 2 ** attempt);
        IGTool.log(`HTTP ${res.status}, backoff ${Math.round(wait)} ms (attempt ${attempt + 1})`, "warn");
        await sleep(wait);
        continue;
      }
      return res;
    }
  }

  function mergeByCode(list) {
    const map = new Map();
    for (const p of list) {
      const existing = map.get(p.code);
      if (!existing || (!existing.taken_at && p.taken_at)) map.set(p.code, p);
    }
    return [...map.values()];
  }

  // Backward pagination (before/last) — ask the same connection for posts
  // located BEFORE the current cursor (i.e. newer ones) to get their
  // taken_at via the API instead of date-less DOM scraping.
  async function fetchBackwardDates(req, headers, fullParams, afterCursor, count, useMinimalBody) {
    const vars = JSON.parse(fullParams.get("variables"));
    const backwardVars = {
      ...vars,
      after: null,
      first: null,
      before: afterCursor,
      last: count,
    };

    let params;
    if (useMinimalBody) {
      params = buildMinimalParams(fullParams);
    } else {
      params = new URLSearchParams(fullParams);
    }
    params.set("variables", JSON.stringify(backwardVars));

    const res = await fetchWithRetry(req.url, {
      method: req.method || "POST",
      credentials: "include",
      headers,
      body: params.toString(),
    });

    if (!res || !res.ok) {
      IGTool.log(`Backward pagination: HTTP error (${res?.status ?? "network"})`, "warn");
      return [];
    }

    const j = await res.json();
    const c = j?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
    if (!c) {
      IGTool.log("Backward pagination: unexpected response format.", "warn");
      return [];
    }

    return (c.edges || []).map((e) => ({
      code: e.node.code,
      id: e.node.id,
      taken_at: e.node.taken_at || null,
      url: "https://www.instagram.com/p/" + e.node.code + "/",
    }));
  }

  async function collect({ minDelay = 1800, maxDelay = 4500, useMinimalBody = true } = {}) {
    if (!window._igXHR) {
      IGTool.log("No captured request. Scroll the profile feed first.", "err");
      return;
    }

    const saved = loadState();
    const req = window._igXHR;
    let headers = { ...req.headers };
    let fullParams = new URLSearchParams(req.body);
    let originalVars = JSON.parse(fullParams.get("variables"));
    const originalAfterCursor = originalVars.after;
    let cursor = saved?.cursor ?? originalVars.after;
    let posts = saved?.posts ?? [...(window.__igDomPosts || [])];
    let page = saved?.page ?? 0;
    let consecutiveErrors = 0;
    let lastClaim = headers["x-ig-www-claim"] || null;

    IGTool.setState("running");
    IGTool.log(
      saved
        ? `Resuming from page ${page}`
        : `Starting collection (DOM-seeded: ${window.__igDomPosts?.length || 0})`,
      "ok"
    );

    // If this is the very first start (not a resume) and there are DOM posts
    // without dates — try to fill their dates via backward pagination first.
    if (!saved && posts.some((p) => !p.taken_at) && originalAfterCursor) {
      const needCount = posts.filter((p) => !p.taken_at).length;
      IGTool.log(`Trying to fetch dates for ${needCount} DOM posts via backward pagination (before/last)...`, "info");
      try {
        const backward = await fetchBackwardDates(req, headers, fullParams, originalAfterCursor, needCount, useMinimalBody);
        if (backward.length) {
          const byCode = new Map(backward.map((p) => [p.code, p]));
          posts = posts.map((p) => (!p.taken_at && byCode.has(p.code) ? { ...p, ...byCode.get(p.code) } : p));
          const filled = posts.filter((p) => p.taken_at).length;
          IGTool.log(`Backward pagination returned ${backward.length} posts. Dates now available for ${filled} of ${posts.length}.`, "ok");
        } else {
          IGTool.log("Backward pagination returned no data — dates for DOM posts will remain empty.", "warn");
        }
      } catch (e) {
        IGTool.log("Backward pagination error: " + e.message, "warn");
      }
      await sleep(jitter(minDelay));
    }

    while (IGTool.running) {
      page++;
      const vars = { ...originalVars, after: cursor };

      let params;
      if (useMinimalBody) {
        params = buildMinimalParams(fullParams);
      } else {
        params = new URLSearchParams(fullParams);
      }
      params.set("variables", JSON.stringify(vars));

      const res = await fetchWithRetry(req.url, {
        method: req.method || "POST",
        credentials: "include",
        headers,
        body: params.toString(),
      });

      if (!res || !res.ok) {
        consecutiveErrors++;
        IGTool.log(`Page ${page}: HTTP error (${res?.status ?? "network"})`, "err");
        saveState({ cursor, posts, page: page - 1 });
        if (consecutiveErrors >= 3) {
          IGTool.log("3 consecutive errors — stopping. State saved, you can resume.", "err");
          IGTool.setState("stopped");
          return;
        }
        await sleep(jitter(5000));
        continue;
      }
      consecutiveErrors = 0;

      const freshClaim = res.headers.get("x-ig-set-www-claim");
      if (freshClaim && freshClaim !== lastClaim) {
        headers = { ...headers, "x-ig-www-claim": freshClaim };
        lastClaim = freshClaim;
      }

      const j = await res.json();
      const c = j?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
      if (!c) {
        IGTool.log("Unexpected response format — Instagram may have changed the API.", "err");
        saveState({ cursor, posts, page: page - 1 });
        IGTool.setState("stopped");
        return;
      }

      const edgesCount = c.edges?.length || 0;
      for (const e of c.edges || []) {
        const n = e.node;
        posts.push({
          code: n.code,
          id: n.id,
          taken_at: n.taken_at || null,
          url: "https://www.instagram.com/p/" + n.code + "/",
        });
      }

      IGTool.updateProgress(page, posts.length);

      const hasNext = !!c.page_info?.has_next_page;
      const nextCursor = c.page_info?.end_cursor;

      IGTool.log(`Page ${page}: received ${edgesCount}, has_next_page=${hasNext}, end_cursor=${nextCursor ? "present" : "empty"}`, "info");

      if (!hasNext) {
        IGTool.log("Reached the end of pagination (has_next_page=false).", "ok");
        saveState({ cursor, posts, page });
        break;
      }
      if (!nextCursor) {
        IGTool.log("has_next_page=true, but end_cursor is empty. Stopping with state saved.", "warn");
        saveState({ cursor, posts, page });
        break;
      }

      cursor = nextCursor;
      saveState({ cursor, posts, page });
      await sleep(jitter(minDelay + Math.random() * (maxDelay - minDelay)));
    }

    const rawCount = posts.length;
    posts = mergeByCode(posts);
    window.IG_POSTS = posts;
    IGTool.updateProgress(page, posts.length);
    IGTool.setState("done");
    if (rawCount !== posts.length) {
      IGTool.log(`Dedup by shortcode: had ${rawCount} records, ${posts.length} unique.`, "warn");
    }
    const withDate = posts.filter((p) => p.taken_at).length;
    IGTool.log(`Collection paused. Total unique: ${posts.length} (with date: ${withDate}, without date: ${posts.length - withDate})`, "ok");
    IGTool.showPreview(posts);
  }

  function exportCSV(posts) {
    const dated = posts.filter((x) => x.taken_at).sort((a, b) => Number(a.taken_at) - Number(b.taken_at));
    const undated = posts.filter((x) => !x.taken_at);
    const rows = [...dated, ...undated];
    const csv = [
      ["date", "time", "code", "url"],
      ...rows.map((x) => {
        if (!x.taken_at) return ["", "", x.code, x.url];
        const d = new Date(Number(x.taken_at) * 1000);
        return [d.toLocaleDateString("sv-SE"), d.toLocaleTimeString("sv-SE"), x.code, x.url];
      }),
    ]
      .map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(","))
      .join("\n");
    downloadBlob(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" }), "instagram_posts.csv");
  }

  function exportJSON(posts) {
    downloadBlob(
      new Blob([JSON.stringify(posts, null, 2)], { type: "application/json" }),
      "instagram_posts.json"
    );
  }

  function downloadBlob(blob, filename) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  }

  async function autoScrollUntilCaptured({ maxSteps = 40, stepDelay = 900 } = {}) {
    IGTool.log("Auto-scrolling: waiting for XHR capture...", "ok");
    for (let i = 0; i < maxSteps; i++) {
      if (window._igXHR) return true;
      window.scrollBy(0, window.innerHeight * 1.2);
      await sleep(jitter(stepDelay));
    }
    return !!window._igXHR;
  }

  const IGTool = {
    running: false,
    _el: null,
    useMinimalBody: true,
    init() {
      if (this._el) return;
      const el = document.createElement("div");
      el.id = "ig-oldest-posts-panel";
      el.style.cssText =
        "position:fixed;bottom:16px;right:16px;z-index:999999;width:340px;background:#111;color:#eee;" +
        "font:12px/1.4 monospace;border-radius:10px;padding:10px;box-shadow:0 4px 20px rgba(0,0,0,.5)";
      el.innerHTML = `
        <div style="font-weight:bold;margin-bottom:6px">IG Oldest Posts v2.8</div>
        <div id="ig-status" style="margin-bottom:6px">Status: idle</div>
        <div id="ig-progress" style="margin-bottom:6px">Pages: 0 · Posts: 0</div>
        <div id="ig-domcount" style="margin-bottom:6px;color:#9ad">DOM seed: not scanned</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">
          <button id="ig-btn-dom">0. Scan DOM</button>
          <button id="ig-btn-scroll">1. Auto-scroll + capture</button>
          <button id="ig-btn-collect">2. Collect</button>
          <button id="ig-btn-stop">Stop</button>
          <button id="ig-btn-csv">CSV</button>
          <button id="ig-btn-json">JSON</button>
          <button id="ig-btn-resume">Resume</button>
          <button id="ig-btn-reset">New capture</button>
        </div>
        <div id="ig-log" style="max-height:140px;overflow:auto;border-top:1px solid #333;padding-top:4px"></div>
      `;
      document.body.appendChild(el);
      this._el = el;

      el.querySelector("#ig-btn-dom").onclick = () => {
        window.__igDomPosts = scrapeDomPosts();
        el.querySelector("#ig-domcount").textContent = `DOM seed: ${window.__igDomPosts.length} posts (before scrolling)`;
        this.log(`Scanned from DOM (before scrolling): ${window.__igDomPosts.length} posts`, "ok");
      };
      el.querySelector("#ig-btn-scroll").onclick = () => autoScrollUntilCaptured();
      el.querySelector("#ig-btn-collect").onclick = () => {
        this.running = true;
        collect({ useMinimalBody: this.useMinimalBody });
      };
      el.querySelector("#ig-btn-resume").onclick = () => {
        this.running = true;
        collect({ useMinimalBody: this.useMinimalBody });
      };
      el.querySelector("#ig-btn-stop").onclick = () => {
        this.running = false;
        this.setState("stopped");
      };
      el.querySelector("#ig-btn-reset").onclick = () => {
        this.running = false;
        localStorage.removeItem(STORAGE_KEY);
        window._igXHR = null;
        window.IG_POSTS = null;
        window.__igDomPosts = null;
        el.querySelector("#ig-domcount").textContent = "DOM seed: not scanned";
        this.updateProgress(0, 0);
        this.setState("idle");
        this.log("State cleared. Scan the DOM again (before scrolling), then capture a new XHR.", "ok");
      };
      el.querySelector("#ig-btn-csv").onclick = () =>
        window.IG_POSTS ? exportCSV(window.IG_POSTS) : this.log("No data to export", "err");
      el.querySelector("#ig-btn-json").onclick = () =>
        window.IG_POSTS ? exportJSON(window.IG_POSTS) : this.log("No data to export", "err");
    },
    setState(s) {
      if (s === "running") this.running = true;
      const map = {
        captured: "request captured",
        running: "collecting...",
        stopped: "stopped (can be resumed)",
        done: "done / paused",
        idle: "idle (state cleared)",
      };
      this._el.querySelector("#ig-status").textContent = "Status: " + (map[s] || s);
    },
    updateProgress(page, total) {
      this._el.querySelector("#ig-progress").textContent = `Pages: ${page} · Posts: ${total}`;
    },
    log(msg, level = "info") {
      const colors = { ok: "#7CFC00", err: "#FF6B6B", warn: "#FFD93D", info: "#ccc" };
      const row = document.createElement("div");
      row.style.color = colors[level] || colors.info;
      row.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
      const box = this._el.querySelector("#ig-log");
      box.appendChild(row);
      box.scrollTop = box.scrollHeight;
    },
    showPreview(posts) {
      const dated = posts.filter((p) => p.taken_at);
      const sample = (dated.length ? dated : posts).slice(0, 5);
      console.table(sample);
    },
  };

  IGTool.init();
  window.IGTool = IGTool;
})();
