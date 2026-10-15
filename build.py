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
    open(os.path.join(OUT, "CNAME"), "w").write("riddlebound.app\n")
    for dp, _, fs in os.walk(OUT):
        for f in fs:
            if f.endswith((".html", ".css", ".js", ".json")):
                if FORBIDDEN.search(open(os.path.join(dp, f), encoding="utf-8").read()):
                    sys.exit(f"forbidden name in {f}")
    print(f"built {count} code pages into {OUT}")


if __name__ == "__main__":
    main()
