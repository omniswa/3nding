/**
 * Authentication + account-linked sync.
 *
 * data-auth="required"  -> page is gated. Signed-out visitors are sent to
 *                          the login page; signed-in readers get their
 *                          favorites / progress / settings synced.
 * data-auth="guest"     -> login / signup pages. No syncing, no redirect
 *                          (the page script decides where to go next).
 *
 * Local data in localStorage remains what the page renders; Firestore
 * ("users/<uid>") is kept in step with it in both directions.
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
  const UNAME_MIN = 12;
  const UNAME_MAX = 14;
  const SETUP = ROOT.href + "pages/username.html";

  let sdkPromise = null;
  let auth = null;
  let db = null;
  let unsubscribe = null;
  let pushTimer = null;
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
        if (!name) return redirectToSetup(); // every account needs a username
        renderAccount(user, name);
        reveal();
        try {
          await initialSync(user.uid);
          subscribeRemote(user.uid);
        } catch (err) {
          console.warn("Sync: initial sync failed:", err);
        }
      } else if (MODE === "setup") {
        if (await usernameFor(user)) return location.replace(nextUrl());
        renderAccount(user, "");
        reveal();
      }
    } else {
      stopRemote();
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

  const docRef = (uid) => db.collection("users").doc(uid);

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

  async function initialSync(uid) {
    const ref = docRef(uid);
    const snap = await ref.get();
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
        },
        { merge: true },
      );
      return;
    }
    await ref.set(reconcile(snap.data() || {}), { merge: true });
  }

  function subscribeRemote(uid) {
    stopRemote();
    unsubscribe = docRef(uid).onSnapshot(
      (snap) => {
        if (snap.exists) reconcile(snap.data() || {});
      },
      (err) => console.warn("Sync: live updates stopped:", err),
    );
  }

  function stopRemote() {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  // ---------- push local changes ----------
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
      console.warn("Sync: push failed:", err);
    }
  }

  if (MODE === "required") {
    const bump = (key) => () => {
      if (applyingRemote) return;
      if (key) setMeta({ [key]: Date.now() });
      schedulePush();
    };
    window.addEventListener(
      "3nding:favorites-changed",
      bump("favoritesUpdatedAt"),
    );
    window.addEventListener(
      "3nding:settings-changed",
      bump("settingsUpdatedAt"),
    );
    window.addEventListener("3nding:progress-changed", bump(null));
  }

  // ---------- public API ----------
  async function signOut() {
    signingOut = true;
    try {
      clearTimeout(pushTimer);
      await pushNow(); // flush anything not yet uploaded
      stopRemote();
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

  // Account exists but the username couldn't be claimed (e.g. lost a race):
  // send them to the setup page rather than leaving them without one.
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
