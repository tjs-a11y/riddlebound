// /unlock/: a signed-in reader types a code heard in the show → the API checks it → a short-lived file link.
// /unlock/?code=GHOST-ZERO pre-fills the box (and survives the emailed sign-in link).
(async function () {
  const { ready, $, say, session, api, signInForm } = window.RB;
  const msg = $("msg");
  const pre = (new URLSearchParams(location.search).get("code") || "").slice(0, 40);
  if (!ready) { $("closed").hidden = false; return; }

  async function show() {
    const s = await session();
    $("out").hidden = !!s;
    $("f").hidden = !s;
    if (!s) return;
    $("who").hidden = false;
    $("who").textContent = "Signed in as " + (s.user.email || "a member") + ".";
    if (pre && !$("c").value) $("c").value = pre;
    $("c").focus();
  }

  $("f").onsubmit = async (e) => {
    e.preventDefault();
    const code = $("c").value.trim();
    if (code.length < 3) return say(msg, "Type the code first.", "no");
    $("win").hidden = true;
    say(msg, "Checking…");
    const { status, data } = await api("/api/codes/redeem", { code });
    if (status === 200) {
      say(msg, "");
      $("win-t").textContent = data.firstTime ? "New file added to your case history." : "You've opened this one before.";
      $("file").href = data.contentUrl;
      $("win").hidden = false;
      return;
    }
    if (status === 401) { $("f").hidden = true; $("out").hidden = false; return say(msg, "Your sign-in expired. Sign in again.", "no"); }
    if (status === 403) {
      msg.className = "msg no";
      msg.textContent = "Right code. This file is for members. ";
      const a = document.createElement("a");
      a.href = "/join/";
      a.textContent = "Become a member";
      msg.appendChild(a);
      return;
    }
    say(msg, data.message || "Something went wrong. Please try again.", "no");
  };

  signInForm(show);
  show();
})();
