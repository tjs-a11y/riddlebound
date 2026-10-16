// Shared code for the member pages (/join/, /unlock/, /account/).
// Sign-in is an emailed link (no passwords). The access token goes to the Riddlebound API in the
// Authorization header; the API checks it with Supabase and never trusts anything else.
(function () {
  const C = window.RB_CONFIG || {};
  const ready = !!(C.supabaseUrl && C.supabaseKey && window.supabase);
  const sb = ready ? window.supabase.createClient(C.supabaseUrl, C.supabaseKey, { auth: { flowType: "implicit", detectSessionInUrl: true, persistSession: true } }) : null;
  const $ = (id) => document.getElementById(id);

  function say(el, text, kind) {
    el.className = "msg" + (kind ? " " + kind : "");
    el.textContent = text;
  }

  async function session() {
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data.session || null;
  }

  async function api(path, body) {
    const s = await session();
    const res = await fetch(C.api + path, {
      method: body === undefined ? "GET" : "POST",
      headers: Object.assign({ "content-type": "application/json" }, s ? { authorization: "Bearer " + s.access_token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch (e) { data = { ok: false, message: "Unexpected answer from the server." }; }
    return { status: res.status, data };
  }

  // Wires a sign-in box: <form id="signin"><input id="email"><button></form><div id="signin-msg">.
  // The emailed link comes back to this same page (extra query kept, e.g. ?code=...).
  function signInForm(onSignedIn) {
    const form = $("signin");
    const msg = $("signin-msg");
    if (!form) return;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const email = $("email").value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return say(msg, "That email doesn't look right.", "no");
      form.querySelector("button").disabled = true;
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname + location.search } });
      form.querySelector("button").disabled = false;
      if (error) return say(msg, error.status === 429 ? "Too many sign-in emails. Wait a few minutes and try again." : "We couldn't send the email. Try again in a minute.", "no");
      say(msg, "Check your inbox for a sign-in link from Riddlebound. Open it on this device.", "ok");
    };
    if (sb) sb.auth.onAuthStateChange((event, s) => { if (s && event === "SIGNED_IN" && onSignedIn) onSignedIn(s); });
  }

  async function signOut() {
    if (sb) await sb.auth.signOut();
    location.reload();
  }

  window.RB = { ready, sb, $, say, session, api, signInForm, signOut };
})();
