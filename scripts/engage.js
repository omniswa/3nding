/*
 * 3NDING engagement module (additive; no changes to index.js / reader.js)
 *
 * Catalog (index.html):
 *   - "Finished" shelf
 *   - "New" badge on books whose books.json entry has  "added": "YYYY-MM-DD"
 *   - "Surprise me" button
 *   - Reading streak line
 *   - Per-card "save offline" toggle
 *   - "Add to home screen" prompt (after the 2nd visit)
 *   - "Request a book" footer link
 * Reader (reader.html):
 *   - Records reading days for the streak
 *   - "Next on the shelf" suggestion on the last chapter
 *
 * All data stays in localStorage / Cache Storage on the device.
 */
(function () {
  "use strict";

  const PROGRESS_PREFIX = "3nding:progress:";
  const STREAK_KEY = "3nding:streak";
  const VISITS_KEY = "3nding:visits";
  const INSTALL_KEY = "3nding:install-dismissed";
  const COUNTED_KEY = "3nding:visit-counted";
  const BOOK_CACHE = "3nding-books"; // must match sw.js
  const FINISHED_PERCENT = 98;
  const NEW_DAYS = 14;
  const FINISHED_MAX = 6;
  const REQUEST_EMAIL = "omniswacreate@gmail.com";

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );

  // ---------- styles ----------
  const style = document.createElement("style");
  style.textContent = `
.new-badge{position:absolute;left:.4rem;top:.4rem;z-index:2;font-family:"Space Mono",monospace;font-size:.62rem;background:var(--moss,#48594f);color:#f2e9d3;padding:.15rem .45rem;border-radius:2px}
.streak{font-family:"Space Mono",monospace;font-size:.78rem;color:var(--brass-bright,#d4ac57);margin:0 0 1.2rem}
.streak[hidden]{display:none}
.offline-btn{position:relative;z-index:2;font-family:"Space Mono",monospace;font-size:.7rem;line-height:1;color:var(--moss,#48594f);background:none;border:1px solid rgba(72,89,79,.4);border-radius:2px;padding:.15rem .35rem;cursor:pointer}
.offline-btn:hover{border-color:var(--brass,#b8923f);color:var(--brass,#b8923f)}
.offline-btn[data-saved="true"]{background:var(--moss,#48594f);color:#f2e9d3;border-color:var(--moss,#48594f)}
.offline-btn:disabled{opacity:.5;cursor:default}
.offline-btn:focus-visible,.install-banner button:focus-visible,.next-up a:focus-visible{outline:2px solid var(--brass-bright,#d4ac57);outline-offset:2px}
.install-banner{position:fixed;left:50%;bottom:max(1rem,env(safe-area-inset-bottom));transform:translateX(-50%);width:min(440px,calc(100vw - 2rem));z-index:25;display:flex;flex-wrap:wrap;gap:.6rem;padding:.9rem 1rem;background:#1f2530;color:#ece4d1;border:1px solid rgba(184,146,63,.35);border-radius:2px;box-shadow:0 8px 24px -8px rgba(0,0,0,.6);font:.8rem/1.5 "Space Mono",monospace}
.install-banner p{flex:1 1 100%;margin:0}
.install-banner button{flex:1;min-height:44px;font:inherit;color:inherit;background:transparent;border:1px solid rgba(184,146,63,.35);border-radius:2px;cursor:pointer}
.install-banner button.primary{background:#b8923f;border-color:#b8923f;color:#171b21;font-weight:600}
.next-up{display:flex;gap:1rem;align-items:center;margin-top:1.5rem;padding:1rem 1.1rem;border:1px dashed var(--read-line,rgba(42,36,28,.25));border-radius:2px;color:var(--read-fg,#2a241c)}
.next-up img{width:54px;height:72px;object-fit:cover;flex-shrink:0;background:#e7dcc0}
.next-up h2{font-family:"Fraunces",serif;font-style:italic;font-weight:500;font-size:1.05rem;margin:0 0 .15rem}
.next-up p{margin:0 0 .5rem;font-size:.85rem;color:var(--read-fg-soft,#5c5342)}
.next-up a{font-family:"Space Mono",monospace;font-size:.78rem;color:inherit;border-bottom:1px dotted currentColor;text-decoration:none}
`;
  document.head.appendChild(style);

  // ---------- shared data helpers ----------
  let booksPromise = null;
  const loadBooks = () =>
    booksPromise ||
    (booksPromise = fetch("books.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((b) => (Array.isArray(b) ? b : []))
      .catch(() => []));

  function readProgress() {
    const out = new Map();
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(PROGRESS_PREFIX)) continue;
        try {
          const p = JSON.parse(localStorage.getItem(k));
          if (p && Number.isFinite(p.updatedAt))
            out.set(k.slice(PROGRESS_PREFIX.length), p);
        } catch {}
      }
    } catch {}
    return out;
  }

  const isFinished = (p) =>
    !!p && typeof p.percent === "number" && p.percent >= FINISHED_PERCENT;

  // ---------- reading streak (local only) ----------
  const dayKey = (d) =>
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0");

  function readDays() {
    try {
      const a = JSON.parse(localStorage.getItem(STREAK_KEY) || "[]");
      return Array.isArray(a)
        ? a.filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x))
        : [];
    } catch {
      return [];
    }
  }

  function markToday() {
    const today = dayKey(new Date());
    const days = readDays();
    if (days.includes(today)) return;
    days.push(today);
    try {
      localStorage.setItem(STREAK_KEY, JSON.stringify(days.slice(-60)));
    } catch {}
  }

  function currentStreak() {
    const set = new Set(readDays());
    const d = new Date();
    if (!set.has(dayKey(d))) d.setDate(d.getDate() - 1); // today not read yet: streak still alive
    let n = 0;
    while (set.has(dayKey(d))) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }

  // =====================================================================
  //  CATALOG PAGE
  // =====================================================================
  const grid = $("grid");
  const continueShelf = $("continueShelf");

  if (grid && continueShelf) {
    const searchInput = $("searchInput");
    const favToggle = $("favToggle");
    let books = [];
    let savedUrls = new Set();

    // --- streak line ---
    const streakEl = document.createElement("p");
    streakEl.className = "streak";
    streakEl.hidden = true;
    continueShelf.insertAdjacentElement("beforebegin", streakEl);

    // --- finished shelf (reuses the .continue styles from index.css) ---
    const finishedShelf = document.createElement("section");
    finishedShelf.className = "continue";
    finishedShelf.hidden = true;
    finishedShelf.setAttribute("aria-labelledby", "finishedTitle");
    finishedShelf.innerHTML =
      '<h2 class="continue-title" id="finishedTitle">Finished</h2><ul class="continue-list"></ul>';
    continueShelf.insertAdjacentElement("afterend", finishedShelf);
    const finishedList = finishedShelf.querySelector("ul");

    const filtering = () =>
      (favToggle && favToggle.getAttribute("aria-pressed") === "true") ||
      (searchInput && searchInput.value.trim() !== "");

    function renderStreak() {
      const n = currentStreak();
      streakEl.hidden = n < 2;
      streakEl.textContent = n + " days in a row";
    }

    function renderFinished() {
      finishedList.replaceChildren();
      const progress = readProgress();
      const done = filtering()
        ? []
        : books
            .filter((b) => isFinished(progress.get(String(b.id))))
            .sort(
              (a, b) =>
                progress.get(String(b.id)).updatedAt -
                progress.get(String(a.id)).updatedAt,
            )
            .slice(0, FINISHED_MAX);
      finishedShelf.hidden = done.length === 0;
      done.forEach((b) => {
        const li = document.createElement("li");
        li.className = "continue-item";
        li.innerHTML =
          '<img class="continue-cover" src="' +
          esc(b.cover) +
          '" alt="" width="48" height="64" loading="lazy">' +
          '<div class="continue-body"><a class="continue-link" href="reader.html?id=' +
          encodeURIComponent(b.id) +
          '">' +
          esc(b.title) +
          '</a><span class="continue-meta">Finished \u00B7 read again</span></div>';
        finishedList.appendChild(li);
      });
    }

    // --- "New" badge + offline toggle on each card ---
    function isNew(b) {
      if (!b.added) return false;
      const t = Date.parse(b.added);
      if (!Number.isFinite(t)) return false;
      const age = (Date.now() - t) / 864e5;
      return age >= -1 && age <= NEW_DAYS;
    }

    const zipUrl = (b) =>
      new URL(b.zip || "books/" + b.id + ".zip", location.href).href;
    const canCache = "caches" in window;

    async function refreshSaved() {
      if (!canCache) return;
      try {
        const cache = await caches.open(BOOK_CACHE);
        savedUrls = new Set((await cache.keys()).map((r) => r.url));
      } catch {}
    }

    function paintOffline(btn, b) {
      const saved = savedUrls.has(zipUrl(b));
      btn.dataset.saved = String(saved);
      btn.textContent = saved ? "\u2713" : "\u2193";
      btn.title = saved
        ? "Saved for offline. Tap to remove."
        : "Save for offline reading";
      btn.setAttribute(
        "aria-label",
        (saved ? "Remove offline copy of " : "Save offline: ") + b.title,
      );
    }

    async function toggleOffline(btn, b) {
      const url = zipUrl(b);
      btn.disabled = true;
      try {
        const cache = await caches.open(BOOK_CACHE);
        if (savedUrls.has(url)) {
          await cache.delete(url);
          savedUrls.delete(url);
        } else {
          btn.textContent = "\u2026";
          const res = await fetch(url);
          if (!res.ok) throw new Error("HTTP " + res.status);
          await cache.put(url, res);
          savedUrls.add(url);
        }
      } catch {
        btn.title = "Couldn't save. Check your connection.";
      }
      btn.disabled = false;
      paintOffline(btn, b);
    }

    function decorateCards() {
      if (!books.length) return;
      grid.querySelectorAll(".card:not(.skeleton)").forEach((card) => {
        const link = card.querySelector(".card-link");
        if (!link) return;
        const id = new URL(link.href, location.href).searchParams.get("id");
        const b = books.find((x) => String(x.id) === String(id));
        if (!b) return;

        const wrap = card.querySelector(".cover-wrap");
        if (wrap && isNew(b) && !wrap.querySelector(".new-badge")) {
          const badge = document.createElement("span");
          badge.className = "new-badge";
          badge.textContent = "new";
          wrap.appendChild(badge);
        }

        const slip = card.querySelector(".slip");
        if (canCache && slip && !slip.querySelector(".offline-btn")) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "offline-btn";
          paintOffline(btn, b);
          btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleOffline(btn, b);
          });
          slip.appendChild(btn);
        }
      });
    }

    // --- surprise me ---
    function addSurprise() {
      const anchor = $("favRow") || document.querySelector(".search-row");
      if (!anchor || $("surpriseBtn")) return;
      const row = document.createElement("div");
      row.className = "fav-row";
      row.innerHTML =
        '<span class="setting-label">Feeling lucky</span>' +
        '<button type="button" class="opt-btn" id="surpriseBtn">Surprise me</button>';
      anchor.insertAdjacentElement("afterend", row);
      $("surpriseBtn").addEventListener("click", () => {
        const progress = readProgress();
        let pool = books.filter((b) => !progress.has(String(b.id)));
        if (!pool.length)
          pool = books.filter((b) => !isFinished(progress.get(String(b.id))));
        if (!pool.length) pool = books;
        const pick = pool[Math.floor(Math.random() * pool.length)];
        if (pick)
          location.href = "reader.html?id=" + encodeURIComponent(pick.id);
      });
    }

    // --- request a book (footer) ---
    const footer = document.querySelector("footer");
    if (footer) {
      const sep = document.createElement("span");
      sep.setAttribute("aria-hidden", "true");
      sep.textContent = " \u00B7 ";
      const a = document.createElement("a");
      a.className = "footer-link";
      a.href =
        "mailto:" +
        REQUEST_EMAIL +
        "?subject=" +
        encodeURIComponent("3NDING book request");
      a.textContent = "request a book";
      footer.append(sep, a);
    }

    // --- install prompt ---
    let deferredInstall = null;
    let visits = 0;
    try {
      visits = parseInt(localStorage.getItem(VISITS_KEY) || "0", 10) || 0;
      if (!sessionStorage.getItem(COUNTED_KEY)) {
        visits += 1;
        localStorage.setItem(VISITS_KEY, String(visits));
        sessionStorage.setItem(COUNTED_KEY, "1");
      }
    } catch {}

    function maybeShowInstall() {
      if (!deferredInstall || visits < 2) return;
      if (matchMedia("(display-mode: standalone)").matches) return;
      try {
        const t = parseInt(localStorage.getItem(INSTALL_KEY) || "0", 10);
        if (t && Date.now() - t < 30 * 864e5) return;
      } catch {}
      if (document.querySelector(".install-banner")) return;
      const bar = document.createElement("div");
      bar.className = "install-banner";
      bar.setAttribute("role", "status");
      bar.innerHTML =
        "<p>Add 3NDING to your home screen to open it like an app and read offline.</p>" +
        '<button type="button" class="primary" data-yes>Add</button>' +
        '<button type="button" data-no>Not now</button>';
      bar.querySelector("[data-yes]").addEventListener("click", async () => {
        bar.remove();
        try {
          deferredInstall.prompt();
          await deferredInstall.userChoice;
        } catch {}
        deferredInstall = null;
      });
      bar.querySelector("[data-no]").addEventListener("click", () => {
        try {
          localStorage.setItem(INSTALL_KEY, String(Date.now()));
        } catch {}
        bar.remove();
      });
      document.body.appendChild(bar);
    }

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredInstall = e;
      maybeShowInstall();
    });

    // --- wiring ---
    function refresh() {
      renderStreak();
      renderFinished();
    }

    if (searchInput) searchInput.addEventListener("input", renderFinished);
    if (favToggle) favToggle.addEventListener("click", renderFinished);
    window.addEventListener("3nding:cloud-updated", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("storage", refresh);
    new MutationObserver(decorateCards).observe(grid, { childList: true });

    Promise.all([loadBooks(), refreshSaved()]).then(([list]) => {
      books = list;
      refresh();
      decorateCards();
      addSurprise();
    });
  }

  // =====================================================================
  //  READER PAGE
  // =====================================================================
  const surface = $("readerSurface");
  const bookId = new URLSearchParams(location.search).get("id");

  if (surface && bookId) {
    window.addEventListener("3nding:progress-changed", markToday);

    async function pickNext() {
      const list = await loadBooks();
      const progress = readProgress();
      const others = list.filter((b) => String(b.id) !== String(bookId));
      const fresh = others.filter((b) => !progress.has(String(b.id)));
      const pool = fresh.length
        ? fresh
        : others.filter((b) => !isFinished(progress.get(String(b.id))));
      return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    }

    new MutationObserver(async () => {
      const next = $("nextBtn");
      const nav = surface.querySelector(".chapter-nav");
      if (!next || !nav || !next.disabled || surface.querySelector(".next-up"))
        return;

      const pick = await pickNext();
      if (!pick || !nav.isConnected || surface.querySelector(".next-up"))
        return;

      const card = document.createElement("div");
      card.className = "next-up";
      card.innerHTML =
        '<img src="' +
        esc(pick.cover) +
        '" alt="" width="54" height="72" loading="lazy">' +
        "<div><h2>Next on the shelf</h2><p>" +
        esc(pick.title) +
        " by " +
        esc(pick.author) +
        "</p>" +
        '<a href="reader.html?id=' +
        encodeURIComponent(pick.id) +
        '">Start reading</a></div>';
      const after = surface.querySelector(".finish-card") || nav;
      after.insertAdjacentElement("afterend", card);
    }).observe(surface, { childList: true });
  }
})();
