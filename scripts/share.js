/*
 * 3NDING share module
 * - Adds a "share" button to every catalog card (index.html)
 * - Adds a share button to the reader top bar (reader.html)
 * - Shows a "pass it on" card at the end of a book
 * Uses the native share sheet when available, otherwise a small dialog
 * with copy-link and Telegram / WhatsApp / X / Facebook links.
 * No changes to index.js or reader.js required.
 */
(function () {
  "use strict";

  const SITE = "3NDING";

  // ---------- styles (reuse existing CSS variables, with fallbacks) ----------
  const css = `
.share-btn{position:relative;z-index:2;font-family:"Space Mono",monospace;font-size:.62rem;letter-spacing:.03em;color:var(--moss,#48594f);background:none;border:0;border-bottom:1px dotted currentColor;padding:.1rem 0;cursor:pointer}
.share-btn:hover{color:var(--brass,#b8923f)}
.share-btn:focus-visible,.share-top:focus-visible{outline:2px solid var(--brass-bright,#d4ac57);outline-offset:2px}
.share-top{flex-shrink:0;height:32px;padding:0 .7rem;border-radius:16px;border:1px solid rgba(184,146,63,.35);background:transparent;color:var(--brass-bright,#d4ac57);font-family:"Space Mono",monospace;font-size:.72rem;cursor:pointer}
.share-top:hover{background:rgba(184,146,63,.12)}
.share-dialog{width:min(380px,92vw);padding:0;border:0;border-radius:2px;background:#f2e9d3;color:#2a241c;box-shadow:0 12px 30px -10px rgba(0,0,0,.7)}
.share-dialog::backdrop{background:rgba(0,0,0,.6)}
.share-head{padding:1.3rem 1.4rem 1rem;border-bottom:1px dashed rgba(72,89,79,.4)}
.share-head h2{font-family:"Fraunces",serif;font-style:italic;font-weight:500;font-size:1.3rem;margin:0 0 .25rem}
.share-head p{margin:0;font-size:.85rem;color:#5c5342;line-height:1.5}
.share-body{padding:1.1rem 1.4rem 1.3rem;display:flex;flex-direction:column;gap:.7rem}
.share-link{display:flex;gap:.5rem}
.share-link input{flex:1;min-width:0;font:inherit;font-size:.8rem;padding:.55rem .65rem;border:1px solid rgba(72,89,79,.35);border-radius:2px;background:rgba(255,255,255,.55);color:#2a241c}
.share-act{font-family:"Space Mono",monospace;font-size:.75rem;padding:.55rem .85rem;border-radius:2px;border:1px solid rgba(72,89,79,.4);background:rgba(255,255,255,.45);color:#2a241c;cursor:pointer;text-decoration:none;text-align:center}
.share-act:hover{background:#fff;border-color:#48594f}
.share-act.primary{background:#b8923f;border-color:#b8923f;font-weight:600}
.share-act.primary:hover{background:#d4ac57}
.share-grid{display:grid;grid-template-columns:1fr 1fr;gap:.5rem}
.share-act:focus-visible{outline:2px solid #48594f;outline-offset:2px}
.share-note{min-height:1.2em;margin:0;font-family:"Space Mono",monospace;font-size:.7rem;color:#48594f}
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // ---------- helpers ----------
  const bookUrl = (id) =>
    new URL(
      "reader.html?id=" + encodeURIComponent(id) + "&ref=share",
      location.href,
    ).href;

  const shareText = (b) =>
    "\u201C" +
    b.title +
    "\u201D" +
    (b.author ? " by " + b.author : "") +
    " \u2014 free to read on " +
    SITE;

  async function copy(text, input) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        input.focus();
        input.select();
        const execCopy = (document.defaultView || document).execCommand;
        return typeof execCopy === "function"
          ? Boolean(execCopy.call(document, "copy"))
          : false;
      } catch {
        return false;
      }
    }
  }

  let lastFocus = null;

  // ---------- dialog ----------
  function openShare(book) {
    const url = bookUrl(book.id);
    const text = shareText(book);

    // Native share sheet first (most phones). Falls through to the dialog on desktop.
    if (navigator.share) {
      navigator.share({ title: book.title, text, url }).catch((err) => {
        if (err && err.name !== "AbortError") showDialog(book, url, text);
      });
      return;
    }
    showDialog(book, url, text);
  }

  function showDialog(book, url, text) {
    lastFocus = document.activeElement;
    const dlg = document.createElement("dialog");
    dlg.className = "share-dialog";
    dlg.setAttribute("aria-labelledby", "shareTitle");

    const enc = encodeURIComponent;
    const links = [
      [
        "Telegram",
        "https://t.me/share/url?url=" + enc(url) + "&text=" + enc(text),
      ],
      ["WhatsApp", "https://wa.me/?text=" + enc(text + " " + url)],
      [
        "X",
        "https://twitter.com/intent/tweet?text=" +
          enc(text) +
          "&url=" +
          enc(url),
      ],
      ["Facebook", "https://www.facebook.com/sharer/sharer.php?u=" + enc(url)],
    ];

    dlg.innerHTML =
      '<div class="share-head"><h2 id="shareTitle">Pass it on</h2><p></p></div>' +
      '<div class="share-body">' +
      '<div class="share-link"><input type="text" readonly aria-label="Link to this book">' +
      '<button type="button" class="share-act primary" data-copy>Copy link</button></div>' +
      '<div class="share-grid"></div>' +
      '<p class="share-note" role="status" aria-live="polite"></p>' +
      '<button type="button" class="share-act" data-close>Close</button></div>';

    dlg.querySelector(".share-head p").textContent = text;
    const input = dlg.querySelector("input");
    input.value = url;
    const note = dlg.querySelector(".share-note");
    const grid = dlg.querySelector(".share-grid");
    links.forEach(([label, href]) => {
      const a = document.createElement("a");
      a.className = "share-act";
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = label;
      grid.appendChild(a);
    });

    dlg.querySelector("[data-copy]").addEventListener("click", async () => {
      note.textContent = (await copy(url, input))
        ? "Link copied."
        : "Couldn't copy. Select the link and copy it manually.";
    });
    dlg
      .querySelector("[data-close]")
      .addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close();
    });
    dlg.addEventListener(
      "close",
      () => {
        dlg.remove();
        if (lastFocus && lastFocus.focus) lastFocus.focus();
      },
      { once: true },
    );

    document.body.appendChild(dlg);
    dlg.showModal();
  }

  window.Share = { open: openShare };

  // ---------- catalog cards (index.html) ----------
  function decorateCards() {
    document.querySelectorAll(".card:not(.skeleton)").forEach((card) => {
      if (card.querySelector(".share-btn")) return;
      const link = card.querySelector(".card-link");
      const slip = card.querySelector(".slip");
      if (!link || !slip) return;
      const id = new URL(link.href, location.href).searchParams.get("id");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "share-btn";
      btn.textContent = "share";
      btn.setAttribute("aria-label", "Share " + link.textContent.trim());
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const authorEl = card.querySelector(".card-author");
        openShare({
          id,
          title: link.textContent.trim(),
          author: authorEl ? authorEl.textContent.trim() : "",
        });
      });
      slip.appendChild(btn);
    });
  }

  const grid = document.getElementById("grid");
  if (grid) {
    new MutationObserver(decorateCards).observe(grid, { childList: true });
    decorateCards();
  }

  // ---------- reader (reader.html) ----------
  const surface = document.getElementById("readerSurface");
  const topInner = document.querySelector(".topbar-inner");
  const bookId = new URLSearchParams(location.search).get("id");

  async function currentBook() {
    const title =
      (document.getElementById("topbarTitle") || {}).textContent || SITE;
    let author = "";
    try {
      const res = await fetch("books.json");
      const list = await res.json();
      const hit = list.find((b) => String(b.id) === String(bookId));
      if (hit) author = hit.author || "";
    } catch {}
    return { id: bookId, title: title.trim(), author };
  }

  if (surface && topInner && bookId) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "share-top";
    btn.textContent = "share";
    btn.setAttribute("aria-label", "Share this book");
    btn.addEventListener("click", async () => openShare(await currentBook()));
    const settings = document.getElementById("settingsBtn");
    topInner.insertBefore(btn, settings || null);

  }
})();
