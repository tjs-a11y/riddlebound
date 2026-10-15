# Riddlebound

Public site for Riddlebound (riddlebound.app): interactive books from Long Light Press.

- `site/`: static pages (landing page, styles, assets)
- `data/check/<book>.json`: salted answer hashes exported by the editions tool. **Never put plain answers in this repo.**
- `build.py`: builds `_site/`, including one "check your answer" page per code at `/check/<book>/<code>/`
- `.github/workflows/pages.yml`: builds and deploys to GitHub Pages on every push to `main`, then checks the live site

Run locally: `python3 build.py`, then open `_site/index.html`.
