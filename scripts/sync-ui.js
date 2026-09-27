(function () {
  const row = document.getElementById("syncRow");
  const statusText = document.getElementById("syncStatusText");
  const signinBtn = document.getElementById("syncSigninBtn");
  const signoutBtn = document.getElementById("syncSignoutBtn");
  if (!row || !window.CloudSync) return;

  function render(detail) {
    if (!detail || !detail.configured) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    if (detail.signedIn) {
      statusText.textContent = "On — synced as " + detail.email;
      signinBtn.hidden = true;
      signoutBtn.hidden = false;
    } else {
      statusText.textContent = "Off — reading stays on this device.";
      signinBtn.hidden = false;
      signoutBtn.hidden = true;
    }
  }

  window.addEventListener("3nding:sync-status", (e) => render(e.detail));

  signinBtn.addEventListener("click", () => {
    signinBtn.disabled = true;
    const original = signinBtn.textContent;
    signinBtn.textContent = "Signing in…";
    window.CloudSync.enable()
      .catch((err) => alert("Sign-in failed: " + err.message))
      .finally(() => {
        signinBtn.disabled = false;
        signinBtn.textContent = original;
      });
  });

  signoutBtn.addEventListener("click", () => window.CloudSync.disable());

  // Paint whatever CloudSync already knows, even if its own status
  // event fired before this listener was attached.
  render(window.CloudSync.refreshStatus());
})();
