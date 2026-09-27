/**
 * Optional cloud sync.
 *
 * Local data in localStorage is always the source of truth for what the
 * page renders. This file's only job is: when the person has opted in
 * and signed in, keep a Firestore document ("users/<uid>") in step with
 * that local data, in both directions, so a second device can pick up
 * favorites / reading progress / reader settings instead of starting
 * from zero.
 *
 * If scripts/firebase-config.js still has its placeholder values, this
 * file does nothing but hide the sync UI — no network requests, no SDK
 * download, no cost to anyone who isn't using it.
 */
(function () {
  "use strict";

  const FIREBASE_SDK_URLS = [
    "https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js",
    "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth-compat.js",
    "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore-compat.js",
  ];

  const ENABLED_KEY = "3nding:sync-enabled";
  const META_KEY = "3nding:sync-meta";
  const FAVORITES_KEY = "3nding:favorites";
  const SETTINGS_KEY = "3nding:settings";
  const PROGRESS_PREFIX = "3nding:progress:";

  let sdkLoadPromise = null;
  let auth = null;
  let db = null;
  let unsubscribeSnapshot = null;
  let applyingRemote = false; // true while writeLocal() is applying a pull, so we don't loop back and re-push it
  let pushTimer = null;

  function isConfigured() {
    const c = window.FIREBASE_CONFIG;
    return !!(c && c.apiKey && c.apiKey !== "YOUR_API_KEY");
  }

  function loadSdk() {
    if (sdkLoadPromise) return sdkLoadPromise;
    sdkLoadPromise = FIREBASE_SDK_URLS.reduce(
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
    );
    return sdkLoadPromise;
  }

  function ensureApp() {
    if (auth) return;
    firebase.initializeApp(window.FIREBASE_CONFIG);
    auth = firebase.auth();
    db = firebase.firestore();

    auth.onAuthStateChanged(async (user) => {
      if (user) {
        localStorage.setItem(ENABLED_KEY, "1");
        try {
          await initialSync(user.uid);
          subscribeRemote(user.uid);
        } catch (err) {
          console.warn("Cloud sync: initial sync failed:", err);
        }
      } else {
        localStorage.removeItem(ENABLED_KEY);
        if (unsubscribeSnapshot) {
          unsubscribeSnapshot();
          unsubscribeSnapshot = null;
        }
      }
      notifyStatus();
    });
  }

  // ---------- local storage helpers ----------
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
      if (data.progress) {
        Object.keys(data.progress).forEach((id) => {
          localStorage.setItem(
            PROGRESS_PREFIX + id,
            JSON.stringify(data.progress[id]),
          );
        });
      }
    } finally {
      applyingRemote = false;
    }
    window.dispatchEvent(
      new CustomEvent("3nding:cloud-updated", { detail: data }),
    );
  }

  function readMeta() {
    try {
      return JSON.parse(localStorage.getItem(META_KEY) || "{}");
    } catch {
      return {};
    }
  }
  function setMeta(patch) {
    const meta = readMeta();
    Object.assign(meta, patch);
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  }
  function bumpMeta(key) {
    setMeta({ [key]: Date.now() });
  }

  // ---------- merge rules ----------
  // Favorites and settings are each merged wholesale, last-writer-wins,
  // using a timestamp bumped whenever a change happens on that device.
  // Per-book progress already carries its own updatedAt, so it merges
  // per-book instead of wholesale.
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

  function docRef(uid) {
    return db.collection("users").doc(uid);
  }

  // ---------- pull + reconcile on sign-in ----------
  async function initialSync(uid) {
    const ref = docRef(uid);
    const snap = await ref.get();
    const local = readLocal();
    const meta = readMeta();

    if (!snap.exists) {
      await ref.set({
        favorites: local.favorites,
        favoritesUpdatedAt: meta.favoritesUpdatedAt || Date.now(),
        settings: local.settings,
        settingsUpdatedAt: meta.settingsUpdatedAt || Date.now(),
        progress: local.progress,
      });
      return;
    }

    const remote = snap.data() || {};
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

    await ref.set({
      favorites: fav.value,
      favoritesUpdatedAt: fav.ts,
      settings: sett.value,
      settingsUpdatedAt: sett.ts,
      progress,
    });
  }

  // ---------- live updates from other devices ----------
  function subscribeRemote(uid) {
    if (unsubscribeSnapshot) unsubscribeSnapshot();
    unsubscribeSnapshot = docRef(uid).onSnapshot(
      (snap) => {
        if (!snap.exists) return;
        const remote = snap.data() || {};
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
      },
      (err) => console.warn("Cloud sync: live updates stopped:", err),
    );
  }

  // ---------- push local changes up ----------
  function schedulePush() {
    if (!auth || !auth.currentUser) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, 800);
  }

  async function pushNow() {
    if (!auth || !auth.currentUser) return;
    const local = readLocal();
    const meta = readMeta();
    try {
      await docRef(auth.currentUser.uid).set(
        {
          favorites: local.favorites,
          favoritesUpdatedAt: meta.favoritesUpdatedAt || Date.now(),
          settings: local.settings,
          settingsUpdatedAt: meta.settingsUpdatedAt || Date.now(),
          progress: local.progress,
        },
        { merge: true },
      );
    } catch (err) {
      console.warn("Cloud sync: push failed:", err);
    }
  }

  window.addEventListener("3nding:favorites-changed", () => {
    if (applyingRemote) return;
    bumpMeta("favoritesUpdatedAt");
    schedulePush();
  });
  window.addEventListener("3nding:settings-changed", () => {
    if (applyingRemote) return;
    bumpMeta("settingsUpdatedAt");
    schedulePush();
  });
  window.addEventListener("3nding:progress-changed", () => {
    if (applyingRemote) return;
    schedulePush();
  });

  // ---------- public API ----------
  function notifyStatus() {
    const user = auth && auth.currentUser;
    const detail = {
      signedIn: !!user,
      email: user ? user.email : null,
      configured: isConfigured(),
    };
    window.dispatchEvent(new CustomEvent("3nding:sync-status", { detail }));
    return detail;
  }

  async function enable() {
    if (!isConfigured())
      throw new Error("Cloud sync isn't set up for this site yet.");
    await loadSdk();
    ensureApp();
    const provider = new firebase.auth.GoogleAuthProvider();
    await auth.signInWithPopup(provider);
  }

  async function disable() {
    if (unsubscribeSnapshot) {
      unsubscribeSnapshot();
      unsubscribeSnapshot = null;
    }
    localStorage.removeItem(ENABLED_KEY);
    if (auth) {
      try {
        await auth.signOut();
      } catch (err) {
        console.warn("Cloud sync: sign-out failed:", err);
      }
    }
    notifyStatus();
  }

  window.CloudSync = { enable, disable, refreshStatus: notifyStatus };

  // Auto-restore a previous sign-in, without paying the SDK-download
  // cost for anyone who never opted in.
  (function autoInit() {
    if (!isConfigured()) {
      notifyStatus();
      return;
    }
    if (localStorage.getItem(ENABLED_KEY) !== "1") {
      notifyStatus();
      return;
    }
    loadSdk()
      .then(ensureApp)
      .catch((err) => console.warn("Cloud sync: failed to load:", err));
  })();
})();
