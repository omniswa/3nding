/**
 * Authentication + AUTOMATIC, cost-aware account sync.
 *
 * Everything is still saved to localStorage first. Firestore is touched
 * only in these cases:
 *
 *   PULL (1 read)   once on sign-in, then at most every PULL_MIN_INTERVAL_MS
 *                   (when the tab regains focus), or on "Sync now".
 *   PUSH (1 write)  debounced: PUSH_IDLE_MS after the last change, but never
 *                   later than PUSH_MAX_WAIT_MS after the first change; also
 *                   when the tab is hidden / page closes. Only fields that
 *                   differ from the last-known server copy are written, and
 *                   nothing is written if nothing differs.
 *
 * No realtime listeners (onSnapshot bills a read per change).
 * Per-browser daily caps: MAX_WRITES_PER_DAY / MAX_READS_PER_DAY.
 *
 * IMPORTANT: if your Firestore rules enforce a gap on lastSyncAt, lower it
 * to ~15 seconds (this client never writes more often than that).
 *
 * data-auth="required" -> gated page (index, reader). Shows sync UI.
 * data-auth="guest"    -> login / signup. No sync.
 * data-auth="setup"    -> username page.
 */
(function () {
  "use strict";

  const script = document.currentScript;
  const MODE = (script && script.dataset.auth) || "required";
  const ROOT = new URL("../", script.src);
  const HOME = ROOT.href + "index.html";
  const LOGIN = ROOT.href + "pages/login.html";

  const SDK = [
    "https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js",
    "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth-compat.js",
    "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore-compat.js",
  ];

  const UID_KEY = "3nding:uid";
  const META_KEY = "3nding:sync-meta";
  const FAVORITES_KEY = "3nding:favorites";
  const SETTINGS_KEY = "3nding:settings";
  const PROGRESS_PREFIX = "3nding:progress:";
  const UNAME_KEY = "3nding:username";
  const SHADOW_KEY = "3nding:sync-shadow"; // last-known server copy
  const SYNCLOG_KEY = "3nding:sync-log";
  const UNSYNCED_KEY = "3nding:unsynced";
  const UNAME_MIN = 6;
  const UNAME_MAX = 14;
  const SETUP = ROOT.href + "pages/username.html";

  // ---- auto-sync tuning (all cost knobs live here) ----
  const PULL_MIN_INTERVAL_MS = 15 * 60 * 1000; // min gap between reads
  const PUSH_IDLE_MS = 60 * 1000; // write after this much quiet
  const PUSH_MAX_WAIT_MS = 5 * 60 * 1000; // ...but never wait longer than this
  const PUSH_MIN_GAP_MS = 60 * 1000; // min gap between normal writes
  const FLUSH_MIN_GAP_MS = 15 * 1000; // min gap when leaving the page
  const MANUAL_COOLDOWN_MS = 30 * 1000; // "Sync now" button cooldown
  const MAX_WRITES_PER_DAY = 100; // per browser
  const MAX_READS_PER_DAY = 40; // per browser

  let sdkPromise = null;
  let auth = null;
  let db = null;
  let pulling = false;
  let pushing = false;
  let syncTicker = null;
  let pushTimer = null;
  let firstDirtyAt = 0;
  let failCount = 0;
  let autoStarted = false;
  let applyingRemote = false;
  let signingOut = false;
  let firstEvent = true;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));

  // ---------- SDK + app ----------
  function loadSdk() {
    if (sdkPromise) return sdkPromise;
    sdkPromise = SDK.reduce(
      (p, src) =>
        p.then(
          () =>
            new Promise((resolve, reject) => {
              const s = document.createElement("script");
              s.src = src;
              s.onload = resolve;
              s.onerror = () => reject(new Error("Could not load " + src));
              document.head.appendChild(s);
            }),
        ),
      Promise.resolve(),
    ).catch((err) => {
      sdkPromise = null;
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

  // The username lives on users/<uid>; cached so pages don't re-read it.
  async function usernameFor(user) {
    try {
      const c = JSON.parse(localStorage.getItem(UNAME_KEY) || "null");
      if (c && c.uid === user.uid && c.name) return c.name;
    } catch {}
    try {
      const snap = await db.collection("users").doc(user.uid).get();
      const name = snap.exists && snap.data().username;
      if (name) {
        localStorage.setItem(
          UNAME_KEY,
          JSON.stringify({ uid: user.uid, name }),
        );
        return name;
      }
    } catch (err) {
      console.warn("Auth: couldn't read username:", err);
    }
    return null;
  }

  async function onAuthState(user) {
    if (user) {
      if (MODE === "required") {
        claimLocal(user.uid);
        const name = await usernameFor(user);
        if (!name) return redirectToSetup();
        renderAccount(user, name);
        reveal();
        bindSyncUI();
        startAutoSync();
      } else if (MODE === "setup") {
        if (await usernameFor(user)) return location.replace(nextUrl());
        renderAccount(user, "");
        reveal();
      }
    } else {
      if (MODE !== "guest" && !signingOut) redirectToLogin(MODE === "required");
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
      settings = null,
      progress = {};
    try {
      favorites = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "{}");
    } catch {}
    try {
      settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    } catch {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(PROGRESS_PREFIX) === 0) {
        try {
          progress[k.slice(PROGRESS_PREFIX.length)] = JSON.parse(
            localStorage.getItem(k),
          );
        } catch {}
      }
    }
    return { favorites, settings, progress };
  }

  function writeLocal(data) {
    applyingRemote = true;
    try {
      if (data.favorites)
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(data.favorites));
      if (data.settings)
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(data.settings));
      if (data.progress)
        Object.keys(data.progress).forEach((id) =>
          localStorage.setItem(
            PROGRESS_PREFIX + id,
            JSON.stringify(data.progress[id]),
          ),
        );
    } finally {
      applyingRemote = false;
    }
    window.dispatchEvent(
      new CustomEvent("3nding:cloud-updated", { detail: data }),
    );
  }

  function clearLocal() {
    const doomed = [
      FAVORITES_KEY,
      SETTINGS_KEY,
      META_KEY,
      UNAME_KEY,
      SHADOW_KEY,
      UNSYNCED_KEY,
    ];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(PROGRESS_PREFIX) === 0) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  }

  // A different reader signing in on this browser must not inherit data.
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

  // "Shadow" = what we believe the server currently holds. Lets us write
  // only what changed, and skip the write entirely when nothing did.
  function readShadow() {
    try {
      return JSON.parse(localStorage.getItem(SHADOW_KEY) || "null");
    } catch {
      return null;
    }
  }
  function writeShadow(s) {
    try {
      localStorage.setItem(SHADOW_KEY, JSON.stringify(s));
    } catch {}
  }

  // ---------- merge rules ----------
  function mergeWhole(local, remote, localTs, remoteTs) {
    if (remote == null) return { value: local, ts: localTs || 0 };
    if (local == null) return { value: remote, ts: remoteTs || 0 };
    return (remoteTs || 0) > (localTs || 0)
      ? { value: remote, ts: remoteTs || 0 }
      : { value: local, ts: localTs || 0 };
  }

  function mergeProgress(local, remote) {
    const merged = Object.assign({}, local);
    Object.keys(remote || {}).forEach((id) => {
      const r = remote[id],
        l = merged[id];
      if (!l || (r && (r.updatedAt || 0) > (l.updatedAt || 0))) merged[id] = r;
    });
    return merged;
  }

  // Key-order-independent equality, so we only write when data truly differs.
  function stable(v) {
    if (v === undefined) return "null";
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stable(v[k]))
        .join(",") +
      "}"
    );
  }
  const same = (a, b) => stable(a) === stable(b);

  const docRef = (uid) => db.collection("users").doc(uid);
  const safeId = (id) => id && id.indexOf(".") === -1;

  function reconcile(remote) {
    const local = readLocal();
    const meta = readMeta();
    const fav = mergeWhole(
      local.favorites,
      remote.favorites,
      meta.favoritesUpdatedAt,
      remote.favoritesUpdatedAt,
    );
    const sett = mergeWhole(
      local.settings,
      remote.settings,
      meta.settingsUpdatedAt,
      remote.settingsUpdatedAt,
    );
    const progress = mergeProgress(local.progress, remote.progress);
    writeLocal({ favorites: fav.value, settings: sett.value, progress });
    setMeta({ favoritesUpdatedAt: fav.ts, settingsUpdatedAt: sett.ts });
  }

  // ---------- usage log (per browser, per calendar day) ----------
  function today() {
    return new Date().toDateString();
  }

  function readLog() {
    let l = {};
    try {
      l = JSON.parse(localStorage.getItem(SYNCLOG_KEY) || "{}") || {};
    } catch {}
    const fresh = l.day === today();
    return {
      day: today(),
      reads: fresh ? l.reads || 0 : 0,
      writes: fresh ? l.writes || 0 : 0,
      lastPull: l.lastPull || 0,
      lastPush: l.lastPush || 0,
      lastManual: l.lastManual || 0,
    };
  }

  function patchLog(p) {
    try {
      localStorage.setItem(
        SYNCLOG_KEY,
        JSON.stringify(Object.assign(readLog(), p)),
      );
    } catch {}
  }

  function coded(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  // ---------- diff + write ----------
  // Compare local data to the shadow and return only what must be written.
  // Progress uses one dotted path per book so devices never clobber each
  // other's entries for different books.
  function buildPatch(local, base) {
    const meta = readMeta();
    const patch = {};
    if (!same(local.favorites || {}, base.favorites || {})) {
      patch.favorites = local.favorites || {};
      patch.favoritesUpdatedAt = meta.favoritesUpdatedAt || Date.now();
    }
    if (local.settings && !same(local.settings, base.settings)) {
      patch.settings = local.settings;
      patch.settingsUpdatedAt = meta.settingsUpdatedAt || Date.now();
    }
    Object.keys(local.progress || {}).forEach((id) => {
      if (safeId(id) && !same(local.progress[id], (base.progress || {})[id]))
        patch["progress." + id] = local.progress[id];
    });
    return patch;
  }

  function applyPatchToShadow(patch) {
    const sh = readShadow() || { progress: {} };
    if ("favorites" in patch) {
      sh.favorites = patch.favorites;
      sh.favoritesUpdatedAt = patch.favoritesUpdatedAt;
    }
    if ("settings" in patch) {
      sh.settings = patch.settings;
      sh.settingsUpdatedAt = patch.settingsUpdatedAt;
    }
    sh.progress = sh.progress || {};
    Object.keys(patch).forEach((k) => {
      if (k.indexOf("progress.") === 0) sh.progress[k.slice(9)] = patch[k];
    });
    writeShadow(sh);
  }

  function toNested(patch) {
    const out = {};
    Object.keys(patch).forEach((k) => {
      if (k.indexOf("progress.") === 0)
        (out.progress = out.progress || {})[k.slice(9)] = patch[k];
      else out[k] = patch[k];
    });
    return out;
  }

  async function writeRemote(uid, patch) {
    const ref = docRef(uid);
    const stamp = firebase.firestore.FieldValue.serverTimestamp();
    try {
      await ref.update(Object.assign({}, patch, { lastSyncAt: stamp })); // 1 write
    } catch (err) {
      if (err.code !== "not-found") throw err;
      await ref.set(Object.assign(toNested(patch), { lastSyncAt: stamp }), {
        merge: true,
      });
    }
  }

  // ---------- PULL: 1 read, throttled ----------
  async function pull(force) {
    if (!auth) await api();
    await ready;
    const user = auth.currentUser;
    if (!user) return { skipped: true };
    if (pulling) return { skipped: true };

    const log = readLog();
    if (!force) {
      if (Date.now() - (readMeta().lastPullAt || 0) < PULL_MIN_INTERVAL_MS)
        return { skipped: true };
      if (log.reads >= MAX_READS_PER_DAY) return { skipped: true };
    } else if (log.reads >= MAX_READS_PER_DAY) {
      throw coded("sync/daily-limit", "Daily sync limit reached.");
    }

    pulling = true;
    paintSyncUI();
    try {
      const snap = await docRef(user.uid).get(); // 1 read
      patchLog({ reads: log.reads + 1, lastPull: Date.now() });
      const remote = snap.exists ? snap.data() || {} : {};
      reconcile(remote); // merges into local + notifies pages
      writeShadow({
        favorites: remote.favorites,
        favoritesUpdatedAt: remote.favoritesUpdatedAt,
        settings: remote.settings,
        settingsUpdatedAt: remote.settingsUpdatedAt,
        progress: remote.progress || {},
      });
      setMeta({ lastPullAt: Date.now() });
    } finally {
      pulling = false;
      paintSyncUI();
    }
    // Anything local that's newer than the server goes up now (max 1 write).
    const r = await pushDirty({ force: true });
    return { wrote: !!(r && r.wrote) };
  }

  // ---------- PUSH: at most 1 write, only if something differs ----------
  function schedulePush(delayOverride) {
    if (MODE !== "required") return;
    if (!firstDirtyAt) firstDirtyAt = Date.now();
    clearTimeout(pushTimer);
    const untilMax = Math.max(0, firstDirtyAt + PUSH_MAX_WAIT_MS - Date.now());
    const wait =
      typeof delayOverride === "number"
        ? delayOverride
        : Math.min(PUSH_IDLE_MS, untilMax);
    pushTimer = setTimeout(async () => {
      firstDirtyAt = 0;
      try {
        await pushDirty();
        failCount = 0;
      } catch (err) {
        paintSyncUI(SYNC_ERRORS[err.code] || "Sync failed. Will retry.");
        if (++failCount < 3) schedulePush(2 * 60 * 1000);
      }
    }, wait);
  }

  async function pushDirty(opts) {
    opts = opts || {};
    if (!auth) await api();
    await ready;
    const user = auth.currentUser;
    if (!user || pushing) return { wrote: false };

    const shadow = readShadow();
    if (!shadow) {
      // Never pulled on this browser: pull first so we don't overwrite
      // newer server data. pull() will push afterwards.
      return pull(true);
    }

    const log = readLog();
    const minGap = opts.force ? 0 : opts.minGap || PUSH_MIN_GAP_MS;
    const sinceLast = Date.now() - log.lastPush;
    if (sinceLast < minGap) {
      schedulePush(minGap - sinceLast + 500);
      return { wrote: false, deferred: true };
    }
    if (log.writes >= MAX_WRITES_PER_DAY)
      throw coded("sync/daily-limit", "Daily sync limit reached.");

    const patch = buildPatch(readLocal(), shadow);
    if (!Object.keys(patch).length) {
      localStorage.removeItem(UNSYNCED_KEY);
      paintSyncUI();
      return { wrote: false };
    }

    pushing = true;
    paintSyncUI();
    try {
      await writeRemote(user.uid, patch);
      applyPatchToShadow(patch);
      patchLog({ writes: log.writes + 1, lastPush: Date.now() });
      // Changes made while the write was in flight get another round.
      if (Object.keys(buildPatch(readLocal(), readShadow())).length)
        schedulePush();
      else localStorage.removeItem(UNSYNCED_KEY);
      return { wrote: true };
    } finally {
      pushing = false;
      paintSyncUI();
    }
  }

  function startAutoSync() {
    if (autoStarted || MODE !== "required") return;
    autoStarted = true;
    pull(false)
      .catch((err) => console.warn("Auth: pull failed:", err))
      .finally(() => {
        if (localStorage.getItem(UNSYNCED_KEY) === "1") schedulePush();
      });
  }

  // Manual button: a forced pull (1 read) + push if needed (<=1 write).
  async function syncNow() {
    if (!auth) await api();
    await ready;
    if (!auth.currentUser) throw coded("sync/no-user", "Not signed in.");
    if (pulling || pushing) throw coded("sync/busy", "Already syncing.");
    if (syncStatus().waitMs > 0)
      throw coded("sync/cooldown", "Please wait a bit.");
    patchLog({ lastManual: Date.now() });
    const r = await pull(true);
    return { wrote: !!(r && r.wrote) };
  }

  // ---------- status + UI (optional elements, safe if missing) ----------
  function syncStatus() {
    const l = readLog();
    const waitMs = Math.max(0, l.lastManual + MANUAL_COOLDOWN_MS - Date.now());
    return {
      last: Math.max(l.lastPull, l.lastPush),
      waitMs,
      remainingToday: Math.max(0, MAX_WRITES_PER_DAY - l.writes),
      canSync: waitMs === 0 && !pulling && !pushing,
      unsynced: localStorage.getItem(UNSYNCED_KEY) === "1",
    };
  }

  function ago(ts) {
    if (!ts) return "never";
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    return h < 24 ? h + " h ago" : Math.round(h / 24) + " d ago";
  }

  function paintSyncUI(message) {
    const btn = document.getElementById("syncBtn");
    const label = document.getElementById("syncStatus");
    if (!btn && !label) return;
    const st = syncStatus();
    if (btn) {
      btn.disabled = !st.canSync;
      btn.textContent =
        pulling || pushing
          ? "Syncing…"
          : st.waitMs > 0
            ? "Sync again in " + Math.ceil(st.waitMs / 1000) + "s"
            : st.unsynced
              ? "Sync now (saving soon)"
              : "Sync now";
    }
    if (label) {
      label.textContent =
        (message ? message + " · " : "") +
        "Auto-sync on · Last synced: " +
        ago(st.last);
    }
    clearTimeout(syncTicker);
    if (st.waitMs > 0) syncTicker = setTimeout(() => paintSyncUI(), 1000);
  }

  const SYNC_ERRORS = {
    "sync/cooldown": "Please wait before syncing again.",
    "sync/daily-limit": "Daily sync limit reached.",
    "sync/busy": "Already syncing.",
    "permission-denied": "Sync blocked (too soon or not allowed).",
    unavailable: "Network problem. Try again.",
  };

  function bindSyncUI() {
    const btn = document.getElementById("syncBtn");
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = "1";
      btn.addEventListener("click", async () => {
        try {
          const r = await syncNow();
          paintSyncUI(r.wrote ? "Synced" : "Already up to date");
        } catch (err) {
          paintSyncUI(SYNC_ERRORS[err.code] || "Sync failed. Try again.");
        }
      });
    }
    paintSyncUI();
  }

  // ---------- change tracking: flag + schedule a debounced push ----------
  function markUnsynced() {
    try {
      localStorage.setItem(UNSYNCED_KEY, "1");
    } catch {}
    paintSyncUI();
    schedulePush();
  }

  if (MODE === "required") {
    const onFav = () => {
      if (applyingRemote) return;
      setMeta({ favoritesUpdatedAt: Date.now() });
      markUnsynced();
    };
    const onSettings = () => {
      if (applyingRemote) return;
      setMeta({ settingsUpdatedAt: Date.now() });
      markUnsynced();
    };
    const onProgress = () => {
      if (applyingRemote) return;
      markUnsynced();
    };
    window.addEventListener("3nding:favorites-changed", onFav);
    window.addEventListener("3nding:settings-changed", onSettings);
    window.addEventListener("3nding:progress-changed", onProgress);

    // Save when the person leaves; refresh (throttled) when they come back.
    const flush = () => {
      if (!auth || !auth.currentUser) return;
      if (localStorage.getItem(UNSYNCED_KEY) === "1")
        pushDirty({ minGap: FLUSH_MIN_GAP_MS }).catch(() => {});
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
      else if (auth && auth.currentUser) pull(false).catch(() => {});
    });
    window.addEventListener("pagehide", flush);
    window.addEventListener("online", () => {
      if (localStorage.getItem(UNSYNCED_KEY) === "1") schedulePush();
    });
  }

  // ---------- public API ----------
  async function signOut() {
    signingOut = true;
    try {
      // Push pending changes before local data is wiped.
      try {
        await pushDirty({ force: true });
      } catch {}
      if (
        syncStatus().unsynced &&
        !confirm(
          "You have changes that haven't been synced. Signing out will remove them from this device. Sign out anyway?",
        )
      )
        throw coded("signout/cancelled", "Cancelled.");
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
    localStorage.setItem(UNAME_KEY, JSON.stringify({ uid: user.uid, name }));
    return name;
  }

  async function claimAfterSignup(user, username) {
    if (!username || (await usernameFor(user))) return;
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
    syncNow,
    syncStatus,
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
