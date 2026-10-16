#!/usr/bin/env python3
"""Build the Riddlebound site into _site/.

site/            static pages copied as-is
data/check/*.json answer-hash files exported by the editions tool
                  (publishing/tools/editions in the private repo). They hold
                  salted SHA-256 hashes only, never plain answers.

Each code gets a page at /check/<book>/<code>/ so the address printed in the
store ebook and paperback works.
"""
import html, json, os, re, shutil, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "_site")
SAFE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
FORBIDDEN = re.compile(r"\bmonad\b", re.I)

HEAD = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title><meta name="robots" content="{robots}"><meta name="theme-color" content="#0f1012">
<link rel="icon" href="/assets/logo.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Literata:opsz,wght@7..72,600&family=IBM+Plex+Mono:wght@400;600&family=Inter:wght@400;600&display=swap">
<link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="/assets/check.css"></head><body>
<header class="wrap bar"><a class="logo" href="/"><img src="/assets/logo.svg" width="30" height="30" alt=""><b>Riddlebound</b></a><a class="btn ghost" href="/#listen">Hear the show</a></header>
<main class="wrap card-wrap">"""
FOOT = """</main><footer><div class="wrap"><span>Riddlebound · Books from Long Light Press</span><span>© 2026 Long Light Press</span></div></footer>{script}</body></html>"""


def code_page(book, cid, c):
    data = {"salt": c["salt"], "hashes": c["hashes"]}
    body = f"""<div class="card">
<div class="kicker">{html.escape(book.get('title', book['book']))} · {html.escape(c.get('chapter', ''))}</div>
<h1>{html.escape(c.get('title', 'Code'))}</h1>
<p class="sub">Type the answer you worked out. Spaces and capitals don't matter.</p>
<form id="f" autocomplete="off"><input id="a" aria-label="Your answer" placeholder="Your answer" maxlength="60" autocapitalize="characters" spellcheck="false"><button class="btn">Check</button></form>
<div id="msg" class="msg" aria-live="polite"></div>
<div id="win" class="win" hidden><b>Cracked.</b> You solved it. Keep reading: the book picks up right where you left off.
<p>Want more? Every Riddlebound code also hides in the show. <a href="/#listen">Hear SIGNAL 309</a>.</p></div>
<p class="fine">Stuck? Hints for every code are at the back of the book. We never show answers here.</p>
</div>"""
    script = "<script>const C=" + json.dumps(data) + ";</script><script src=\"/assets/check.js\"></script>"
    return HEAD.format(title=f"Check your answer · {html.escape(c.get('title','Code'))} · Riddlebound", robots="noindex") + body + FOOT.format(script=script)


def index_page(n):
    body = """<div class="card"><div class="kicker">Check an answer</div><h1>Cracked a code?</h1>
<p class="sub">Under every code in a Riddlebound ebook or paperback there's an address like <span class="mono">riddlebound.app/check/sampler/ch1-walt</span>. Type the part after <span class="mono">/check/</span>.</p>
<form id="go" autocomplete="off"><input id="p" aria-label="Code address" placeholder="book/code" spellcheck="false" autocapitalize="none"><button class="btn">Go</button></form>
<div id="msg" class="msg" aria-live="polite"></div></div>"""
    script = """<script>document.getElementById('go').onsubmit=e=>{e.preventDefault();let v=document.getElementById('p').value.trim().toLowerCase().replace(/^.*\\/check\\//,'').replace(/^\\/+|\\/+$/g,'');if(!/^[a-z0-9-]+\\/[a-z0-9-]+$/.test(v)){document.getElementById('msg').className='msg no';document.getElementById('msg').textContent='That should look like book/code, for example sampler/ch1-walt.';return}location.href='/check/'+v+'/'};</script>"""
    return HEAD.format(title="Check an answer · Riddlebound", robots="index") + body + FOOT.format(script=script)


SUPABASE_JS = ('<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js" '
               'integrity="sha384-TcHRA3zBbn+Lexh5n+Oil4guNPOS3rjNDpGRAN46u/s/mB2IZ50ceC6TYDU2yvgK" crossorigin="anonymous"></script>')
SIGNIN = """<div id="out" hidden><p class="sub">{lead}</p>
<form id="signin" autocomplete="on" novalidate><input id="email" type="email" aria-label="Email" placeholder="you@example.com" autocomplete="email" class="plain"><button class="btn">Email me a link</button></form>
<div id="signin-msg" class="msg" aria-live="polite"></div></div>
<div id="closed" class="msg" hidden>Joining opens soon.</div>"""


def member_page(name, title, body):
    script = SUPABASE_JS + '<script src="/assets/rb-config.js"></script><script src="/assets/rb.js"></script>' + f'<script src="/assets/{name}.js"></script>'
    return HEAD.format(title=title, robots="noindex") + body + FOOT.format(script=script)


def join_page():
    body = """<div class="card"><div class="kicker">Membership</div><h1>Every case file. Every book.</h1>
<p class="sub">Riddlebound members open every puzzle dossier and interactive book. The codes are hidden in the books and the show.</p>
<div id="canceled" class="msg" hidden>Checkout canceled. You weren't charged.</div>
<div class="plans">
<div class="plan"><div class="kicker">Founding member</div><div class="price">$4.99<span>/month</span></div><p>Locked in for as long as you stay a member.</p><button class="btn" data-plan="month">Join monthly</button></div>
<div class="plan"><div class="kicker">Yearly</div><div class="price">$39.99<span>/year</span></div><p>About $3.33 a month.</p><button class="btn ghost" data-plan="year">Join yearly</button></div>
</div>
<div id="msg" class="msg" aria-live="polite"></div>
<p class="fine" id="who" hidden></p>
""" + SIGNIN.format(lead="First, sign in with your email. We'll send you a link, no password needed.") + """
<p class="fine">Payments by Stripe. Cancel anytime from <a href="/account/">your account</a>. Prices in US dollars; many countries see their own currency at checkout.</p></div>"""
    return member_page("join", "Join · Riddlebound", body)


def unlock_page():
    body = """<div class="card"><div class="kicker">Enter a code</div><h1>Heard a code?</h1>
<p class="sub">Codes are read at the end of the show and printed in the books, like <span class="mono" style="white-space:nowrap">GHOST-ZERO</span>.</p>
""" + SIGNIN.format(lead="Sign in first. Codes open files for members.") + """
<form id="f" autocomplete="off" hidden><input id="c" aria-label="Code" placeholder="CODE" maxlength="40" autocapitalize="characters" spellcheck="false"><button class="btn">Open</button></form>
<div id="msg" class="msg" aria-live="polite"></div>
<div id="win" class="win" hidden><b>Unlocked.</b> <span id="win-t"></span> <p><a id="file" class="btn" href="#" target="_blank" rel="noopener">Open the file</a></p><p>The link works for a few minutes. Enter the code again any time for a fresh one.</p></div>
<p class="fine" id="who" hidden></p></div>"""
    return member_page("unlock", "Enter a code · Riddlebound", body)


def account_page():
    body = """<div class="card"><div class="kicker">Your account</div><h1 id="h">Your Riddlebound</h1>
<div id="welcome" class="win" hidden><b>Welcome in.</b> Your membership can take a few seconds to show up here.</div>
""" + SIGNIN.format(lead="Sign in to see your membership.") + """
<div id="in" hidden><p class="sub" id="status"></p>
<p class="acts"><a class="btn" href="/unlock/">Enter a code</a> <button id="manage" class="btn ghost" hidden>Manage membership</button> <a id="join" class="btn ghost" href="/join/" hidden>Become a member</a></p>
<div id="msg" class="msg" aria-live="polite"></div>
<p class="fine"><span id="who"></span> · <a href="#" id="out-btn">Sign out</a></p></div></div>"""
    return member_page("account", "Account · Riddlebound", body)


def not_found():
    body = """<div class="card"><div class="kicker">Static on the line</div><h1>Nothing on this frequency.</h1>
<p class="sub">That page doesn't exist. If you typed a code address from a book, check the spelling, or <a href="/check/">enter it here</a>.</p><p><a class="btn" href="/">Back to Riddlebound</a></p></div>"""
    return HEAD.format(title="Not found · Riddlebound", robots="noindex") + body + FOOT.format(script="")


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    shutil.copytree(os.path.join(ROOT, "site"), OUT)
    count = 0
    ddir = os.path.join(ROOT, "data", "check")
    for fn in sorted(os.listdir(ddir)):
        if not fn.endswith(".json"):
            continue
        book = json.load(open(os.path.join(ddir, fn), encoding="utf-8"))
        bid = book["book"]
        assert SAFE.match(bid), f"bad book id {bid}"
        for cid, c in book["codes"].items():
            assert SAFE.match(cid), f"bad code id {cid}"
            assert c["hashes"] and all(re.fullmatch(r"[0-9a-f]{64}", h) for h in c["hashes"]), f"bad hashes in {bid}/{cid}"
            d = os.path.join(OUT, "check", bid, cid)
            os.makedirs(d, exist_ok=True)
            open(os.path.join(d, "index.html"), "w", encoding="utf-8").write(code_page(book, cid, c))
            count += 1
    os.makedirs(os.path.join(OUT, "check"), exist_ok=True)
    open(os.path.join(OUT, "check", "index.html"), "w", encoding="utf-8").write(index_page(count))
    open(os.path.join(OUT, "404.html"), "w", encoding="utf-8").write(not_found())
    for name, page in (("join", join_page), ("unlock", unlock_page), ("account", account_page)):
        os.makedirs(os.path.join(OUT, name), exist_ok=True)
        open(os.path.join(OUT, name, "index.html"), "w", encoding="utf-8").write(page())
    open(os.path.join(OUT, "CNAME"), "w").write("riddlebound.app\n")
    for dp, _, fs in os.walk(OUT):
        for f in fs:
            if f.endswith((".html", ".css", ".js", ".json")):
                if FORBIDDEN.search(open(os.path.join(dp, f), encoding="utf-8").read()):
                    sys.exit(f"forbidden name in {f}")
    print(f"built {count} code pages into {OUT}")


if __name__ == "__main__":
    main()
