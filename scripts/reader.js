(function () {
  const params = new URLSearchParams(location.search);
  const bookId = params.get("id");

  const SETTINGS_KEY = "3nding:settings";
  const DEFAULT_SETTINGS = {
    font: "serif",
    size: 17,
    align: "left",
    theme: "paper",
  };
  const SIZE_MIN = 14,
    SIZE_MAX = 26,
    SIZE_STEP = 1;

  const MIN_SAVE_DELTA = 0.02; 
  const RESUME_PROMPT_DELTA = 0.03; 
  let lastSaved = null;

  const el = {
    surface: document.getElementById("readerSurface"),
    stateBox: document.getElementById("stateBox"),
    topbarTitle: document.getElementById("topbarTitle"),
    progressFill: document.getElementById("progressFill"),
    progressPct: document.getElementById("progressPct"),
    settingsBtn: document.getElementById("settingsBtn"),
    drawerCloseBtn: document.getElementById("drawerCloseBtn"),
    backLink: document.getElementById("backLink"),
    drawer: document.getElementById("drawer"),
    backdrop: document.getElementById("drawerBackdrop"),
    fontRow: document.getElementById("fontRow"),
    alignRow: document.getElementById("alignRow"),
    themeRow: document.getElementById("themeRow"),
    sizeValue: document.getElementById("sizeValue"),
    sizeUp: document.getElementById("sizeUp"),
    sizeDown: document.getElementById("sizeDown"),
    resetBtn: document.getElementById("resetBtn"),
  };

  let settings = loadSettings();
  let manifest = null;
  let bookMeta = null;
  let chapterIndex = 0;
  let saveTimer = null;
  let zip = null; 

  let isLoading = true;
  let persistDisabled = false; 
  let loadToken = 0; 
  let banner = null;

  function naturalSort(a, b) {
    return a.localeCompare(b, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  function escapeHtml(str) {
    return String(str).replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );
  }

  // ---------- settings persistence ----------
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
    window.dispatchEvent(new CustomEvent("3nding:settings-changed"));
  }

  function applySettings() {
    document.body.className = "theme-" + settings.theme;
    document.documentElement.style.setProperty(
      "--font-size",
      settings.size + "px",
    );
    document.documentElement.style.setProperty("--text-align", settings.align);

    const body = document.querySelector(".chapter-body");
    if (body) {
      body.classList.remove("font-serif", "font-sans", "font-mono");
      body.classList.add("font-" + settings.font);
    }

    [el.fontRow, el.alignRow, el.themeRow].forEach((row) => {
      row.querySelectorAll(".opt-btn").forEach((btn) => {
        btn.classList.toggle(
          "active",
          btn.dataset.value === settings[row.dataset.key],
        );
      });
    });
    el.sizeValue.textContent = settings.size;
  }

  function updateSetting(key, value) {
    settings[key] = value;
    saveSettings();
    applySettings();
  }

  el.fontRow.addEventListener("click", (e) => {
    const btn = e.target.closest(".opt-btn");
    if (!btn) return;
    updateSetting("font", btn.dataset.value);
  });
  el.alignRow.addEventListener("click", (e) => {
    const btn = e.target.closest(".opt-btn");
    if (!btn) return;
    updateSetting("align", btn.dataset.value);
  });
  el.themeRow.addEventListener("click", (e) => {
    const btn = e.target.closest(".opt-btn");
    if (!btn) return;
    updateSetting("theme", btn.dataset.value);
  });
  el.sizeUp.addEventListener("click", () => {
    updateSetting("size", Math.min(SIZE_MAX, settings.size + SIZE_STEP));
  });
  el.sizeDown.addEventListener("click", () => {
    updateSetting("size", Math.max(SIZE_MIN, settings.size - SIZE_STEP));
  });
  el.resetBtn.addEventListener("click", () => {
    settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    applySettings();
  });

  function openDrawer() {
    el.drawer.classList.add("open");
    el.backdrop.classList.add("visible");
    el.settingsBtn.classList.add("open");
    el.settingsBtn.setAttribute("aria-expanded", "true");
  }

  function closeDrawer() {
    el.drawer.classList.remove("open");
    el.backdrop.classList.remove("visible");
    el.settingsBtn.classList.remove("open");
    el.settingsBtn.setAttribute("aria-expanded", "false");
  }
  el.settingsBtn.addEventListener("click", () => {
    el.drawer.classList.contains("open") ? closeDrawer() : openDrawer();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && el.drawer.classList.contains("open"))
      closeDrawer();
  });
  el.backdrop.addEventListener("click", closeDrawer);
  el.drawerCloseBtn.addEventListener("click", closeDrawer);

  // ---------- progress persistence ----------
  function progressKey(id) {
    return "3nding:progress:" + id;
  }

  function loadProgress(id) {
    try {
      const raw = localStorage.getItem(progressKey(id));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveProgress(id, data) {
    try {
      localStorage.setItem(progressKey(id), JSON.stringify(data));
    } catch {}
    window.dispatchEvent(
      new CustomEvent("3nding:progress-changed", { detail: { bookId: id } }),
    );
  }

  function scrollFraction() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max <= 0) return 1;
    return Math.min(1, Math.max(0, window.scrollY / max));
  }

  function jumpTo(y) {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    window.scrollTo(0, y);
    root.style.scrollBehavior = previous;
  }

  function jumpToFraction(fraction) {
    const max = Math.max(
      0,
      document.documentElement.scrollHeight - window.innerHeight,
    );
    const f = Math.min(1, Math.max(0, Number(fraction) || 0));
    jumpTo(max * f);
    return window.scrollY;
  }

  function overallPercent() {
    const total = manifest.chapters.length;
    const pct = ((chapterIndex + scrollFraction()) / total) * 100;
    return Math.min(100, Math.max(0, pct));
  }

  function updateProgressUI() {
    if (!manifest) return;
    const pct = overallPercent();
    el.progressFill.style.width = pct + "%";
    el.progressPct.textContent = Math.round(pct) + "%";
  }

  function persistProgress(minDelta = MIN_SAVE_DELTA) {
    if (isLoading || persistDisabled || !manifest) return;
    const next = {
      chapterIndex,
      scrollFraction: scrollFraction(),
      updatedAt: Date.now(),
    };
    const base = lastSaved || { chapterIndex: 0, scrollFraction: 0 };
    if (
      base.chapterIndex === next.chapterIndex &&
      Math.abs(base.scrollFraction - next.scrollFraction) < minDelta
    )
      return;
    lastSaved = next;
    saveProgress(bookId, next);
  }

   let ticking = false;
   function onScroll() {
     if (isLoading || persistDisabled) return;
     if (!ticking) {
       ticking = true;
       requestAnimationFrame(() => {
         ticking = false;
         updateProgressUI();
       });
     }
     clearTimeout(saveTimer);
     saveTimer = setTimeout(persistProgress, 250);
   }

  // ---------- "newer progress elsewhere" prompt ----------
  function dismissBanner() {
    if (banner) {
      banner.remove();
      banner = null;
    }
  }

  function showResumeBanner(saved) {
    dismissBanner();
    const total = manifest.chapters.length;
    const chapterNo = Math.min(Math.max(saved.chapterIndex, 0), total - 1) + 1;

    banner = document.createElement("div");
    banner.className = "resume-banner";
    banner.setAttribute("role", "status");

    const msg = document.createElement("p");
    msg.textContent = `Newer progress from another device: chapter ${chapterNo} of ${total}.`;

    const go = document.createElement("button");
    go.type = "button";
    go.className = "resume-btn is-primary";
    go.textContent = "Continue there";
    go.addEventListener("click", () => {
      dismissBanner();
      loadChapter(saved.chapterIndex, true);
    });

    const stay = document.createElement("button");
    stay.type = "button";
    stay.className = "resume-btn";
    stay.textContent = "Stay here";
    stay.addEventListener("click", dismissBanner);

    banner.append(msg, go, stay);
    document.body.appendChild(banner);
  }

  window.addEventListener("3nding:cloud-updated", (e) => {
    if (e.detail && e.detail.settings) {
      settings = loadSettings();
      applySettings();
    }

    if (!manifest || isLoading) return;
    const saved = loadProgress(bookId);
    if (!saved) return;
    const knownAt = lastSaved ? lastSaved.updatedAt : 0;
    if (saved.updatedAt <= knownAt) return;
    lastSaved = saved;
    const differs =
      saved.chapterIndex !== chapterIndex ||
      Math.abs(saved.scrollFraction - scrollFraction()) > RESUME_PROMPT_DELTA;
    if (differs) showResumeBanner(saved);
  });
  window.addEventListener("3nding:signout-state", (e) => {
    persistDisabled = !!(e.detail && e.detail.active);
    if (persistDisabled) clearTimeout(saveTimer);
  });

  // ---------- rendering ----------
  function renderState(message) {
    el.surface.innerHTML = `<div class="state-box"><span class="dot"></span> ${message}</div>`;
  }

  function renderError(message) {
    el.surface.innerHTML = `<div class="state-box">${escapeHtml(message)}<br><br>
        <a href="index.html" class="nav-btn">Back to the archive</a></div>`;
  }

  function paragraphize(text) {
    return text
      .replace(/^\uFEFF/, "") 
      .replace(/\r\n?/g, "\n")
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${escapeHtml(p).replace(/\n/g, " ")}</p>`)
      .join("");
  }

  function isChapterFile(name) {
    return (
      /\.txt$/i.test(name) &&
      !zip.files[name].dir &&
      !/(^|\/)(__MACOSX\/|\.)/.test(name)
    );
  }

  async function loadChapter(index, restoreScroll) {
    const token = ++loadToken;
    isLoading = true;
    clearTimeout(saveTimer);
    dismissBanner();

    chapterIndex = Math.min(Math.max(index, 0), manifest.chapters.length - 1);
    const chapter = manifest.chapters[chapterIndex];
    renderState("Turning the page…");

    let text;
    try {
      const entry = zip.file(chapter.file);
      if (!entry) throw new Error(`"${chapter.file}" not found in the zip`);
      text = await entry.async("string");
    } catch (err) {
      if (token === loadToken)
        renderError(`This chapter couldn't be loaded (${err.message}).`);
      return; 
    }
    if (token !== loadToken) return;

    const total = manifest.chapters.length;
    const options = manifest.chapters
      .map(
        (c, i) =>
          `<option value="${i}" ${i === chapterIndex ? "selected" : ""}>${escapeHtml(c.title || "Chapter " + (i + 1))}</option>`,
      )
      .join("");

    el.surface.innerHTML = `
        <div class="reader-page">
          <div class="chapter-eyebrow">Chapter ${chapterIndex + 1} of ${total}</div>
          <h1 class="chapter-title">${escapeHtml(chapter.title || "Chapter " + (chapterIndex + 1))}</h1>
          <div class="chapter-body font-${settings.font}">${paragraphize(text)}</div>
          <div class="chapter-nav">
            <button class="nav-btn" id="prevBtn" ${chapterIndex === 0 ? "disabled" : ""}>Prev</button>
            <select class="chapter-select" id="chapterSelect" aria-label="Jump to chapter">${options}</select>
            <button class="nav-btn" id="nextBtn" ${chapterIndex === total - 1 ? "disabled" : ""}>Next</button>
          </div>
        </div>`;

    applySettings();

    document.getElementById("prevBtn").addEventListener("click", () => {
      loadChapter(chapterIndex - 1, false);
    });
    document.getElementById("nextBtn").addEventListener("click", () => {
      loadChapter(chapterIndex + 1, false);
    });
    document.getElementById("chapterSelect").addEventListener("change", (e) => {
      loadChapter(parseInt(e.target.value, 10), false);
    });

    let restoredY = null;
    let restoredFraction = 0;
    if (restoreScroll) {
      const saved = loadProgress(bookId);
      if (saved && saved.chapterIndex === chapterIndex) {
        restoredFraction = saved.scrollFraction || 0;
        restoredY = jumpToFraction(restoredFraction);
      } else {
        jumpTo(0);
      }
    } else {
      jumpTo(0);
    }

    updateProgressUI();
    isLoading = false; 
    persistProgress(); 

    if (restoredY !== null && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (token !== loadToken || isLoading) return;
        if (Math.abs(window.scrollY - restoredY) > 2) return;
        jumpToFraction(restoredFraction);
      });
    }
  }

  async function init() {
    if (!bookId) {
      renderError("No book was specified.");
      return;
    }

    try {
      const booksRes = await fetch("books.json", { cache: "no-cache" }).catch(
        () => null,
      );
      if (!booksRes || !booksRes.ok) {
        renderError("The archive's catalog couldn't be reached.");
        return;
      }
      const books = await booksRes.json();
      bookMeta = Array.isArray(books)
        ? books.find((b) => String(b.id) === String(bookId))
        : null;
      if (!bookMeta) {
        el.topbarTitle.textContent = "Not found";
        renderError("That book isn't in the archive.");
        return;
      }
      const fallbackTitle = bookMeta.title;

      renderState("Unpacking the book…");

      const zipPath = bookMeta.zip || `books/${bookMeta.id}.zip`;

      let zipRes;
      try {
        zipRes = await fetch(zipPath);
        if (!zipRes.ok) throw new Error(`HTTP ${zipRes.status}`);
      } catch (err) {
        el.topbarTitle.textContent = fallbackTitle;
        renderError(
          `"${fallbackTitle}" isn't on the archive yet — ${zipPath} couldn't be found.`,
        );
        return;
      }

      const buffer = await zipRes.arrayBuffer();
      zip = await JSZip.loadAsync(buffer);

      const manifestEntry = zip.file("manifest.json");
      if (manifestEntry) {
        manifest = JSON.parse(await manifestEntry.async("string"));
        manifest.chapters = Array.isArray(manifest.chapters)
          ? manifest.chapters.filter((c) => c && typeof c.file === "string")
          : [];
      } else {
        const chapterFiles = Object.keys(zip.files)
          .filter(isChapterFile)
          .sort(naturalSort);

        if (chapterFiles.length === 0) {
          el.topbarTitle.textContent = fallbackTitle;
          renderError(
            `"${fallbackTitle}"'s zip doesn't contain any .txt chapter files.`,
          );
          return;
        }

        manifest = {
          title: fallbackTitle,
          chapters: chapterFiles.map((file, i) => ({
            file,
            title: `Chapter ${i + 1}`,
          })),
        };
      }

      const title = manifest.title || fallbackTitle;
      el.topbarTitle.textContent = title;

      if (manifest.chapters.length === 0) {
        renderError(`"${title}" doesn't have any chapters yet.`);
        return;
      }

      applySettings();

      const saved = loadProgress(bookId);
      lastSaved = saved; 
      const startIndex = saved ? saved.chapterIndex : 0;
      await loadChapter(startIndex, true);

      window.addEventListener("scroll", onScroll, { passive: true });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") persistProgress(0.001);
      });
      window.addEventListener("pagehide", () => {
        clearTimeout(saveTimer);
        persistProgress(0.001);
      });
    } catch (err) {
      renderError(`Something went wrong (${err.message}).`);
    }
  }

  applySettings();
  init();
})();
