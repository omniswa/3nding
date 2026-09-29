/**
 * Authentication + account-linked sync.
 *
 * data-auth="required"  -> page is gated. Signed-out visitors are sent to
 *                          the login page; signed-in readers get their
 *                          favorites / progress / settings synced.
 * data-auth="guest"     -> login / signup pages. No syncing, no redirect
 *                          (the page script decides where to go next).
 * data-auth="setup"     -> username picker page.
 *
 * Sync model (built to keep Firestore usage low):
 *  - localStorage is what the UI renders; Firestore "users/<uid>" is the
 *    cross-device copy.
 *  - PULL: one document read per page load, skipped if we pulled less than
 *    PULL_MIN_INTERVAL_MS ago, and again when a hidden tab becomes visible.
 *    No real-time listener (a listener bills a read on every remote write).
 *  - PUSH: only what changed (dirty tracking), throttled, and flushed when
 *    the page is hidden. Progress is written per book via field paths so a
 *    stale entry can never overwrite a newer one for a different book.
 *  - Nothing is written on page load unless local data is newer than remote.
 */
(function () {
  "use strict";

  const script = document.currentScript;
  const MODE = (script && script.dataset.auth) || "required";
  const ROOT = new URL("../", script.src);
  const HOME = ROOT.href + "index.html";
  const LOGIN = ROOT.href + "pages/login.html";
  const SETUP = ROOT.href + "pages/username.html";

  const FIREBASE_VERSION = "10.13.2";
  const SDK_BASE =
    "https://www.gstatic.com/firebasejs/" + FIREBASE_VERSION + "/";
  const SDK_CORE = SDK_BASE + "firebase-app-compat.js";
  const SDK_SERVICES = [
    SDK_BASE + "firebase-auth-compat.js",
    SDK_BASE + "firebase-firestore-compat.js",
  ];

  const UID_KEY = "3nding:uid";
  const META_KEY = "3nding:sync-meta";
  const FAVORITES_KEY = "3nding:favorites";
  const SETTINGS_KEY = "3nding:settings";
  const PROGRESS_PREFIX = "3nding:progress:";
  const UNAME_KEY = "3nding:username";
  const UNAME_MIN = 12;
  const UNAME_MAX = 14;

  // Sync tuning
  const PUSH_DELAY_FAST_MS = 2000; // favorites / settings: should feel instant
  const PUSH_DELAY_PROGRESS_MS = 30000; // progress: at most ~1 write per 30 s while reading
  const PUSH_RETRY_MS = 60000; // retry after a transient network failure
  const PULL_MIN_INTERVAL_MS = 60000; // don't re-read the doc more than once a minute
  const NETWORK_TIMEOUT_MS = 8000; // never let a hung request block the UI
  const RETRYABLE_CODES = new Set([
    "unavailable",
    "deadline-exceeded",
    "sync/timeout",
  ]);

  let sdkPromise = null;
  let auth = null;
  let db = null;
  let pushTimer = null;
  let pushDueAt = 0;
  let syncInFlight = null;
  let signingOut = false;
  let firstEvent = true;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));

  // What still needs to be sent to Firestore.
  const dirty = { favorites: false, settings: false, progress: new Set() };

  // ---------- small helpers ----------
  function coded(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(coded("sync/timeout", "Timed out.")), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  const isPlainObject = (v) =>
    !!v && typeof v === "object" && !Array.isArray(v);

  function isValidProgress(p) {
    return (
      isPlainObject(p) &&
      Number.isInteger(p.chapterIndex) &&
      p.chapterIndex >= 0 &&
      typeof p.scrollFraction === "number" &&
      p.scrollFraction >= 0 &&
      p.scrollFraction <= 1 &&
      Number.isFinite(p.updatedAt)
    );
  }

  function sanitizeFavorites(raw) {
    const out = {};
    if (!isPlainObject(raw)) return out;
    Object.keys(raw).forEach((id) => {
      if (Number.isFinite(raw[id])) out[id] = raw[id];
    });
    return out;
  }

  function sanitizeProgress(raw) {
    const out = {};
    if (!isPlainObject(raw)) return out;
    Object.keys(raw).forEach((id) => {
      if (isValidProgress(raw[id])) out[id] = raw[id];
    });
    return out;
  }

  // ---------- SDK + app ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }

  // app-compat must come first; auth and firestore can download in parallel.
  function loadSdk() {
    if (sdkPromise) return sdkPromise;
    sdkPromise = loadScript(SDK_CORE)
      .then(() => Promise.all(SDK_SERVICES.map(loadScript)))
      .catch((err) => {
        sdkPromise = null; // allow a retry
        throw err;
      });
    return sdkPromise;
  }

  function ensureApp() {
    if (auth) return;
    if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
    auth = firebase.auth();
    auth.useDeviceLanguage();
    db = firebase.firestore();
    auth.onAuthStateChanged(onAuthState);
  }

  async function api() {
    await loadSdk();
    ensureApp();
    return auth;
  }

  // ---------- gate ----------
  function reveal() {
    document.documentElement.classList.remove("auth-pending");
  }

  function redirectToLogin(withNext) {
    const u = new URL(LOGIN);
    if (withNext)
      u.searchParams.set("next", location.pathname + location.search);
    location.replace(u.href);
  }

  function showGateError() {
    reveal();
    document.body.innerHTML =
      "<div style=\"max-width:420px;margin:20vh auto;padding:0 1.25rem;font:0.9rem/1.6 'Space Mono',monospace;color:#ece4d1;text-align:center\">" +
      "The sign-in service couldn't be reached. Check your connection and try again.<br><br>" +
      '<button onclick="location.reload()" style="font:inherit;letter-spacing:.05em;text-transform:uppercase;background:transparent;color:#d4ac57;border:1px solid #b8923f;padding:.5rem .9rem;cursor:pointer">Retry</button></div>';
  }

  function redirectToSetup() {
    const u = new URL(SETUP);
    u.searchParams.set("next", location.pathname + location.search);
    location.replace(u.href);
  }

  // The username lives on users/<uid>; cache it so pages don't re-read it.
  // Returns the name, or "" if the account genuinely has none yet.
  // THROWS if the lookup failed, so a network blip is never mistaken for
  // "this account has no username" (which would send the reader to setup).
  async function usernameFor(user) {
    try {
      const c = JSON.parse(localStorage.getItem(UNAME_KEY) || "null");
      if (c && c.uid === user.uid && c.name) return c.name;
    } catch {}
    const snap = await withTimeout(
      db.collection("users").doc(user.uid).get(),
      NETWORK_TIMEOUT_MS,
    );
    const name = (snap.exists && snap.data().username) || "";
    if (name) {
      try {
        localStorage.setItem(
          UNAME_KEY,
          JSON.stringify({ uid: user.uid, name }),
        );
      } catch {}
    }
    return name;
  }

  async function onAuthState(user) {
    if (user) {
      if (MODE === "required") {
        claimLocal(user.uid);
        let name;
        try {
          name = await usernameFor(user);
        } catch (err) {
          console.warn("Auth: couldn't read username:", err);
          return showGateError();
        }
        if (!name) return redirectToSetup(); // every account needs a username
        renderAccount(user, name);
        reveal();
        await sync(user.uid); // never throws; `ready` resolves once local + remote agree
      } else if (MODE === "setup") {
        let name;
        try {
          name = await usernameFor(user);
        } catch (err) {
          console.warn("Auth: couldn't read username:", err);
          return showGateError();
        }
        if (name) return location.replace(nextUrl());
        renderAccount(user, "");
        reveal();
      }
    } else if (MODE !== "guest" && !signingOut) {
      redirectToLogin(MODE === "required");
    }
    if (firstEvent) {
      firstEvent = false;
      resolveReady(user);
    }
  }

  function renderAccount(user, name) {
    const label = document.getElementById("accountEmail");
    if (label)
      label.textContent = name
        ? "Signed in as @" + name
        : "Signed in as " + (user.email || "reader");
    const btn = document.getElementById("signOutBtn");
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = "1";
      btn.addEventListener("click", () => {
        btn.disabled = true;
        signOut().catch(() => (btn.disabled = false));
      });
    }
  }

  // ---------- local storage ----------
  function readLocal() {
    let favorites = {},
      settings = null;
    const progress = {};
    try {
      favorites = sanitizeFavorites(
        JSON.parse(localStorage.getItem(FAVORITES_KEY) || "{}"),
      );
    } catch {}
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      settings = isPlainObject(s) ? s : null;
    } catch {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(PROGRESS_PREFIX) === 0) {
        try {
          const p = JSON.parse(localStorage.getItem(k));
          if (isValidProgress(p)) progress[k.slice(PROGRESS_PREFIX.length)] = p;
        } catch {}
      }
    }
    return { favorites, settings, progress };
  }

  // Writes only what actually differs, and only announces a change if there
  // was one, so pages don't re-render (and replay animations) for nothing.
  function writeLocal(data) {
    let changed = false;
    const put = (key, value) => {
      const next = JSON.stringify(value);
      if (localStorage.getItem(key) === next) return;
      localStorage.setItem(key, next);
      changed = true;
    };
    try {
      if (data.favorites) put(FAVORITES_KEY, data.favorites);
      if (data.settings) put(SETTINGS_KEY, data.settings);
      Object.keys(data.progress || {}).forEach((id) =>
        put(PROGRESS_PREFIX + id, data.progress[id]),
      );
    } catch (err) {
      console.warn("Sync: couldn't write local data:", err);
    }
    if (changed) {
      window.dispatchEvent(
        new CustomEvent("3nding:cloud-updated", { detail: data }),
      );
    }
  }

  function clearLocal() {
    const doomed = [FAVORITES_KEY, SETTINGS_KEY, META_KEY, UNAME_KEY];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(PROGRESS_PREFIX) === 0) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
    dirty.favorites = false;
    dirty.settings = false;
    dirty.progress.clear();
  }

  // If a different reader signs in on this browser, don't let the
  // previous reader's data bleed into their account.
  function claimLocal(uid) {
    const prev = localStorage.getItem(UID_KEY);
    if (prev && prev !== uid) clearLocal();
    localStorage.setItem(UID_KEY, uid);
  }

  function readMeta() {
    try {
      return JSON.parse(localStorage.getItem(META_KEY) || "{}");
    } catch {
      return {};
    }
  }
  function setMeta(patch) {
    try {
      localStorage.setItem(
        META_KEY,
        JSON.stringify(Object.assign(readMeta(), patch)),
      );
    } catch {}
  }

  // ---------- merge rules ----------
  // Whole-value, last-writer-wins (favorites, settings).
  // `localWon` means local is genuinely newer and must be uploaded.
  function mergeWhole(local, remote, localTs, remoteTs) {
    localTs = localTs || 0;
    remoteTs = remoteTs || 0;
    if (remote == null)
      return {
        value: local,
        ts: localTs,
        localWon: local != null && localTs > 0,
      };
    if (local == null) return { value: remote, ts: remoteTs, localWon: false };
    if (remoteTs > localTs)
      return { value: remote, ts: remoteTs, localWon: false };
    return { value: local, ts: localTs, localWon: localTs > remoteTs };
  }

  // Per-book, newest updatedAt wins. Returns the ids local should upload.
  function mergeProgress(local, remote) {
    const merged = Object.assign({}, remote);
    const localWins = [];
    Object.keys(local).forEach((id) => {
      const l = local[id];
      const r = remote[id];
      if (!r || l.updatedAt > r.updatedAt) {
        merged[id] = l;
        localWins.push(id);
      }
    });
    return { merged, localWins };
  }

  const docRef = (uid) => db.collection("users").doc(uid);

  function reconcile(remoteRaw) {
    const local = readLocal();
    const meta = readMeta();

    const remoteFavorites =
      remoteRaw.favorites == null
        ? null
        : sanitizeFavorites(remoteRaw.favorites);
    const remoteSettings = isPlainObject(remoteRaw.settings)
      ? remoteRaw.settings
      : null;
    const remoteProgress = sanitizeProgress(remoteRaw.progress);

    const fav = mergeWhole(
      local.favorites,
      remoteFavorites,
      meta.favoritesUpdatedAt,
      remoteRaw.favoritesUpdatedAt,
    );
    const sett = mergeWhole(
      local.settings,
      remoteSettings,
      meta.settingsUpdatedAt,
      remoteRaw.settingsUpdatedAt,
    );
    const prog = mergeProgress(local.progress, remoteProgress);

    writeLocal({
      favorites: fav.value,
      settings: sett.value,
      progress: prog.merged,
    });
    setMeta({ favoritesUpdatedAt: fav.ts, settingsUpdatedAt: sett.ts });

    // Anything local is newer on gets queued; everything else stays untouched.
    if (fav.localWon) dirty.favorites = true;
    if (sett.localWon) dirty.settings = true;
    prog.localWins.forEach((id) => dirty.progress.add(id));
  }

  // ---------- pull ----------
  async function sync(uid, { force = false } = {}) {
    if (syncInFlight) return syncInFlight;
    if (
      !force &&
      Date.now() - (readMeta().lastPullAt || 0) < PULL_MIN_INTERVAL_MS
    )
      return;

    syncInFlight = (async () => {
      try {
        const snap = await withTimeout(docRef(uid).get(), NETWORK_TIMEOUT_MS);
        reconcile(snap.exists ? snap.data() || {} : {});
        setMeta({ lastPullAt: Date.now() });
      } catch (err) {
        console.warn("Sync: pull failed:", err);
      } finally {
        syncInFlight = null;
        if (hasPending()) schedulePush(PUSH_DELAY_FAST_MS);
      }
    })();
    return syncInFlight;
  }

  // ---------- push ----------
  function hasPending() {
    return dirty.favorites || dirty.settings || dirty.progress.size > 0;
  }

  // Keeps the *earliest* requested time, so a steady stream of progress
  // events results in a throttle (one write per window), not a debounce
  // that never fires until the reader stops.
  function schedulePush(delayMs) {
    if (!auth || !auth.currentUser) return;
    const due = Date.now() + delayMs;
    if (pushTimer && due >= pushDueAt) return;
    clearTimeout(pushTimer);
    pushDueAt = due;
    pushTimer = setTimeout(pushNow, delayMs);
  }

  async function pushNow() {
    clearTimeout(pushTimer);
    pushTimer = null;
    pushDueAt = 0;

    const user = auth && auth.currentUser;
    if (!user || !hasPending()) return;

    const local = readLocal();
    const meta = readMeta();
    const { FieldPath } = firebase.firestore;

    const data = {};
    const fields = [];
    const sent = {
      favorites: dirty.favorites,
      settings: dirty.settings && !!local.settings,
      progress: Array.from(dirty.progress),
    };

    // mergeFields with a top-level name REPLACES that whole map, so removed
    // favorites really disappear (a plain set(..., {merge:true}) would keep them).
    if (sent.favorites) {
      data.favorites = local.favorites;
      data.favoritesUpdatedAt = meta.favoritesUpdatedAt || Date.now();
      fields.push("favorites", "favoritesUpdatedAt");
    }
    if (sent.settings) {
      data.settings = local.settings;
      data.settingsUpdatedAt = meta.settingsUpdatedAt || Date.now();
      fields.push("settings", "settingsUpdatedAt");
    }
    const progress = {};
    sent.progress.forEach((id) => {
      if (!isValidProgress(local.progress[id])) return;
      progress[id] = local.progress[id];
      fields.push(new FieldPath("progress", id)); // touch only this book
    });
    if (Object.keys(progress).length) data.progress = progress;

    dirty.favorites = false;
    dirty.settings = false;
    dirty.progress.clear();
    if (!fields.length) return;

    try {
      await withTimeout(
        docRef(user.uid).set(data, { mergeFields: fields }),
        NETWORK_TIMEOUT_MS,
      );
    } catch (err) {
      console.warn("Sync: push failed:", err);
      // Only re-queue failures that can succeed later; a permission or
      // validation error would otherwise retry forever and burn quota.
      if (RETRYABLE_CODES.has(err.code)) {
        dirty.favorites = dirty.favorites || sent.favorites;
        dirty.settings = dirty.settings || sent.settings;
        sent.progress.forEach((id) => dirty.progress.add(id));
        schedulePush(PUSH_RETRY_MS);
      }
    }
  }

  if (MODE === "required") {
    window.addEventListener("3nding:favorites-changed", () => {
      setMeta({ favoritesUpdatedAt: Date.now() });
      dirty.favorites = true;
      schedulePush(PUSH_DELAY_FAST_MS);
    });
    window.addEventListener("3nding:settings-changed", () => {
      setMeta({ settingsUpdatedAt: Date.now() });
      dirty.settings = true;
      schedulePush(PUSH_DELAY_FAST_MS);
    });
    window.addEventListener("3nding:progress-changed", (e) => {
      const id = e.detail && e.detail.bookId;
      if (id == null) return;
      dirty.progress.add(String(id));
      schedulePush(PUSH_DELAY_PROGRESS_MS);
    });

    // Flush before the page goes away (best effort), and refresh when the
    // reader comes back to a tab. Both are no-ops when there is nothing to do.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        pushNow();
      } else if (auth && auth.currentUser) {
        sync(auth.currentUser.uid);
      }
    });
    window.addEventListener("pagehide", () => {
      pushNow();
    });
  }

  // ---------- public API ----------
  async function signOut() {
    signingOut = true;
    try {
      await pushNow(); // has its own timeout, so signing out offline can't hang
      await auth.signOut();
      clearLocal(); // UID_KEY is kept on purpose; see claimLocal()
      location.replace(LOGIN);
    } catch (err) {
      signingOut = false;
      throw err;
    }
  }

  function nextUrl() {
    const n = new URLSearchParams(location.search).get("next");
    if (n) {
      try {
        const u = new URL(n, location.href);
        if (
          u.origin === location.origin &&
          !/\/(login|signup|username)\.html$/.test(u.pathname)
        )
          return u.href;
      } catch {}
    }
    return HOME;
  }

  // ---------- usernames ----------
  // Stored lowercase. usernames/<name> = { uid } is the uniqueness lock;
  // Firestore rules refuse a second write to the same document.
  const normalizeName = (raw) =>
    String(raw || "")
      .trim()
      .toLowerCase();

  function validateUsername(raw) {
    const n = normalizeName(raw);
    if (n.length < UNAME_MIN || n.length > UNAME_MAX)
      return (
        "Usernames must be " + UNAME_MIN + "–" + UNAME_MAX + " characters."
      );
    if (!/^[a-z0-9_]+$/.test(n))
      return "Use only letters, numbers and underscores.";
    return "";
  }

  // Works before sign-in: the rules allow reading a single username doc.
  async function isUsernameAvailable(raw) {
    await api();
    const snap = await db.collection("usernames").doc(normalizeName(raw)).get();
    return !snap.exists;
  }

  async function claimUsername(raw) {
    const name = normalizeName(raw);
    const bad = validateUsername(name);
    if (bad) throw coded("username/invalid", bad);
    await api();
    const user = auth.currentUser;
    if (!user) throw coded("username/no-user", "Not signed in.");
    // Both writes must be in ONE batch: the security rules check that the
    // users doc ends up pointing at the same name.
    const batch = db.batch();
    batch.set(db.collection("usernames").doc(name), { uid: user.uid });
    batch.set(
      db.collection("users").doc(user.uid),
      { username: name },
      { merge: true },
    );
    try {
      await batch.commit();
    } catch (err) {
      if (err.code === "permission-denied")
        throw coded("username/taken", "That username isn't available.");
      throw err;
    }
    try {
      localStorage.setItem(UNAME_KEY, JSON.stringify({ uid: user.uid, name }));
    } catch {}
    return name;
  }

  // Account exists but the username couldn't be claimed (e.g. lost a race):
  // send them to the setup page rather than leaving them without one.
  async function claimAfterSignup(user, username) {
    if (!username) return;
    let existing = "";
    try {
      existing = await usernameFor(user);
    } catch {} // unknown -> attempt the claim; the rules reject it if one exists
    if (existing) return;
    try {
      await claimUsername(username);
    } catch (err) {
      err.accountCreated = true;
      throw err;
    }
  }

  function setupUrl() {
    const u = new URL(SETUP);
    u.searchParams.set("next", nextUrl());
    u.searchParams.set("reason", "taken");
    return u.href;
  }

  window.Auth = {
    ready,
    nextUrl,
    setupUrl,
    signOut,
    USERNAME: { min: UNAME_MIN, max: UNAME_MAX },
    validateUsername,
    isUsernameAvailable,
    claimUsername,
    async signInWithGoogle(username) {
      const a = await api();
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      const cred = await a.signInWithPopup(provider);
      await claimAfterSignup(cred.user, username);
      return cred;
    },
    async signUpWithEmail(email, password, username) {
      const cred = await (
        await api()
      ).createUserWithEmailAndPassword(email, password);
      await claimAfterSignup(cred.user, username);
      return cred;
    },
    async signInWithEmail(email, password) {
      return (await api()).signInWithEmailAndPassword(email, password);
    },
    async sendPasswordReset(email) {
      return (await api()).sendPasswordResetEmail(email);
    },
  };

  // ---------- boot ----------
  const c = window.FIREBASE_CONFIG;
  if (!c || !c.apiKey || c.apiKey === "YOUR_API_KEY") {
    console.error("Auth: scripts/firebase-config.js is not configured.");
    MODE !== "guest" ? showGateError() : resolveReady(null);
  } else {
    loadSdk()
      .then(ensureApp)
      .catch((err) => {
        console.warn("Auth: failed to load:", err);
        MODE !== "guest" ? showGateError() : resolveReady(null);
      });
  }
})();
