(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const form = $("authForm");
  if (!form || !window.Auth) return;

  const mode = form.dataset.mode; // "login" | "signup" | "setup"
  const errBox = $("formError");
  const infoBox = $("formInfo");
  const submitBtn = $("submitBtn");
  const googleBtn = $("googleBtn");
  const forgotBtn = $("forgotBtn");
  const email = $("email");
  const password = $("password");
  const confirmPw = $("confirm");
  const uname = $("username");
  const unameHint = $("usernameHint");
  const { min: MIN, max: MAX } = Auth.USERNAME;

  const SILENT = new Set([
    "auth/popup-closed-by-user",
    "auth/cancelled-popup-request",
  ]);
  const MESSAGES = {
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/missing-email": "Enter your email address first.",
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/wrong-password": "Email or password is incorrect.",
    "auth/user-not-found": "Email or password is incorrect.",
    "auth/email-already-in-use":
      "An account with that email already exists. Try signing in instead.",
    "auth/weak-password": "Choose a stronger password (at least 8 characters).",
    "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
    "auth/network-request-failed":
      "Network problem. Check your connection and try again.",
    "auth/user-disabled": "This account has been disabled.",
    "auth/popup-blocked":
      "Your browser blocked the sign-in pop-up. Allow pop-ups for this site and try again.",
    "auth/operation-not-allowed": "This sign-in method isn't enabled yet.",
    "auth/unauthorized-domain": "This domain isn't authorized for sign-in yet.",
    "username/unavailable": "Choose a valid, available username first.",
    "username/taken": "That username isn't available. Try another.",
    "username/invalid": "That username isn't valid.",
  };

  function show(box, msg) {
    if (!box) return;
    box.textContent = msg || "";
    box.hidden = !msg;
  }

  function setBusy(on) {
    [submitBtn, googleBtn, forgotBtn].forEach((b) => b && (b.disabled = on));
    submitBtn.textContent = on
      ? submitBtn.dataset.busy
      : submitBtn.dataset.label;
    form.setAttribute("aria-busy", String(on));
  }

  async function run(task) {
    show(errBox, "");
    show(infoBox, "");
    setBusy(true);
    try {
      await task();
      location.replace(Auth.nextUrl()); // stay "busy" while we navigate
    } catch (err) {
      // Account exists but its username was lost to someone else: finish on the setup page.
      if (err.accountCreated) return location.replace(Auth.setupUrl());
      setBusy(false);
      if (!SILENT.has(err.code)) {
        show(
          errBox,
          MESSAGES[err.code] || "Something went wrong. Please try again.",
        );
      }
    }
  }

  // ---------- username field ----------
  const norm = () => uname.value.trim().toLowerCase();
  let last = { name: "", ok: false }; // last availability result
  let seq = 0;
  let timer = null;

  function hint(text, state) {
    unameHint.textContent = text;
    unameHint.dataset.state = state || "";
  }

  async function checkName() {
    const name = norm();
    const mine = ++seq;
    if (!name) {
      hint(MIN + "–" + MAX + " characters: letters, numbers, underscores.", "");
      return false;
    }
    const bad = Auth.validateUsername(name);
    if (bad) {
      hint(bad, "bad");
      return false;
    }
    if (last.name === name) return last.ok; // cached, keeps the Google pop-up gesture-friendly
    hint("Checking…", "");
    try {
      const ok = await Auth.isUsernameAvailable(name);
      last = { name, ok };
      if (mine === seq)
        hint(ok ? "Available." : "Already taken.", ok ? "good" : "bad");
      return ok;
    } catch {
      if (mine === seq) hint("Couldn't check right now. Try again.", "bad");
      return false;
    }
  }

  async function requireName() {
    if (await checkName()) return;
    const e = new Error("unavailable");
    e.code = "username/unavailable";
    uname.focus();
    throw e;
  }

  if (uname) {
    uname.addEventListener("input", () => {
      uname.value = uname.value.toLowerCase().replace(/[^a-z0-9_]/g, "");
      clearTimeout(timer);
      timer = setTimeout(checkName, 350);
    });
  }

  // ---------- handlers ----------
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (mode === "setup") {
      return run(async () => {
        await requireName();
        await Auth.claimUsername(norm());
      });
    }
    const em = email.value.trim();
    if (mode === "signup") {
      if (password.value.length < 8)
        return show(errBox, MESSAGES["auth/weak-password"]);
      if (password.value !== confirmPw.value)
        return show(errBox, "Those passwords don't match.");
      run(async () => {
        await requireName(); // nothing is created until the username is free
        await Auth.signUpWithEmail(em, password.value, norm());
      });
    } else {
      run(() => Auth.signInWithEmail(em, password.value));
    }
  });

  if (googleBtn) {
    googleBtn.addEventListener("click", () =>
      run(async () => {
        if (mode === "signup") await requireName();
        await Auth.signInWithGoogle(mode === "signup" ? norm() : undefined);
      }),
    );
  }

  if (forgotBtn) {
    forgotBtn.addEventListener("click", async () => {
      show(errBox, "");
      show(infoBox, "");
      const em = email.value.trim();
      if (!em) {
        show(errBox, MESSAGES["auth/missing-email"]);
        email.focus();
        return;
      }
      setBusy(true);
      try {
        await Auth.sendPasswordReset(em);
        show(
          infoBox,
          "If an account exists for " + em + ", a reset link is on its way.",
        );
      } catch (err) {
        show(
          errBox,
          MESSAGES[err.code] ||
            "Couldn't send the reset email. Please try again.",
        );
      }
      setBusy(false);
    });
  }

  document.querySelectorAll(".pw-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = $(btn.dataset.target);
      const hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      btn.textContent = hidden ? "hide" : "show";
      btn.setAttribute("aria-pressed", String(hidden));
    });
  });

  const swap = $("swapLink");
  if (swap && location.search) swap.search = location.search;

  if (mode === "setup") {
    if (new URLSearchParams(location.search).get("reason") === "taken") {
      show(
        errBox,
        "That username was taken while you were signing up. Please choose another.",
      );
    }
  } else {
    Auth.ready.then((user) => {
      if (user) location.replace(Auth.nextUrl());
    });
  }
})();
