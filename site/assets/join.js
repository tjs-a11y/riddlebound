// /join/: pick a plan → (sign in by email if needed) → Stripe Checkout.
(async function () {
  const { ready, $, say, session, api, signInForm } = window.RB;
  const msg = $("msg");
  if (new URLSearchParams(location.search).get("canceled")) $("canceled").hidden = false;
  if (!ready) { $("closed").hidden = false; document.querySelectorAll("[data-plan]").forEach((b) => (b.disabled = true)); return; }

  const wanted = new URLSearchParams(location.search).get("plan");
  async function go(plan) {
    if (!(await session())) {
      // Remember the plan through the emailed link, then ask for the email.
      history.replaceState(null, "", "/join/?plan=" + plan);
      $("out").hidden = false;
      $("email").focus();
      return;
    }
    document.querySelectorAll("[data-plan]").forEach((b) => (b.disabled = true));
    say(msg, "Opening secure checkout…");
    const { status, data } = await api("/api/checkout", { plan });
    if (status === 200 && data.url) return void (location.href = data.url);
    document.querySelectorAll("[data-plan]").forEach((b) => (b.disabled = false));
    if (data.error === "already_member") {
      msg.className = "msg ok";
      msg.innerHTML = 'You\'re already a member. <a href="/account/">Go to your account</a>.';
      return;
    }
    say(msg, data.message || "Something went wrong. Please try again.", "no");
  }
  document.querySelectorAll("[data-plan]").forEach((b) => (b.onclick = () => go(b.dataset.plan)));
  signInForm(() => { if (wanted === "month" || wanted === "year") go(wanted); });
  if ((await session()) && (wanted === "month" || wanted === "year")) go(wanted);
})();
