(function() {
  const params = new URLSearchParams(location.search);
  const bookId = params.get('id');
  
  const SETTINGS_KEY = '3nding:settings';
  const DEFAULT_SETTINGS = { font: 'serif', size: 17, align: 'left', theme: 'paper' };
  const SIZE_MIN = 14,
    SIZE_MAX = 26,
    SIZE_STEP = 1;
  
  const el = {
    surface: document.getElementById('readerSurface'),
    stateBox: document.getElementById('stateBox'),
    topbarTitle: document.getElementById('topbarTitle'),
    progressFill: document.getElementById('progressFill'),
    progressPct: document.getElementById('progressPct'),
    settingsBtn: document.getElementById('settingsBtn'),
    drawerCloseBtn: document.getElementById('drawerCloseBtn'),
    backLink: document.getElementById('backLink'),
    drawer: document.getElementById('drawer'),
    backdrop: document.getElementById('drawerBackdrop'),
    fontRow: document.getElementById('fontRow'),
    alignRow: document.getElementById('alignRow'),
    themeRow: document.getElementById('themeRow'),
    sizeValue: document.getElementById('sizeValue'),
    sizeUp: document.getElementById('sizeUp'),
    sizeDown: document.getElementById('sizeDown'),
    resetBtn: document.getElementById('resetBtn'),
  };
  
  let settings = loadSettings();
  let manifest = null;
  let bookMeta = null;
  let chapterIndex = 0;
  let saveTimer = null;
  let zip = null; // the loaded JSZip archive for this book
  
  function naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }
  
  // Escape any string before it goes into innerHTML, so chapter titles
  // and chapter text (which come from the book's zip/manifest) can
  // never be interpreted as markup.
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    } [ch]));
  }
  
  // ---------- settings persistence ----------
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch { return { ...DEFAULT_SETTINGS }; }
  }
  
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  }
  
  function applySettings() {
    document.body.className = 'theme-' + settings.theme;
    document.documentElement.style.setProperty('--font-size', settings.size + 'px');
    document.documentElement.style.setProperty('--text-align', settings.align);
    
    const body = document.querySelector('.chapter-body');
    if (body) {
      body.classList.remove('font-serif', 'font-sans', 'font-mono');
      body.classList.add('font-' + settings.font);
    }
    
    [el.fontRow, el.alignRow, el.themeRow].forEach(row => {
      row.querySelectorAll('.opt-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === settings[row.dataset.key]);
      });
    });
    el.sizeValue.textContent = settings.size;
  }
  
  function updateSetting(key, value) {
    settings[key] = value;
    saveSettings();
    applySettings();
  }
  
  el.fontRow.addEventListener('click', e => {
    const btn = e.target.closest('.opt-btn');
    if (!btn) return;
    updateSetting('font', btn.dataset.value);
  });
  el.alignRow.addEventListener('click', e => {
    const btn = e.target.closest('.opt-btn');
    if (!btn) return;
    updateSetting('align', btn.dataset.value);
  });
  el.themeRow.addEventListener('click', e => {
    const btn = e.target.closest('.opt-btn');
    if (!btn) return;
    updateSetting('theme', btn.dataset.value);
  });
  el.sizeUp.addEventListener('click', () => {
    updateSetting('size', Math.min(SIZE_MAX, settings.size + SIZE_STEP));
  });
  el.sizeDown.addEventListener('click', () => {
    updateSetting('size', Math.max(SIZE_MIN, settings.size - SIZE_STEP));
  });
  el.resetBtn.addEventListener('click', () => {
    settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    applySettings();
  });
  
  function openDrawer() {
    el.drawer.classList.add('open');
    el.backdrop.classList.add('visible');
    el.settingsBtn.classList.add('open');
    el.settingsBtn.setAttribute('aria-expanded', 'true');
  }
  
  function closeDrawer() {
    el.drawer.classList.remove('open');
    el.backdrop.classList.remove('visible');
    el.settingsBtn.classList.remove('open');
    el.settingsBtn.setAttribute('aria-expanded', 'false');
  }
  el.settingsBtn.addEventListener('click', () => {
    el.drawer.classList.contains('open') ? closeDrawer() : openDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.drawer.classList.contains('open')) closeDrawer();
  });
  el.backdrop.addEventListener('click', closeDrawer);
  el.drawerCloseBtn.addEventListener('click', closeDrawer);
  
  // ---------- progress persistence ----------
  function progressKey(id) { return '3nding:progress:' + id; }
  
  function loadProgress(id) {
    try {
      const raw = localStorage.getItem(progressKey(id));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  
  function saveProgress(id, data) {
    try { localStorage.setItem(progressKey(id), JSON.stringify(data)); } catch {}
  }
  
  function scrollFraction() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max <= 0) return 1;
    return Math.min(1, Math.max(0, window.scrollY / max));
  }
  
  function overallPercent() {
    const total = manifest.chapters.length;
    const pct = ((chapterIndex + scrollFraction()) / total) * 100;
    return Math.min(100, Math.max(0, pct));
  }
  
  function updateProgressUI() {
    const pct = overallPercent();
    el.progressFill.style.width = pct + '%';
    el.progressPct.textContent = Math.round(pct) + '%';
  }
  
  function persistProgress() {
    saveProgress(bookId, {
      chapterIndex,
      scrollFraction: scrollFraction(),
      updatedAt: Date.now()
    });
  }
  
  function onScroll() {
    updateProgressUI();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistProgress, 250);
  }
  
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
      .split(/\n{2,}/)
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => `<p>${escapeHtml(p).replace(/\n/g, ' ')}</p>`)
      .join('');
  }
  
  async function loadChapter(index, restoreScroll) {
    chapterIndex = Math.min(Math.max(index, 0), manifest.chapters.length - 1);
    const chapter = manifest.chapters[chapterIndex];
    renderState('Turning the page…');
    
    let text;
    try {
      const entry = zip.file(chapter.file);
      if (!entry) throw new Error(`"${chapter.file}" not found in the zip`);
      text = await entry.async('string');
    } catch (err) {
      renderError(`This chapter couldn't be loaded (${err.message}).`);
      return;
    }
    
    const total = manifest.chapters.length;
    const options = manifest.chapters.map((c, i) =>
      `<option value="${i}" ${i === chapterIndex ? 'selected' : ''}>${escapeHtml(c.title || ('Chapter ' + (i + 1)))}</option>`
    ).join('');
    
    el.surface.innerHTML = `
        <div class="reader-page">
          <div class="chapter-eyebrow">Chapter ${chapterIndex + 1} of ${total}</div>
          <h1 class="chapter-title">${escapeHtml(chapter.title || ('Chapter ' + (chapterIndex + 1)))}</h1>
          <div class="chapter-body font-${settings.font}">${paragraphize(text)}</div>
          <div class="chapter-nav">
            <button class="nav-btn" id="prevBtn" ${chapterIndex === 0 ? 'disabled' : ''}>Prev</button>
            <select class="chapter-select" id="chapterSelect">${options}</select>
            <button class="nav-btn" id="nextBtn" ${chapterIndex === total - 1 ? 'disabled' : ''}>Next</button>
          </div>
        </div>`;
    
    applySettings();
    
    document.getElementById('prevBtn').addEventListener('click', () => {
      window.scrollTo(0, 0);
      loadChapter(chapterIndex - 1, false);
    });
    document.getElementById('nextBtn').addEventListener('click', () => {
      window.scrollTo(0, 0);
      loadChapter(chapterIndex + 1, false);
    });
    document.getElementById('chapterSelect').addEventListener('change', (e) => {
      window.scrollTo(0, 0);
      loadChapter(parseInt(e.target.value, 10), false);
    });
    
    if (restoreScroll) {
      const saved = loadProgress(bookId);
      if (saved && saved.chapterIndex === chapterIndex) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        window.scrollTo(0, max * (saved.scrollFraction || 0));
      }
    } else {
      window.scrollTo(0, 0);
    }
    
    updateProgressUI();
    persistProgress();
  }
  
  async function init() {
    if (!bookId) {
      renderError('No book was specified.');
      return;
    }
    
    try {
      const booksRes = await fetch('books.json', { cache: 'no-store' }).catch(() => null);
      if (booksRes && booksRes.ok) {
        const books = await booksRes.json();
        bookMeta = books.find(b => String(b.id) === String(bookId)) || null;
      }
      const fallbackTitle = bookMeta ? bookMeta.title : `Book ${bookId}`;
      
      renderState('Unpacking the book…');
      
      const zipPath = (bookMeta && bookMeta.zip) ? bookMeta.zip : `books/${bookId}.zip`;
      
      let zipRes;
      try {
        zipRes = await fetch(zipPath); // default caching: a book's zip rarely changes, so let repeat visits use the cache
        if (!zipRes.ok) throw new Error(`HTTP ${zipRes.status}`);
      } catch (err) {
        el.topbarTitle.textContent = fallbackTitle;
        renderError(`"${fallbackTitle}" isn't on the archive yet — ${zipPath} couldn't be found.`);
        return;
      }
      
      const buffer = await zipRes.arrayBuffer();
      zip = await JSZip.loadAsync(buffer);
      
      // If the zip includes its own manifest.json, use it for titles/order.
      const manifestEntry = zip.file('manifest.json');
      if (manifestEntry) {
        manifest = JSON.parse(await manifestEntry.async('string'));
      } else {
        const chapterFiles = Object.keys(zip.files)
          .filter(name => /\.txt$/i.test(name) && !zip.files[name].dir)
          .sort(naturalSort);
        
        if (chapterFiles.length === 0) {
          el.topbarTitle.textContent = fallbackTitle;
          renderError(`"${fallbackTitle}"'s zip doesn't contain any .txt chapter files.`);
          return;
        }
        
        manifest = {
          title: fallbackTitle,
          chapters: chapterFiles.map((file, i) => ({ file, title: `Chapter ${i + 1}` }))
        };
      }
      
      const title = manifest.title || fallbackTitle;
      el.topbarTitle.textContent = title;
      
      if (!Array.isArray(manifest.chapters) || manifest.chapters.length === 0) {
        renderError(`"${title}" doesn't have any chapters yet.`);
        return;
      }
      
      applySettings();
      
      const saved = loadProgress(bookId);
      const startIndex = saved ? saved.chapterIndex : 0;
      await loadChapter(startIndex, true);
      
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('beforeunload', persistProgress);
    } catch (err) {
      renderError(`Something went wrong (${err.message}).`);
    }
  }
  
  applySettings();
  init();
})();