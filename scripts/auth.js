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
  const REMOVED_KEY = "3nding:favorites-removed";
  const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
  const UNAME_MIN = 6;
  const UNAME_MAX = 14;

  const NETWORK_TIMEOUT_MS = 8000;
  const ACTION_COOLDOWN_MS = 5000;
  const SAVE_MIN_GAP_MS = 30 * 1000;
  const LOAD_MIN_GAP_MS = 5 * 60 * 1000;

  let sdkPromise = null;
  let auth = null;
  let db = null;
  let signingOut = false;
  let firstEvent = true;
  let busy = false;
  let currentUser;
  let refreshTimer = null;
  let changeSeq = 0;
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

  const ENUMS = {
    font: ["serif", "sans", "mono"],
    align: ["left", "justify"],
    theme: ["paper", "sepia", "dark"],
  };
  function sanitizeSettings(raw) {
    if (!isPlainObject(raw)) return null;
    const out = {};
    for (const [k, list] of Object.entries(ENUMS))
      if (list.includes(raw[k])) out[k] = raw[k];
    if (Number.isFinite(raw.size))
      out.size = Math.min(26, Math.max(14, Math.round(raw.size)));
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

  function loadSdk() {
    if (sdkPromise) return sdkPromise;
    sdkPromise = loadScript(SDK_CORE)
      .then(() => Promise.all(SDK_SERVICES.map(loadScript)))
      .catch((err) => {
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

  function cachedName(uid) {
    try {
      const c = JSON.parse(localStorage.getItem(UNAME_KEY) || "null");
      return c && c.uid === uid && c.name ? c.name : "";
    } catch {
      return "";
    }
  }

  const hasCloudData = (d) => Object.keys(d).some((k) => k !== "username");
  const hasLocalOnly = (plan) =>
    plan.fav.needsUpload ||
    plan.sett.localWon ||
    plan.prog.localWins.length > 0;

  // Runs once per account per device: one read gives username + saved data.
  async function bootstrapUser(user, isNew) {
    const cached = cachedName(user.uid);
    const m = readMeta();
    if (cached && (m.pulledUid === user.uid || m.lastSyncAt)) return cached;
    if (isNew) {
      setMeta({ pulledUid: user.uid });
      return cached;
    }
    const remote = await fetchRemote(user.uid);
    const name = remote.data.username || "";
    if (name) {
      try {
        localStorage.setItem(
          UNAME_KEY,
          JSON.stringify({ uid: user.uid, name }),
        );
      } catch {}
    }
    if (hasCloudData(remote.data)) {
      const plan = planMerge(remote.data);
      applyLocal(plan);
      setMeta({
        pulledUid: user.uid,
        lastSyncAt: Date.now(),
        lastCheckAt: Date.now(),
        unsynced: hasLocalOnly(plan),
      });
    } else {
      setMeta({ pulledUid: user.uid, lastCheckAt: Date.now() });
    }
    return name;
  }

  async function onAuthState(user) {
    currentUser = user || null;
    if (user && MODE !== "guest") {
      claimLocal(user.uid);
      let name = "";
      let known = true;
      try {
        name = await bootstrapUser(user, false);
      } catch (err) {
        console.warn("Auth: couldn't reach the cloud:", err);
        if (MODE === "setup") return showGateError();
        known = false;
        name = cachedName(user.uid);
      }
      if (MODE === "setup") {
        if (name) return location.replace(nextUrl());
        renderAccount(user, "");
        reveal();
      } else {
        if (known && !name) return redirectToSetup();
        renderAccount(user, name);
      }
    } else if (!user) {
      if (MODE === "setup" && !signingOut) redirectToLogin(false);
      if (MODE === "optional") renderGuest();
    }
    if (firstEvent) {
      firstEvent = false;
      resolveReady(user);
    }
  }

  // ---------- local storage ----------
  function readLocal() {
    let favorites = {},
      favoritesRemoved = {},
      settings = null;
    const progress = {};
    try {
      favorites = sanitizeFavorites(
        JSON.parse(localStorage.getItem(FAVORITES_KEY) || "{}"),
      );
    } catch {}
    try {
      favoritesRemoved = sanitizeFavorites(
        JSON.parse(localStorage.getItem(REMOVED_KEY) || "{}"),
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
    return { favorites, favoritesRemoved, settings, progress };
  }

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
      if (data.favoritesRemoved) put(REMOVED_KEY, data.favoritesRemoved);
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
    return changed;
  }

  function clearLocal() {
    const doomed = [
      FAVORITES_KEY,
      REMOVED_KEY,
      SETTINGS_KEY,
      META_KEY,
      UNAME_KEY,
      UID_KEY,
    ];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(PROGRESS_PREFIX) === 0) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  }

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
      Object.keys(l.favoritesRemoved).length > 0 ||
      Object.keys(l.progress).length > 0 ||
      !!l.settings
    );
  }

  function hasUnsynced() {
    const m = readMeta();
    if (m.unsynced === true) return true;
    return !m.lastSyncAt && hasLocalData();
  }

  // ---------- merge rules ----------
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

  function mergeFavorites(a, b, now) {
    const favorites = {};
    const removed = {};
    const ids = new Set([
      ...Object.keys(a.favorites),
      ...Object.keys(a.removed),
      ...Object.keys(b.favorites),
      ...Object.keys(b.removed),
    ]);
    ids.forEach((id) => {
      const addedAt = Math.max(a.favorites[id] || 0, b.favorites[id] || 0);
      const removedAt = Math.max(a.removed[id] || 0, b.removed[id] || 0);
      if (addedAt > 0 && addedAt >= removedAt) {
        favorites[id] = addedAt;
      } else if (removedAt > 0 && now - removedAt < TOMBSTONE_TTL_MS) {
        removed[id] = removedAt;
      }
    });
    return { favorites, removed };
  }

  function sameMap(x, y) {
    const kx = Object.keys(x);
    return (
      kx.length === Object.keys(y).length && kx.every((k) => x[k] === y[k])
    );
  }

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
    const remoteFav = sanitizeFavorites(remoteRaw.favorites);
    const remoteRem = sanitizeFavorites(remoteRaw.favoritesRemoved);

    const fav = mergeFavorites(
      { favorites: local.favorites, removed: local.favoritesRemoved },
      { favorites: remoteFav, removed: remoteRem },
      Date.now(),
    );

    return {
      fav: {
        value: fav.favorites,
        removed: fav.removed,
        needsUpload:
          !sameMap(fav.favorites, remoteFav) ||
          !sameMap(fav.removed, remoteRem),
      },
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
    const changed = writeLocal({
      favorites: plan.fav.value,
      favoritesRemoved: plan.fav.removed,
      settings: plan.sett.value,
      progress: plan.prog.merged,
    });
    setMeta({ settingsUpdatedAt: plan.sett.ts });
    return changed;
  }

  function buildUpload(plan) {
    const { FieldPath } = firebase.firestore;
    const data = {};
    const fields = [];
    let settingsTs = null;

    if (plan.fav.needsUpload) {
      data.favorites = plan.fav.value;
      data.favoritesRemoved = plan.fav.removed;
      fields.push("favorites", "favoritesRemoved");
    }
    if (plan.sett.localWon && plan.sett.value) {
      settingsTs = plan.sett.ts || Date.now();
      data.settings = plan.sett.value;
      data.settingsUpdatedAt = settingsTs;
      fields.push("settings", "settingsUpdatedAt");
    }
    if (plan.prog.localWins.length) {
      data.progress = {};
      plan.prog.localWins.forEach((id) => {
        data.progress[id] = plan.prog.merged[id];
        fields.push(new FieldPath("progress", id));
      });
    }
    return { data, fields, settingsTs };
  }

  const docRef = (uid) => db.collection("users").doc(uid);

  async function fetchRemote(uid) {
    const snap = await withTimeout(docRef(uid).get(), NETWORK_TIMEOUT_MS);
    return { exists: snap.exists, data: snap.exists ? snap.data() || {} : {} };
  }

  // ---------- manual sync operations ----------
  async function saveToCloud(user) {
    const seq = changeSeq;
    const ref = docRef(user.uid);
    let remoteData = {};
    let upload = null;

    await withTimeout(
      db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        remoteData = snap.exists ? snap.data() || {} : {};
        upload = buildUpload(planMerge(remoteData));
        if (upload.fields.length) {
          tx.set(ref, upload.data, { mergeFields: upload.fields });
        }
      }),
      NETWORK_TIMEOUT_MS,
    );

    // Re-merge against *current* local state so edits made during the await survive.
    applyLocal(planMerge(remoteAfterUpload(remoteData, upload.data)));
    if (upload.settingsTs) setMeta({ settingsUpdatedAt: upload.settingsTs });
    const now = Date.now();
    setMeta({
      unsynced: changeSeq !== seq,
      lastSyncAt: now,
      lastSaveAt: now,
      lastCheckAt: now,
    });
    return {
      message: upload.fields.length
        ? "Saved to the cloud."
        : "The cloud already has your latest data.",
    };
  }

  function remoteAfterUpload(remote, data) {
    const next = { ...remote };
    ["favorites", "favoritesRemoved", "settings", "settingsUpdatedAt"].forEach(
      (k) => {
        if (k in data) next[k] = data[k];
      },
    );
    if (data.progress)
      next.progress = { ...(remote.progress || {}), ...data.progress };
    return next;
  }

  async function loadFromCloud(user) {
    const seq = changeSeq;
    const remote = await fetchRemote(user.uid);
    setMeta({ lastCheckAt: Date.now() });
    if (!hasCloudData(remote.data))
      return {
        message: "Nothing saved in the cloud yet. Use “Save to cloud” first.",
      };
    const plan = planMerge(remote.data);
    const changed = applyLocal(plan);
    const localOnly = hasLocalOnly(plan);
    setMeta({
      lastSyncAt: Date.now(),
      unsynced: localOnly || changeSeq !== seq,
    });
    return {
      message: localOnly
        ? "Loaded. Some newer changes on this device are still unsaved."
        : changed
          ? "Loaded from the cloud."
          : "Already up to date.",
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

  function gate(kind) {
    const m = readMeta();
    const now = Date.now();
    if (kind === "save" && !hasUnsynced())
      return { ok: false, msg: "Nothing new to save." };
    const wait =
      kind === "save"
        ? (m.lastSaveAt || 0) + SAVE_MIN_GAP_MS - now
        : (m.lastCheckAt || 0) + LOAD_MIN_GAP_MS - now;
    if (wait > 0) {
      return {
        ok: false,
        msg:
          kind === "save"
            ? "Saved just now. Try again in " + Math.ceil(wait / 1000) + "s."
            : "Cloud checked recently. Try again in " +
              Math.ceil(wait / 60000) +
              " min.",
      };
    }
    return { ok: true };
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    const m = readMeta();
    const now = Date.now();
    const waits = [
      (m.lastSaveAt || 0) + SAVE_MIN_GAP_MS - now,
      (m.lastCheckAt || 0) + LOAD_MIN_GAP_MS - now,
    ].filter((w) => w > 0);
    if (waits.length)
      refreshTimer = setTimeout(renderIdleStatus, Math.min(...waits) + 50);
  }

  function refreshButtons() {
    if (!ui.save || !ui.load || !ui.signOut) return;
    const guest = currentUser === null;
    ui.load.hidden = guest;
    ui.signOut.hidden = guest;
    if (guest) {
      ui.save.textContent = "Sign in to sync";
      ui.save.disabled = false;
      ui.save.dataset.dirty = "false";
      return;
    }
    if (busy) return;
    const checking = currentUser === undefined;
    ui.save.textContent = "Save to cloud";
    ui.load.textContent = "Load from cloud";
    ui.save.disabled = checking || !gate("save").ok;
    ui.load.disabled = checking || !gate("load").ok;
    ui.signOut.disabled = checking;
    ui.save.dataset.dirty = String(hasUnsynced());
    scheduleRefresh();
  }

  function renderIdleStatus() {
    refreshButtons();
    if (currentUser === null)
      return setStatus(
        "Sync is optional. Your data stays on this device until you sign in.",
        "",
      );
    if (currentUser === undefined) return;
    const m = readMeta();
    if (hasUnsynced()) {
      const g = gate("save");
      setStatus(g.ok ? "Unsaved changes on this device." : g.msg, "dirty");
    } else if (m.lastSyncAt) {
      setStatus(
        "Synced " + formatTime(m.lastSyncAt) + ". Nothing new to save.",
        "good",
      );
    } else {
      setStatus(
        "Not synced yet. Tap “Load from cloud” to fetch your saved data.",
        "",
      );
    }
  }

  function setBusy(on, kind) {
    busy = on;
    if (ui.status) ui.status.setAttribute("aria-busy", String(on));
    if (!on) return refreshButtons();
    [ui.save, ui.load, ui.signOut].forEach((b) => b && (b.disabled = true));
    ui.save.textContent = kind === "save" ? "Saving…" : "Save to cloud";
    ui.load.textContent = kind === "load" ? "Loading…" : "Load from cloud";
  }

  async function runSync(kind) {
    if (busy) return;
    const user = auth && auth.currentUser;
    if (!user) return currentUser === null ? redirectToLogin(true) : undefined;
    if (!navigator.onLine)
      return setStatus(
        "You're offline. Try again once you're connected.",
        "error",
      );
    if (Date.now() - lastRun[kind] < ACTION_COOLDOWN_MS)
      return setStatus("One moment before trying that again.", "");
    const g = gate(kind);
    if (!g.ok) return setStatus(g.msg, "");

    lastRun[kind] = Date.now();
    setBusy(true, kind);
    setStatus(kind === "save" ? "Saving…" : "Loading…", "");
    try {
      const result =
        kind === "save" ? await saveToCloud(user) : await loadFromCloud(user);
      setStatus(result.message, "good");
    } catch (err) {
      console.warn("Sync: " + kind + " failed:", err);
      setStatus(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function onSignOut() {
    if (busy || !ui.signOut) return;
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
  }

  function initUi() {
    const $ = (id) => document.getElementById(id);
    ui.label = $("accountEmail");
    ui.save = $("cloudSaveBtn");
    ui.load = $("cloudLoadBtn");
    ui.status = $("syncStatus");
    ui.signOut = $("signOutBtn");
    if (ui.label && MODE === "optional")
      ui.label.textContent = "Checking account…";
    if (ui.save) ui.save.addEventListener("click", () => runSync("save"));
    if (ui.load) ui.load.addEventListener("click", () => runSync("load"));
    if (ui.signOut) ui.signOut.addEventListener("click", onSignOut);
    window.addEventListener("pagehide", () => clearTimeout(refreshTimer));
  }

  function renderAccount(user, name) {
    if (ui.label)
      ui.label.textContent = name
        ? "Signed in as @" + name
        : "Signed in as " + (user.email || "reader");
    if (MODE === "optional") renderIdleStatus();
  }

  function renderGuest() {
    if (ui.label) ui.label.textContent = "Reading as a guest";
    renderIdleStatus();
  }

  function offlineFallback() {
    if (MODE === "setup") return showGateError();
    if (MODE === "optional") {
      if (ui.label) ui.label.textContent = "Offline";
      setStatus(
        "Couldn't reach the sign-in service. Reading still works.",
        "error",
      );
    }
    resolveReady(null);
  }

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
    if (signingOut) return;
    changeSeq++;
    const m = readMeta();
    if (m.unsynced === true && !patch) return;
    setMeta(Object.assign({ unsynced: true }, patch));
    if (!busy) renderIdleStatus();
  }

  if (MODE === "optional") {
    window.addEventListener("3nding:favorites-changed", () => markUnsynced());
    window.addEventListener("3nding:settings-changed", () =>
      markUnsynced({ settingsUpdatedAt: Date.now() }),
    );
    window.addEventListener("3nding:progress-changed", () => markUnsynced());
    window.addEventListener("storage", (e) => {
      if (e.key === META_KEY && !busy) renderIdleStatus();
    });
  }

  // ---------- public API ----------
  async function signOut() {
    if (MODE === "optional" && hasUnsynced()) {
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
    window.dispatchEvent(
      new CustomEvent("3nding:signout-state", { detail: { active: true } }),
    );
    try {
      await auth.signOut();
      clearLocal();
      location.replace(MODE === "setup" ? LOGIN : HOME);
      return true;
    } catch (err) {
      signingOut = false;
      window.dispatchEvent(
        new CustomEvent("3nding:signout-state", { detail: { active: false } }),
      );
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

  async function claimUsername(raw) {
    const name = normalizeName(raw);
    const bad = validateUsername(name);
    if (bad) throw coded("username/invalid", bad);
    await api();
    const user = auth.currentUser;
    if (!user) throw coded("username/no-user", "Not signed in.");
    await withTimeout(
      docRef(user.uid).set({ username: name }, { merge: true }),
      NETWORK_TIMEOUT_MS,
    );
    try {
      localStorage.setItem(UNAME_KEY, JSON.stringify({ uid: user.uid, name }));
    } catch {}
    return name;
  }

  async function claimAfterSignup(user, username, isNewUser) {
    if (!username || !isNewUser) return;
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
    u.searchParams.set("reason", "failed");
    return u.href;
  }

  async function finishSignIn(cred, username) {
    const user = cred.user;
    const isNew = !!(
      cred.additionalUserInfo && cred.additionalUserInfo.isNewUser
    );
    claimLocal(user.uid);
    await claimAfterSignup(user, username, isNew);
    try {
      await withTimeout(bootstrapUser(user, isNew), NETWORK_TIMEOUT_MS);
    } catch (err) {
      console.warn("Auth: initial cloud load failed:", err);
    }
    return cred;
  }

  window.Auth = {
    ready,
    nextUrl,
    setupUrl,
    signOut,
    USERNAME: { min: UNAME_MIN, max: UNAME_MAX },
    validateUsername,
    claimUsername,
    async signInWithGoogle(username) {
      const a = await api();
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      return finishSignIn(await a.signInWithPopup(provider), username);
    },
    async signUpWithEmail(email, password, username) {
      const a = await api();
      return finishSignIn(
        await a.createUserWithEmailAndPassword(email, password),
        username,
      );
    },
    async signInWithEmail(email, password) {
      const a = await api();
      return finishSignIn(
        await a.signInWithEmailAndPassword(email, password),
        undefined,
      );
    },
    async sendPasswordReset(email) {
      return (await api()).sendPasswordResetEmail(email);
    },
  };

  const c = window.FIREBASE_CONFIG;
  let wasSignedIn = false;
  try {
    wasSignedIn = !!localStorage.getItem(UID_KEY);
  } catch {}

  if (MODE !== "guest") initUi();

  if (MODE === "optional" && !wasSignedIn) {
    // Guests never load Firebase: zero network, zero Firestore usage.
    currentUser = null;
    renderGuest();
    resolveReady(null);
  } else if (!c || !c.apiKey || c.apiKey === "YOUR_API_KEY") {
    console.error("Auth: scripts/firebase-config.js is not configured.");
    offlineFallback();
  } else {
    loadSdk()
      .then(ensureApp)
      .catch((err) => {
        console.warn("Auth: failed to load:", err);
        offlineFallback();
      });
  }
})();
