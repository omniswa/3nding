/*
 * 3NDING end-of-book panel: one tidy closing card with
 * "share this book" actions and a "next on the shelf" suggestion.
 * Replaces the old finish-card (share.js) and next-up (engage.js) blocks.
 * Load AFTER share.js on reader.html.
 */
(function () {
  "use strict";
  const surface = document.getElementById("readerSurface");
  const bookId = new URLSearchParams(location.search).get("id");
  if (!surface || !bookId) return;

  const PREFIX = "3nding:progress:";
  const DONE = 98;
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

  const style = document.createElement("style");
  style.textContent = `
.end-panel{margin-top:3rem;padding:2.2rem 1.4rem 1.6rem;text-align:center;color:var(--read-fg,#2a241c);background:rgba(184,146,63,.08);border:1px solid var(--read-line,rgba(42,36,28,.14));border-radius:10px;animation:endIn .6s ease both}
@keyframes endIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.end-rule{display:flex;align-items:center;gap:.8rem;margin:0 auto 1.2rem;max-width:220px}
.end-rule::before,.end-rule::after{content:"";flex:1;height:1px;background:var(--read-line,rgba(42,36,28,.25))}
.end-rule span{width:7px;height:7px;transform:rotate(45deg);background:var(--brass,#b8923f)}
.end-title{font-family:"Fraunces",serif;font-style:italic;font-weight:500;font-size:1.5rem;line-height:1.2;margin:0 0 .5rem}
.end-lede{margin:0 auto 1.3rem;max-width:34ch;font-size:.92rem;line-height:1.55;color:var(--read-fg-soft,#5c5342)}
.end-share{display:flex;flex-wrap:wrap;gap:.6rem;justify-content:center;margin-bottom:1.8rem}
.end-btn{font-family:"Space Mono",monospace;font-size:.78rem;min-height:44px;padding:0 1.15rem;border-radius:999px;border:1px solid var(--read-line,rgba(42,36,28,.25));background:transparent;color:inherit;cursor:pointer;transition:background .15s ease,border-color .15s ease}
.end-btn:hover{border-color:var(--brass,#b8923f)}
.end-btn-main{background:var(--brass,#b8923f);border-color:var(--brass,#b8923f);color:#171b21;font-weight:600}
.end-btn-main:hover{background:var(--brass-bright,#d4ac57);border-color:var(--brass-bright,#d4ac57)}
.end-next{display:flex;align-items:center;gap:1.1rem;text-align:left;padding:.9rem;border-radius:8px;text-decoration:none;color:inherit;background:var(--read-bg,#f2e9d3);border:1px solid var(--read-line,rgba(42,36,28,.14));box-shadow:0 10px 24px -16px rgba(0,0,0,.55);transition:transform .2s ease,box-shadow .2s ease}
.end-next:hover{transform:translateY(-2px);box-shadow:0 14px 28px -14px rgba(0,0,0,.6)}
.end-cover{position:relative;flex-shrink:0;width:76px;height:102px;border-radius:3px;overflow:hidden;background:#e7dcc0;box-shadow:0 6px 14px -6px rgba(0,0,0,.6)}
.end-cover img{width:100%;height:100%;object-fit:cover;display:block}
.end-cover::after{content:"";position:absolute;top:0;right:9px;width:10px;height:22px;background:var(--brass,#b8923f);clip-path:polygon(0 0,100% 0,100% 100%,50% 76%,0 100%)}
.end-next-body{display:flex;flex-direction:column;gap:.15rem;min-width:0}
.end-kicker{font-family:"Space Mono",monospace;font-size:.7rem;color:var(--read-fg-soft,#5c5342)}
.end-next-title{font-family:"Fraunces",serif;font-weight:600;font-size:1.1rem;line-height:1.25}
.end-next-author{font-size:.84rem;color:var(--read-fg-soft,#5c5342)}
.end-go{margin-top:.5rem;font-family:"Space Mono",monospace;font-size:.76rem;font-weight:600;border-bottom:1px solid var(--brass,#b8923f);align-self:flex-start;padding-bottom:1px}
.end-btn:focus-visible,.end-next:focus-visible{outline:2px solid var(--brass-bright,#d4ac57);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.end-panel{animation:none}.end-next{transition:none}}
@media (max-width:420px){.end-cover{width:64px;height:86px}}
`;
  document.head.appendChild(style);

  let booksP = null;
  const loadBooks = () =>
    booksP ||
    (booksP = fetch("books.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((b) => (Array.isArray(b) ? b : []))
      .catch(() => []));

  function readProgress() {
    const out = new Map();
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(PREFIX)) continue;
        try {
          out.set(k.slice(PREFIX.length), JSON.parse(localStorage.getItem(k)));
        } catch {}
      }
    } catch {}
    return out;
  }
  const isDone = (p) =>
    !!p && typeof p.percent === "number" && p.percent >= DONE;

  async function build(nav) {
    const list = await loadBooks();
    if (!nav.isConnected || surface.querySelector(".end-panel")) return;

    const me = list.find((b) => String(b.id) === String(bookId)) || {
      id: bookId,
      title: (document.getElementById("topbarTitle") || {}).textContent || "",
      author: "",
    };
    const prog = readProgress();
    const others = list.filter((b) => String(b.id) !== String(bookId));
    const fresh = others.filter((b) => !prog.has(String(b.id)));
    const pool = fresh.length
      ? fresh
      : others.filter((b) => !isDone(prog.get(String(b.id))));
    const pick = pool.length
      ? pool[Math.floor(Math.random() * pool.length)]
      : null;

    const panel = document.createElement("section");
    panel.className = "end-panel";
    panel.setAttribute("aria-labelledby", "endTitle");
    panel.innerHTML =
      '<div class="end-rule" aria-hidden="true"><span></span></div>' +
      '<h2 class="end-title" id="endTitle">You reached the last page.</h2>' +
      '<p class="end-lede">Know someone who&rsquo;d enjoy this one? Send it their way or read another book?</p>' +
      '<div class="end-share">' +
      '<button type="button" class="end-btn end-btn-main" data-share>Share this book</button>' +
      '<button type="button" class="end-btn" data-copy>Copy link</button></div>' +
      (pick
        ? '<a class="end-next" href="reader.html?id=' +
          encodeURIComponent(pick.id) +
          '"><span class="end-cover"><img src="' +
          esc(pick.cover) +
          '" alt="" width="76" height="102" loading="lazy"></span>' +
          '<span class="end-next-body"><span class="end-kicker">Next on the shelf</span>' +
          '<span class="end-next-title">' +
          esc(pick.title) +
          '</span><span class="end-next-author">by ' +
          esc(pick.author) +
          '</span><span class="end-go">Start reading</span></span></a>'
        : "");

    const link = new URL(
      "reader.html?id=" + encodeURIComponent(bookId) + "&ref=share",
      location.href,
    ).href;

    panel.querySelector("[data-share]").addEventListener("click", () => {
      if (window.Share) window.Share.open(me);
    });
    const copyBtn = panel.querySelector("[data-copy]");
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(link);
        copyBtn.textContent = "Link copied";
      } catch {
        if (window.Share) window.Share.open(me);
        return;
      }
      setTimeout(() => (copyBtn.textContent = "Copy link"), 2000);
    });

    nav.insertAdjacentElement("afterend", panel);
  }

  new MutationObserver(() => {
    const next = document.getElementById("nextBtn");
    const nav = surface.querySelector(".chapter-nav");
    if (!next || !nav || !next.disabled || nav.dataset.endPanel) return;
    nav.dataset.endPanel = "1";
    build(nav);
  }).observe(surface, { childList: true });
})();
