// /account/: membership status, Stripe Customer Portal (card, plan, cancel), sign out.
// After checkout (?welcome=1) it re-checks a few times, because the webhook can land a moment later.
(async function () {
  const { ready, $, say, session, api, signInForm, resume, signOut } = window.RB;
  const welcome = !!new URLSearchParams(location.search).get("welcome");
  if (welcome) $("welcome").hidden = false;
  if (!ready) { $("closed").hidden = false; return; }

  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  async function load(tries) {
    const s = await session();
    $("out").hidden = !!s;
    $("in").hidden = !s;
    if (!s) return;
    $("who").textContent = "Signed in as " + (s.user.email || "a member");
    const { status, data } = await api("/api/me");
    if (status !== 200) return say($("msg"), data.message || "Couldn't load your account.", "no");
    if (data.member) {
      $("status").textContent = "You're a member. Every case file and book is open to you" + (data.memberUntil ? ", renewing or ending on " + day(data.memberUntil) + "." : ".");
      $("welcome").hidden = true;
    } else {
      $("status").textContent = data.books.length ? "You own: " + data.books.join(", ") + "." : "You're signed in, but not a member yet.";
      if (welcome && tries > 0) return void setTimeout(() => load(tries - 1), 3000);
    }
    $("join").hidden = data.member;
    $("manage").hidden = !data.billing;
  }

  $("manage").onclick = async () => {
    $("manage").disabled = true;
    const { status, data } = await api("/api/billing/portal", {});
    $("manage").disabled = false;
    if (status === 200 && data.url) return void (location.href = data.url);
    say($("msg"), data.message || "Couldn't open billing. Please try again.", "no");
  };
  $("out-btn").onclick = (e) => { e.preventDefault(); signOut(); };

  if (await resume()) return;
  signInForm(() => load(welcome ? 5 : 0));
  load(welcome ? 5 : 0);
})();
