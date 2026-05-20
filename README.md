# huub

Album feed for [@funkentechno](https://bsky.app/profile/funkentechno.bsky.social), auto-updated from Bluesky.

## Files

- `index.html` — the website (single self-contained file, this is the only thing that goes on Hostinger)
- `update.js` — fetches Bluesky posts, enriches with Bandcamp metadata, regenerates `index.html`
- `enrich.js` — manual override, reads `input.txt` and regenerates `index.html` from a curated list
- `input.txt` — manual entries for `enrich.js`
- `.github/workflows/update.yml` — GitHub Action, runs `update.js` every 6 hours and deploys to Hostinger via FTP

## Required GitHub Secrets

Set under Settings → Secrets and variables → Actions:

- `FTP_SERVER` — Hostinger FTP hostname
- `FTP_USERNAME` — Hostinger FTP username
- `FTP_PASSWORD` — Hostinger FTP password
- `FTP_TARGET_DIR` — path on the server (e.g. `/public_html/huub/`)

## Manual update

Run the workflow manually from the Actions tab. Or locally:

```
node update.js
```

For a curated list instead of Bluesky-derived:

```
node enrich.js
```
