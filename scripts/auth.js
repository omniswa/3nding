/**
 * Authentication + MANUAL account-linked sync.
 *
 * data-auth="required"  -> page is gated. Signed-out visitors are sent to
 *                          the login page.
 * data-auth="guest"     -> login / signup pages.
 * data-auth="setup"     -> username picker page.
 *
 * Sync model (built to keep Firestore usage minimal):
 *  - localStorage is the working copy. Nothing touches Firestore
 *    automatically: no pull on load, no timers, no listeners.
 *  - "Save to cloud"  = 1 read + at most 1 write. Skipped entirely (0 ops)
 *    when nothing changed on this device since the last sync.
 *  - "Load from cloud" = 1 read, 0 writes.
 *  - Both merge with "newest wins" so neither direction destroys newer data.
 *  - Signing out clears this device's data, so unsaved changes trigger a
 *    confirmation first.
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
  const UNAME_MIN = 6;
  const UNAME_MAX = 14;
  const SETTING_KEYS = ["font", "size", "align", "theme"];

  const NETWORK_TIMEOUT_MS = 8000; // never let a hung request block the UI
  const ACTION_COOLDOWN_MS = 5000; // per-action spam guard

  let sdkPromise = null;
  let auth = null;
  let db = null;
  let signingOut = false;
  let firstEvent = true;
  let busy = false;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const lastRun = { save: 0, load: 0 };
  const ui = {};

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

  // Only known keys with primitive values are ever synced (matches the
  // Firestore rule that caps settings at 10 keys).
  function sanitizeSettings(raw) {
    if (!isPlainObject(raw)) return null;
    const out = {};
    SETTING_KEYS.forEach((k) => {
      const v = raw[k];
      if (typeof v === "string" || Number.isFinite(v)) out[k] = v;
    });
    return Object.keys(out).length ? out : null;
  }

  function formatTime(ts) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(ts));
    } catch {
      return new Date(ts).toLocaleString();
    }
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
    const box = document.createElement("div");
    box.className = "gate-error";
    box.setAttribute("role", "alert");
    const msg = document.createElement("p");
    msg.textContent =
      "The sign-in service couldn't be reached. Check your connection and try again.";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opt-btn";
    btn.textContent = "Retry";
    btn.addEventListener("click", () => location.reload());
    box.append(msg, btn);
    document.body.replaceChildren(box);
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
      settings = sanitizeSettings(
        JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"),
      );
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
  }

  // If a different reader signs in on this browser, don't let the
  // previous reader's data bleed into their account.
  function claimLocal(uid) {
    const prev = localStorage.getItem(UID_KEY);
    if (prev && prev !== uid) clearLocal();
    try {
      localStorage.setItem(UID_KEY, uid);
    } catch {}
  }

  function readMeta() {
    try {
      return JSON.parse(localStorage.getItem(META_KEY) || "{}") || {};
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

  function hasLocalData() {
    const l = readLocal();
    return (
      Object.keys(l.favorites).length > 0 ||
      Object.keys(l.progress).length > 0 ||
      !!l.settings
    );
  }

  // True when this device has changes the cloud copy may not have.
  // Also true for pre-existing local data that has never been synced.
  function hasUnsynced() {
    const m = readMeta();
    if (m.unsynced === true) return true;
    return !m.lastSyncAt && hasLocalData();
  }

  // ---------- merge rules ----------
  // Whole-value, last-writer-wins (favorites, settings).
  // `localWon` means local is genuinely newer and must be uploaded.
  function mergeWhole(local, remote, localTs, remoteTs) {
    localTs = localTs || 0;
    remoteTs = remoteTs || 0;
    if (remote == null) {
      const hasContent = isPlainObject(local) && Object.keys(local).length > 0;
      return {
        value: local,
        ts: localTs,
        localWon: local != null && (localTs > 0 || hasContent),
      };
    }
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

  function planMerge(remoteRaw) {
    const local = readLocal();
    const meta = readMeta();
    const remoteFavorites =
      remoteRaw.favorites == null
        ? null
        : sanitizeFavorites(remoteRaw.favorites);

    return {
      fav: mergeWhole(
        local.favorites,
        remoteFavorites,
        meta.favoritesUpdatedAt,
        remoteRaw.favoritesUpdatedAt,
      ),
      sett: mergeWhole(
        local.settings,
        sanitizeSettings(remoteRaw.settings),
        meta.settingsUpdatedAt,
        remoteRaw.settingsUpdatedAt,
      ),
      prog: mergeProgress(local.progress, sanitizeProgress(remoteRaw.progress)),
    };
  }

  function applyLocal(plan) {
    writeLocal({
      favorites: plan.fav.value,
      settings: plan.sett.value,
      progress: plan.prog.merged,
    });
    setMeta({
      favoritesUpdatedAt: plan.fav.ts,
      settingsUpdatedAt: plan.sett.ts,
    });
  }

  const docRef = (uid) => db.collection("users").doc(uid);

  async function fetchRemote(uid) {
    const snap = await withTimeout(docRef(uid).get(), NETWORK_TIMEOUT_MS);
    return { exists: snap.exists, data: snap.exists ? snap.data() || {} : {} };
  }

  // ---------- manual sync operations ----------
  async function saveToCloud(user) {
    const remote = await fetchRemote(user.uid); // 1 read
    const plan = planMerge(remote.data);
    applyLocal(plan);

    const data = {};
    const fields = [];
    const { FieldPath } = firebase.firestore;

    // mergeFields with a top-level name REPLACES that whole map, so removed
    // favorites really disappear.
    if (plan.fav.localWon) {
      const ts = plan.fav.ts || Date.now();
      data.favorites = plan.fav.value;
      data.favoritesUpdatedAt = ts;
      fields.push("favorites", "favoritesUpdatedAt");
      setMeta({ favoritesUpdatedAt: ts });
    }
    if (plan.sett.localWon && plan.sett.value) {
      const ts = plan.sett.ts || Date.now();
      data.settings = plan.sett.value;
      data.settingsUpdatedAt = ts;
      fields.push("settings", "settingsUpdatedAt");
      setMeta({ settingsUpdatedAt: ts });
    }
    if (plan.prog.localWins.length) {
      data.progress = {};
      plan.prog.localWins.forEach((id) => {
        data.progress[id] = plan.prog.merged[id];
        fields.push(new FieldPath("progress", id)); // touch only this book
      });
    }

    if (fields.length) {
      await withTimeout(
        docRef(user.uid).set(data, { mergeFields: fields }), // 1 write
        NETWORK_TIMEOUT_MS,
      );
    }
    setMeta({ unsynced: false, lastSyncAt: Date.now() });
    return {
      message: fields.length
        ? "Saved to the cloud."
        : "The cloud already has your latest data.",
    };
  }

  async function loadFromCloud(user) {
    const remote = await fetchRemote(user.uid); // 1 read, no write
    if (
      !remote.exists ||
      !Object.keys(remote.data).some((k) => k !== "username")
    ) {
      return {
        message: "Nothing saved in the cloud yet. Use “Save to cloud” first.",
      };
    }
    const plan = planMerge(remote.data);
    applyLocal(plan);
    const localOnly =
      plan.fav.localWon || plan.sett.localWon || plan.prog.localWins.length > 0;
    setMeta({ lastSyncAt: Date.now(), unsynced: localOnly });
    return {
      message: localOnly
        ? "Loaded. Some newer changes on this device are still unsaved."
        : "Loaded from the cloud.",
    };
  }

  function errorMessage(err) {
    if (err && err.code === "permission-denied")
      return "The cloud refused the request. Sign out, sign back in, and try again.";
    if (
      err &&
      (err.code === "sync/timeout" ||
        err.code === "unavailable" ||
        err.code === "deadline-exceeded")
    )
      return "Couldn't reach the cloud. Check your connection and try again.";
    return "Something went wrong. Please try again.";
  }

  // ---------- sync UI ----------
  function setStatus(text, state) {
    if (!ui.status) return;
    ui.status.textContent = text;
    ui.status.dataset.state = state || "";
  }

  function markDirtyButton() {
    if (ui.save) ui.save.dataset.dirty = String(hasUnsynced());
  }

  function renderIdleStatus() {
    markDirtyButton();
    const m = readMeta();
    if (hasUnsynced()) {
      setStatus("Unsaved changes on this device.", "dirty");
    } else if (m.lastSyncAt) {
      setStatus("Synced " + formatTime(m.lastSyncAt) + ".", "good");
    } else {
      setStatus(
        "Not synced yet. Tap “Load from cloud” to fetch your saved data.",
        "",
      );
    }
  }

  function setBusy(on, kind) {
    busy = on;
    [ui.save, ui.load, ui.signOut].forEach((b) => b && (b.disabled = on));
    if (ui.save)
      ui.save.textContent = on && kind === "save" ? "Saving…" : "Save to cloud";
    if (ui.load)
      ui.load.textContent =
        on && kind === "load" ? "Loading…" : "Load from cloud";
    if (ui.status) ui.status.setAttribute("aria-busy", String(on));
  }

  async function runSync(kind) {
    if (busy) return;
    const user = auth && auth.currentUser;
    if (!user) return;
    if (!navigator.onLine)
      return setStatus(
        "You're offline. Try again once you're connected.",
        "error",
      );
    if (Date.now() - lastRun[kind] < ACTION_COOLDOWN_MS)
      return setStatus("One moment before trying that again.", "");
    if (kind === "save" && !hasUnsynced()) {
      lastRun.save = Date.now();
      return setStatus("Nothing new to save.", "good");
    }

    setBusy(true, kind);
    setStatus(kind === "save" ? "Saving…" : "Loading…", "");
    try {
      const result =
        kind === "save" ? await saveToCloud(user) : await loadFromCloud(user);
      lastRun[kind] = Date.now();
      setStatus(result.message, "good");
    } catch (err) {
      console.warn("Sync: " + kind + " failed:", err);
      setStatus(errorMessage(err), "error");
    } finally {
      setBusy(false);
      markDirtyButton();
    }
  }

  function renderAccount(user, name) {
    ui.label = document.getElementById("accountEmail");
    ui.save = document.getElementById("cloudSaveBtn");
    ui.load = document.getElementById("cloudLoadBtn");
    ui.status = document.getElementById("syncStatus");
    ui.signOut = document.getElementById("signOutBtn");

    if (ui.label)
      ui.label.textContent = name
        ? "Signed in as @" + name
        : "Signed in as " + (user.email || "reader");

    if (ui.signOut && !ui.signOut.dataset.bound) {
      ui.signOut.dataset.bound = "1";
      ui.signOut.addEventListener("click", async () => {
        if (busy) return;
        ui.signOut.disabled = true;
        try {
          await signOut();
        } catch (err) {
          console.warn("Sign out failed:", err);
          setStatus(
            err && err.userMessage
              ? err.userMessage
              : "Couldn't sign out. Please try again.",
            "error",
          );
        } finally {
          if (!signingOut) ui.signOut.disabled = false;
        }
      });
    }
    if (ui.save && !ui.save.dataset.bound) {
      ui.save.dataset.bound = "1";
      ui.save.addEventListener("click", () => runSync("save"));
    }
    if (ui.load && !ui.load.dataset.bound) {
      ui.load.dataset.bound = "1";
      ui.load.addEventListener("click", () => runSync("load"));
    }
    if (MODE === "required") renderIdleStatus();
  }

  // Modal choice dialog built on the native <dialog> element.
  // Resolves with the chosen action id; Esc / backdrop close = "cancel".
  function askChoice({ title, message, actions }) {
    return new Promise((resolve) => {
      const dlg = document.createElement("dialog");
      dlg.className = "sync-dialog";
      const titleId = "syncDialogTitle";
      dlg.setAttribute("aria-labelledby", titleId);

      const h = document.createElement("h2");
      h.id = titleId;
      h.textContent = title;
      const p = document.createElement("p");
      p.textContent = message;
      const row = document.createElement("div");
      row.className = "sync-dialog-actions";

      let result = "cancel";
      actions.forEach((a) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "opt-btn" + (a.primary ? " is-primary" : "");
        b.textContent = a.label;
        b.addEventListener("click", () => {
          result = a.id;
          dlg.close();
        });
        row.appendChild(b);
      });

      dlg.append(h, p, row);
      dlg.addEventListener(
        "close",
        () => {
          dlg.remove();
          resolve(result);
        },
        { once: true },
      );
      document.body.appendChild(dlg);
      dlg.showModal();
    });
  }

  // ---------- change tracking (local only, zero network) ----------
  function markUnsynced(patch) {
    const m = readMeta();
    if (m.unsynced === true && !patch) return;
    setMeta(Object.assign({ unsynced: true }, patch));
    if (!busy) renderIdleStatus();
  }

  if (MODE === "required") {
    window.addEventListener("3nding:favorites-changed", () =>
      markUnsynced({ favoritesUpdatedAt: Date.now() }),
    );
    window.addEventListener("3nding:settings-changed", () =>
      markUnsynced({ settingsUpdatedAt: Date.now() }),
    );
    window.addEventListener("3nding:progress-changed", () => markUnsynced());
    // Keep the indicator right when another tab changes something.
    window.addEventListener("storage", (e) => {
      if (e.key === META_KEY && !busy) renderIdleStatus();
    });
  }

  // ---------- public API ----------
  async function signOut() {
    if (MODE === "required" && hasUnsynced()) {
      const choice = await askChoice({
        title: "Unsaved changes",
        message:
          "Signing out clears this device's saved data. Changes that aren't saved to the cloud will be lost.",
        actions: [
          { id: "save", label: "Save & sign out", primary: true },
          { id: "discard", label: "Sign out anyway" },
          { id: "cancel", label: "Cancel" },
        ],
      });
      if (choice === "cancel") return false;
      if (choice === "save") {
        try {
          await saveToCloud(auth.currentUser);
        } catch (err) {
          console.warn("Sync: save before sign-out failed:", err);
          const e = new Error("save failed");
          e.userMessage = errorMessage(err) + " You have not been signed out.";
          throw e;
        }
      }
    }
    signingOut = true;
    try {
      await auth.signOut();
      clearLocal(); // UID_KEY is kept on purpose; see claimLocal()
      location.replace(LOGIN);
      return true;
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
