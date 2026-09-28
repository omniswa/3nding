/**
 * Authentication + MANUAL account sync.
 *
 * Everything is saved to localStorage as before. Nothing is sent to
 * Firestore until the reader presses the Sync button (#syncBtn).
 * One click = 1 read + at most 1 write (0 writes if nothing differs).
 *
 * Limits: SYNC_COOLDOWN_MS between syncs and SYNC_MAX_PER_DAY per day
 * (client-side, per browser). Enforce the cooldown for real with the
 * Firestore rule described in the setup notes, since client checks can
 * be bypassed.
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
  const UNAME_MIN = 6;
  const UNAME_MAX = 14;
  const SETUP = ROOT.href + "pages/username.html";

  // ---- manual sync limits ----
  const SYNC_COOLDOWN_MS = 10 * 60 * 1000; // min gap between syncs
  const SYNC_MAX_PER_DAY = 10; // per browser, per calendar day
  const SYNCLOG_KEY = "3nding:sync-log";
  const UNSYNCED_KEY = "3nding:unsynced";
  let syncing = false;
  let syncTicker = null;
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
    const doomed = [FAVORITES_KEY, SETTINGS_KEY, META_KEY, UNAME_KEY];
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
    localStorage.setItem(
      META_KEY,
      JSON.stringify(Object.assign(readMeta(), patch)),
    );
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
    return {
      favorites: fav.value,
      favoritesUpdatedAt: fav.ts,
      settings: sett.value,
      settingsUpdatedAt: sett.ts,
      progress,
    };
  }

  // ---------- manual sync ----------
  function today() {
    return new Date().toDateString();
  }

  function readLog() {
    try {
      const l = JSON.parse(localStorage.getItem(SYNCLOG_KEY) || "{}");
      return l.day === today()
        ? { day: l.day, count: l.count || 0, last: l.last || 0 }
        : { day: today(), count: 0, last: l.last || 0 };
    } catch {
      return { day: today(), count: 0, last: 0 };
    }
  }

  function syncStatus() {
    const l = readLog();
    const waitMs = Math.max(0, l.last + SYNC_COOLDOWN_MS - Date.now());
    const remainingToday = Math.max(0, SYNC_MAX_PER_DAY - l.count);
    return {
      last: l.last,
      waitMs,
      remainingToday,
      canSync: waitMs === 0 && remainingToday > 0 && !syncing,
      unsynced: localStorage.getItem(UNSYNCED_KEY) === "1",
    };
  }

  function markUnsynced() {
    try {
      localStorage.setItem(UNSYNCED_KEY, "1");
    } catch {}
    paintSyncUI();
  }

  async function syncNow() {
    await api();
    await ready;
    const user = auth.currentUser;
    if (!user) throw coded("sync/no-user", "Not signed in.");
    if (syncing) throw coded("sync/busy", "A sync is already running.");
    const st = syncStatus();
    if (st.remainingToday === 0)
      throw coded("sync/daily-limit", "Daily sync limit reached.");
    if (st.waitMs > 0) throw coded("sync/cooldown", "Please wait a bit.");

    syncing = true;
    paintSyncUI();
    try {
      const ref = docRef(user.uid);
      const snap = await ref.get(); // 1 read
      const remote = snap.exists ? snap.data() || {} : {};
      const stamp = firebase.firestore.FieldValue.serverTimestamp();

      let wrote = false;
      if (!snap.exists) {
        const local = readLocal();
        const meta = readMeta();
        await ref.set(
          {
            favorites: local.favorites,
            favoritesUpdatedAt: meta.favoritesUpdatedAt || Date.now(),
            settings: local.settings,
            settingsUpdatedAt: meta.settingsUpdatedAt || Date.now(),
            progress: local.progress,
            lastSyncAt: stamp,
          },
          { merge: true },
        );
        wrote = true;
      } else {
        const merged = reconcile(remote); // updates local + notifies pages
        const patch = {};
        if (!same(merged.favorites, remote.favorites)) {
          patch.favorites = merged.favorites || {};
          patch.favoritesUpdatedAt = merged.favoritesUpdatedAt || Date.now();
        }
        if (!same(merged.settings, remote.settings)) {
          patch.settings = merged.settings;
          patch.settingsUpdatedAt = merged.settingsUpdatedAt || Date.now();
        }
        Object.keys(merged.progress || {}).forEach((id) => {
          if (
            safeId(id) &&
            !same(merged.progress[id], (remote.progress || {})[id])
          )
            patch["progress." + id] = merged.progress[id];
        });
        if (Object.keys(patch).length) {
          patch.lastSyncAt = stamp;
          await ref.update(patch); // 1 write
          wrote = true;
        }
      }

      const l = readLog();
      localStorage.setItem(
        SYNCLOG_KEY,
        JSON.stringify({ day: l.day, count: l.count + 1, last: Date.now() }),
      );
      localStorage.removeItem(UNSYNCED_KEY);
      return { wrote };
    } finally {
      syncing = false;
      paintSyncUI();
    }
  }

  // ---------- sync UI (optional elements, safe if missing) ----------
  // Expects: <button id="syncBtn"> and <p id="syncStatus"> in the page.
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
      btn.textContent = syncing
        ? "Syncing…"
        : st.remainingToday === 0
          ? "Daily limit reached"
          : st.waitMs > 0
            ? "Sync again in " + Math.ceil(st.waitMs / 60000) + " min"
            : st.unsynced
              ? "Sync now (changes pending)"
              : "Sync now";
    }
    if (label) {
      label.textContent =
        (message ? message + " · " : "") +
        "Last synced: " +
        ago(st.last) +
        " · " +
        st.remainingToday +
        " sync" +
        (st.remainingToday === 1 ? "" : "s") +
        " left today";
    }
    // Re-check every 30s only while a cooldown is counting down.
    clearTimeout(syncTicker);
    if (st.waitMs > 0) syncTicker = setTimeout(() => paintSyncUI(), 30000);
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

  // Any local change just flags "unsynced". No network involved.
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
  }

  // ---------- public API ----------
  async function signOut() {
    signingOut = true;
    try {
      // Local data is wiped on sign-out, so warn if it was never synced.
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

  function coded(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
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
