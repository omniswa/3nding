(function() {
  const grid = document.getElementById('grid');
  const status = document.getElementById('status');
  const searchRow = document.getElementById('searchRow');
  const searchInput = document.getElementById('searchInput');
  const noResults = document.getElementById('noResults');
  const favRow = document.getElementById('favRow');
  const favToggle = document.getElementById('favToggle');
  const favToggleIcon = document.getElementById('favToggleIcon');
  const favCount = document.getElementById('favCount');
  const pagination = document.getElementById('pagination');
  const pageStatus = document.getElementById('pageStatus');
  const prevPageBtn = document.getElementById('prevPageBtn');
  const nextPageBtn = document.getElementById('nextPageBtn');
  const controlsToggle = document.getElementById('controlsToggle');
  const drawer = document.getElementById('drawer');
  const drawerBackdrop = document.getElementById('drawerBackdrop');
  const drawerCloseBtn = document.getElementById('drawerCloseBtn');
  
  const SKELETON_COUNT = 10;
  const MIN_LOADING_MS = 450; // keeps the skeleton from flashing on fast connections
  const PAGE_SIZE = 10; // books shown per page; keeps pagination visibly working even on a small catalog
  const FAVORITES_KEY = '3nding:favorites';
  
  let allBooks = [];
  let favorites = loadFavorites();
  let favoritesOnly = false;
  let currentPage = 1;
  let lastMatches = [];
  
  // Escape any string before it goes into innerHTML, so titles/authors
  // from books.json can never be interpreted as markup.
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    } [ch]));
  }
  
  // ---------- favorites persistence ----------
  function loadFavorites() {
    try {
      const raw = localStorage.getItem(FAVORITES_KEY);
      if (!raw) return new Map();
      const parsed = JSON.parse(raw);
      
      // Support old array format (e.g. ["1", "2"]) if upgrading
      if (Array.isArray(parsed)) {
        return new Map(parsed.map((id, index) => [String(id), index]));
      }
      return new Map(Object.entries(parsed));
    } catch {
      return new Map();
    }
  }
  
  function saveFavorites() {
    try {
      const obj = Object.fromEntries(favorites);
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(obj));
    } catch {}
  }
  
  function isFavorite(id) {
    return favorites.has(String(id));
  }
  
  function updateFavCount() {
    favCount.textContent = favorites.size;
  }
  
  function toggleFavorite(id) {
    const key = String(id);
    if (favorites.has(key)) {
      favorites.delete(key);
    } else {
      // Store the current timestamp when favorited
      favorites.set(key, Date.now());
    }
    saveFavorites();
    updateFavCount();
    
    if (favoritesOnly) {
      // The favorites-only list membership just changed, so recompute it.
      applyFilter(false);
      return;
    }
    const btn = grid.querySelector(`.fav-btn[data-id="${key}"]`);
    if (btn) {
      const active = favorites.has(key);
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
      btn.setAttribute('aria-label', active ? 'Remove from favorites' : 'Add to favorites');
      btn.textContent = active ? '\u2665' : '\u2661';
    }
  }
  
  // ---------- drawer (mobile) ----------
  function openDrawer() {
    drawer.classList.add('open');
    drawerBackdrop.classList.add('visible');
    controlsToggle.setAttribute('aria-expanded', 'true');
  }
  
  function closeDrawer() {
    drawer.classList.remove('open');
    drawerBackdrop.classList.remove('visible');
    controlsToggle.setAttribute('aria-expanded', 'false');
  }
  
  controlsToggle.addEventListener('click', () => {
    drawer.classList.contains('open') ? closeDrawer() : openDrawer();
  });
  drawerBackdrop.addEventListener('click', closeDrawer);
  drawerCloseBtn.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer();
  });
  
  function renderSkeletons(n) {
    grid.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.className = 'card skeleton';
      el.innerHTML = `
        <div class="cover-wrap"></div>
        <div class="card-body">
          <div class="line"></div>
          <div class="line short"></div>
        </div>
      `;
      grid.appendChild(el);
    }
  }
  
  function renderBooks(books) {
    grid.innerHTML = '';
    books.forEach((book, i) => {
      const title = escapeHtml(book.title);
      const author = escapeHtml(book.author);
      const cover = escapeHtml(book.cover);
      const id = String(book.id);
      const active = isFavorite(id);
      const card = document.createElement('a');
      card.href = `reader.html?id=${encodeURIComponent(book.id)}`;
      card.setAttribute('aria-label', `${book.title} by ${book.author}`);
      card.style.textDecoration = 'none';
      card.style.color = 'inherit';
      card.className = 'card';
      card.style.animationDelay = `${Math.min(i * 40, 400)}ms`;
      card.innerHTML = `
        <div class="cover-wrap">
          <button type="button" class="fav-btn${active ? ' active' : ''}" data-id="${id}" aria-pressed="${active}" aria-label="${active ? 'Remove from favorites' : 'Add to favorites'}">${active ? '\u2665' : '\u2661'}</button>
          <img src="${cover}" alt="Cover of ${title}" loading="lazy">
        </div>
        <div class="card-body">
          <p class="card-title">${title}</p>
          <p class="card-author">${author}</p>
        </div>
        <div class="slip">
          <span>No. ${String(book.id).padStart(3,'0')}</span>
        </div>
      `;
      card.querySelector('.fav-btn').addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        toggleFavorite(id);
      });
      grid.appendChild(card);
    });
  }
  
  // ---------- pagination ----------
  function renderPagination(totalItems) {
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
    if (totalPages <= 1) {
      pagination.hidden = true;
      return;
    }
    pagination.hidden = false;
    prevPageBtn.disabled = currentPage === 1;
    nextPageBtn.disabled = currentPage === totalPages;
    pageStatus.textContent = `Page ${currentPage} of ${totalPages}`;
  }
  
  function scrollToGrid() {
    const top = grid.getBoundingClientRect().top + window.scrollY - 90;
    window.scrollTo({ top, behavior: 'smooth' });
  }
  
  prevPageBtn.addEventListener('click', () => {
    currentPage -= 1;
    renderCurrentPage();
    scrollToGrid();
  });
  
  nextPageBtn.addEventListener('click', () => {
    currentPage += 1;
    renderCurrentPage();
    scrollToGrid();
  });
  
  function renderCurrentPage() {
    const totalPages = Math.max(1, Math.ceil(lastMatches.length / PAGE_SIZE));
    currentPage = Math.min(Math.max(currentPage, 1), totalPages);
    const start = (currentPage - 1) * PAGE_SIZE;
    renderBooks(lastMatches.slice(start, start + PAGE_SIZE));
    renderPagination(lastMatches.length);
  }
  
  function setStatus(text, animated) {
    status.innerHTML = animated ?
      `<span class="dot"></span> ${text}` :
      text;
  }
  
  function applyFilter(resetPage) {
    if (resetPage) currentPage = 1;
    const q = searchInput.value.trim().toLowerCase();
    
    let matches = allBooks;
    
    if (favoritesOnly) {
      matches = matches
        .filter(b => isFavorite(b.id))
        .sort((a, b) => {
          const timeA = favorites.get(String(a.id)) || 0;
          const timeB = favorites.get(String(b.id)) || 0;
          return timeB - timeA; // Newest favorited first
          // (Change to `timeA - timeB` if you want oldest favorited first)
        });
    }
    
    if (q) matches = matches.filter(b =>
      b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q)
    );
    
    lastMatches = matches;
    
    if (matches.length === 0) {
      grid.innerHTML = '';
      pagination.hidden = true;
      noResults.hidden = false;
      if (favoritesOnly && !q) {
        noResults.textContent = "You haven't favorited any books yet — tap the ♡ on a book to add it.";
      } else if (favoritesOnly && q) {
        noResults.innerHTML = `None of your favorites match "<span>${escapeHtml(searchInput.value.trim())}</span>". Clear the search to see all favorites.`;
      } else if (q) {
        noResults.innerHTML = `No books match "<span>${escapeHtml(searchInput.value.trim())}</span>".`;
      } else {
        noResults.textContent = 'No books to show.';
      }
      setStatus('0 books shown', false);
      return;
    }
    
    noResults.hidden = true;
    renderCurrentPage();
    
    const noun = favoritesOnly ? 'favorite' : 'book';
    const scope = q ? ` matching "${searchInput.value.trim()}"` : '';
    setStatus(`Showing ${matches.length} ${noun}${matches.length === 1 ? '' : 's'}${scope}`, false);
  }
  
  searchInput.addEventListener('input', () => applyFilter(true));
  
  favToggle.addEventListener('click', () => {
    favoritesOnly = !favoritesOnly;
    favToggle.setAttribute('aria-pressed', String(favoritesOnly));
    favToggleIcon.textContent = favoritesOnly ? '\u2665' : '\u2661';
    if (favoritesOnly && searchInput.value.trim()) {
      searchInput.value = '';
    }
    applyFilter(true);
  });
  
  async function loadBooks() {
    renderSkeletons(SKELETON_COUNT);
    setStatus('Cataloging the archive…', true);
    
    const started = Date.now();
    try {
      const res = await fetch('books.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const books = await res.json();
      
      const elapsed = Date.now() - started;
      if (elapsed < MIN_LOADING_MS) {
        await new Promise(r => setTimeout(r, MIN_LOADING_MS - elapsed));
      }
      
      if (!Array.isArray(books) || books.length === 0) {
        grid.innerHTML = '';
        setStatus('The archive is empty right now.', false);
        return;
      }
      
      allBooks = books;
      searchRow.hidden = false;
      favRow.hidden = false;
      updateFavCount();
      applyFilter(true);
    } catch (err) {
      grid.innerHTML = `
        <div class="error-box">
          The archive couldn't be reached (${err.message}).<br>
          Make sure <code>books.json</code> sits next to this page.
          <div><button id="retry">Try again</button></div>
        </div>`;
      pagination.hidden = true;
      setStatus('Catalog unavailable', false);
      document.getElementById('retry').addEventListener('click', loadBooks);
    }
  }
  
  loadBooks();
})();