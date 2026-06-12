# New Music

An auto-updating feed of new album recommendations, gathered from a handful of trusted music writers and tastemakers. Live at https://vincentvenema.com/newmusic/

## How it works

`update.js` pulls recent recommendations from each source, rewrites the album lists inside `index.html`, and stamps the update time. A GitHub Action runs it on a schedule, commits any change, and deploys the site to Hostinger over FTPS.

Sources:
- funkentechno (Bluesky)
- Aquarium Drunkard (WordPress API)
- The Line of Best Fit (Bluesky)
- First Floor (Substack, one card per edition)
- Futurism Restated (Substack, one card per edition)

The site is a single self-contained `index.html`: markup, styles and the render script in one file, with the album data held in arrays that `update.js` maintains.

## Structure

```
.
├── index.html              the whole site (markup, CSS, render script, data)
├── update.js               the scraper, run by the Action
├── package.json
├── .github/workflows/
│   └── update.yml          schedule, run, commit, deploy
├── assets/
│   ├── favicon.svg
│   ├── apple-touch-icon.png
│   └── og-image.png        social share image
└── fonts/
    ├── ESPeak-Regular.woff2
    └── ESPeak-Medium.woff2
```

## Running it

Locally: `node update.js` (Node 18 or newer, no dependencies). It edits `index.html` in place.

On GitHub: the Action runs every six hours and can be triggered by hand from the Actions tab (workflow_dispatch).

## Deploy secrets

Set these as repository secrets for the FTPS deploy:
- `FTP_SERVER`
- `FTP_USERNAME`
- `FTP_PASSWORD`
- `FTP_TARGET_DIR` (the site folder, with a trailing slash, e.g. `/public_html/newmusic/`)

## Type

Set in ES Peak by Extraset (https://extraset.ch/typefaces/peak/), self-hosted from `fonts/`. ES Peak is a commercial typeface, so a webfont licence is needed to serve it publicly. JetBrains Mono (Google Fonts) is used for the dates.
