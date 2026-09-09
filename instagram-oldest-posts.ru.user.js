// ==UserScript==
// @name         Instagram Oldest Posts (v2.8) — backward date-fill + resilient + UI
// @namespace    provereno-media
// @version      2.8
// @description  Собирает историю постов профиля Instagram: DOM-посев для начальных постов + обратная пагинация (before/last) для получения их дат + прямая пагинация (after/first), устойчива к сбоям, дедуп по shortcode, с UI-панелью.
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

  // Собираем посты, уже отрисованные Instagram при первичной загрузке страницы
  // (SSR / initial hydration) — они не проходят через XHR. Ищем по вхождению
  // (href*=), т.к. ссылки могут быть абсолютными ("https://www.instagram.com/p/CODE/").
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
      IGTool.log("DOM: 0 совпадений. Примеры первых ссылок на странице (для диагностики):", "warn");
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
        IGTool.log(`Сетевая ошибка, повтор через ${Math.round(wait)} мс (попытка ${attempt + 1})`, "warn");
        await sleep(wait);
        continue;
      }
      if (res.status === 429 || res.status === 503) {
        if (attempt === maxRetries) return res;
        const retryAfterHeader = res.headers.get("Retry-After");
        const wait = retryAfterHeader
          ? Number(retryAfterHeader) * 1000
          : jitter(baseDelay * 2 ** attempt);
        IGTool.log(`HTTP ${res.status}, backoff ${Math.round(wait)} мс (попытка ${attempt + 1})`, "warn");
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

  // Обратная пагинация (before/last) — просим у того же connection посты,
  // расположенные ДО текущего курсора (то есть более новые), чтобы получить
  // их taken_at через API вместо DOM-скрейпинга без дат.
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
      IGTool.log(`Обратная пагинация: HTTP ошибка (${res?.status ?? "network"})`, "warn");
      return [];
    }

    const j = await res.json();
    const c = j?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
    if (!c) {
      IGTool.log("Обратная пагинация: неожиданный формат ответа.", "warn");
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
      IGTool.log("Нет захваченного запроса. Сначала прокрутите ленту профиля.", "err");
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
        ? `Возобновление с страницы ${page}`
        : `Старт сбора (посевных из DOM: ${window.__igDomPosts?.length || 0})`,
      "ok"
    );

    // Если это самый первый старт (не резюме) и есть DOM-посты без дат —
    // сначала пробуем добрать их даты обратной пагинацией.
    if (!saved && posts.some((p) => !p.taken_at) && originalAfterCursor) {
      const needCount = posts.filter((p) => !p.taken_at).length;
      IGTool.log(`Пробуем получить даты для ${needCount} DOM-постов через обратную пагинацию (before/last)...`, "info");
      try {
        const backward = await fetchBackwardDates(req, headers, fullParams, originalAfterCursor, needCount, useMinimalBody);
        if (backward.length) {
          const byCode = new Map(backward.map((p) => [p.code, p]));
          posts = posts.map((p) => (!p.taken_at && byCode.has(p.code) ? { ...p, ...byCode.get(p.code) } : p));
          const filled = posts.filter((p) => p.taken_at).length;
          IGTool.log(`Обратная пагинация вернула ${backward.length} постов. Дат теперь у ${filled} из ${posts.length}.`, "ok");
        } else {
          IGTool.log("Обратная пагинация не вернула данных — даты для DOM-постов останутся пустыми.", "warn");
        }
      } catch (e) {
        IGTool.log("Ошибка обратной пагинации: " + e.message, "warn");
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
        IGTool.log(`Страница ${page}: HTTP ошибка (${res?.status ?? "network"})`, "err");
        saveState({ cursor, posts, page: page - 1 });
        if (consecutiveErrors >= 3) {
          IGTool.log("3 ошибки подряд — остановка. Состояние сохранено, можно возобновить.", "err");
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
        IGTool.log("Неожиданный формат ответа — возможно, Instagram изменил API.", "err");
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

      IGTool.log(`Страница ${page}: получено ${edgesCount}, has_next_page=${hasNext}, end_cursor=${nextCursor ? "есть" : "пусто"}`, "info");

      if (!hasNext) {
        IGTool.log("Достигнут конец пагинации (has_next_page=false).", "ok");
        saveState({ cursor, posts, page });
        break;
      }
      if (!nextCursor) {
        IGTool.log("has_next_page=true, но end_cursor пуст. Останов с сохранением состояния.", "warn");
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
      IGTool.log(`Дедупликация по shortcode: было ${rawCount} записей, уникальных — ${posts.length}.`, "warn");
    }
    const withDate = posts.filter((p) => p.taken_at).length;
    IGTool.log(`Пауза сбора. Всего уникальных: ${posts.length} (с датой: ${withDate}, без даты: ${posts.length - withDate})`, "ok");
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
    IGTool.log("Автоскролл: жду захвата XHR...", "ok");
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
        <div id="ig-status" style="margin-bottom:6px">Статус: ожидание</div>
        <div id="ig-progress" style="margin-bottom:6px">Страниц: 0 · Постов: 0</div>
        <div id="ig-domcount" style="margin-bottom:6px;color:#9ad">DOM-посев: не считан</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">
          <button id="ig-btn-dom">0. Считать DOM</button>
          <button id="ig-btn-scroll">1. Автоскролл+захват</button>
          <button id="ig-btn-collect">2. Собрать</button>
          <button id="ig-btn-stop">Стоп</button>
          <button id="ig-btn-csv">CSV</button>
          <button id="ig-btn-json">JSON</button>
          <button id="ig-btn-resume">Возобновить</button>
          <button id="ig-btn-reset">Новый захват</button>
        </div>
        <div id="ig-log" style="max-height:140px;overflow:auto;border-top:1px solid #333;padding-top:4px"></div>
      `;
      document.body.appendChild(el);
      this._el = el;

      el.querySelector("#ig-btn-dom").onclick = () => {
        window.__igDomPosts = scrapeDomPosts();
        el.querySelector("#ig-domcount").textContent = `DOM-посев: ${window.__igDomPosts.length} постов (без прокрутки)`;
        this.log(`Считано из DOM (до скролла): ${window.__igDomPosts.length} постов`, "ok");
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
        el.querySelector("#ig-domcount").textContent = "DOM-посев: не считан";
        this.updateProgress(0, 0);
        this.setState("idle");
        this.log("Состояние очищено. Считайте DOM заново (до скролла), затем захватите новый XHR.", "ok");
      };
      el.querySelector("#ig-btn-csv").onclick = () =>
        window.IG_POSTS ? exportCSV(window.IG_POSTS) : this.log("Нет данных для экспорта", "err");
      el.querySelector("#ig-btn-json").onclick = () =>
        window.IG_POSTS ? exportJSON(window.IG_POSTS) : this.log("Нет данных для экспорта", "err");
    },
    setState(s) {
      if (s === "running") this.running = true;
      const map = {
        captured: "запрос захвачен",
        running: "сбор идёт...",
        stopped: "остановлено (можно возобновить)",
        done: "готово / приостановлено",
        idle: "ожидание (состояние сброшено)",
      };
      this._el.querySelector("#ig-status").textContent = "Статус: " + (map[s] || s);
    },
    updateProgress(page, total) {
      this._el.querySelector("#ig-progress").textContent = `Страниц: ${page} · Постов: ${total}`;
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
