// update.js
// Polls funkentechno's Bluesky feed for posts with Bandcamp links,
// enriches with Bandcamp metadata, regenerates index.html.
//
// Usage: node update.js
// Requires: Node 18+

import { readFile, writeFile } from 'fs/promises';

const HANDLE = 'funkentechno.bsky.social';
const BSKY_API = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed';
const POSTS_TO_SCAN = 100;
const MAX_ALBUMS = 12;
const HTML_FILE = 'index.html';

async function fetchBlueskyPosts() {
  const url = `${BSKY_API}?actor=${HANDLE}&limit=${POSTS_TO_SCAN}&filter=posts_no_replies`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bluesky API ${res.status}`);
  const data = await res.json();
  return data.feed.map(item => item.post);
}

function extractBandcampUrl(post) {
  // Prefer structured facets (rich text links) over regex
  const facets = post.record.facets || [];
  for (const facet of facets) {
    for (const feature of (facet.features || [])) {
      if (feature.$type === 'app.bsky.richtext.facet#link' &&
          feature.uri && feature.uri.includes('bandcamp.com/album/')) {
        return feature.uri;
      }
    }
  }
  // Embedded external links
  const embed = post.record.embed;
  if (embed && embed.external && embed.external.uri && embed.external.uri.includes('bandcamp.com/album/')) {
    return embed.external.uri;
  }
  // Last resort, regex
  const text = post.record.text || '';
  const match = text.match(/https:\/\/[^\s]+\.bandcamp\.com\/album\/[^\s)]+/);
  return match ? match[0] : null;
}

function extractNote(text, artist, album, maxLen = 220) {
  let clean = (text || '').replace(/https?:\/\/\S+/g, '').trim();

  // If the post starts with "Artist - Album" or similar, strip that off
  if (artist && album) {
    const re = new RegExp(`^\\s*${artist.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*[\\-–—:]\\s*${album.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*[\\.\\n]?`, 'i');
    clean = clean.replace(re, '').trim();
  }

  // Collapse whitespace
  clean = clean.replace(/\s+/g, ' ').trim();

  if (clean.length > maxLen) {
    clean = clean.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
  }
  return clean;
}

async function fetchBandcampMeta(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FunkentechnoFeed/1.0)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const meta = (prop) => {
    const re = new RegExp(`<meta property="og:${prop}" content="([^"]+)"`, 'i');
    return (html.match(re) || [])[1] || '';
  };

  const title = meta('title');
  const match = title.match(/^(.+),\s*by\s+(.+)$/i);
  const album = match ? match[1].trim() : title;
  const artist = match ? match[2].trim() : '';

  return {
    artist,
    album,
    bandcamp: meta('url') || url,
    cover: meta('image')
  };
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

function normalizeUrl(u) {
  return u.split('?')[0].replace(/\/$/, '');
}

async function main() {
  console.log(`Fetching posts from @${HANDLE}...`);
  const posts = await fetchBlueskyPosts();
  console.log(`  ${posts.length} posts retrieved`);

  const seen = new Set();
  const albums = [];

  for (const post of posts) {
    if (albums.length >= MAX_ALBUMS) break;

    const bcUrl = extractBandcampUrl(post);
    if (!bcUrl) continue;

    const normUrl = normalizeUrl(bcUrl);
    if (seen.has(normUrl)) continue;
    seen.add(normUrl);

    process.stdout.write(`  ${normUrl} ... `);
    try {
      const meta = await fetchBandcampMeta(normUrl);
      const note = extractNote(post.record.text, meta.artist, meta.album);
      const date = formatDate(post.record.createdAt);
      albums.push({ ...meta, note, date });
      console.log('ok');
    } catch (e) {
      console.log(`failed (${e.message})`);
    }
  }

  if (albums.length === 0) {
    console.log('\nNo albums found. Leaving index.html unchanged.');
    return;
  }

  const template = await readFile(HTML_FILE, 'utf-8');
  const json = JSON.stringify(albums, null, 2);
  const updated = template.replace(
    /const albums = \[[\s\S]*?\n\];/,
    `const albums = ${json};`
  );

  if (updated === template) {
    console.error('\nWarning: could not find const albums array in index.html');
    process.exit(1);
  }

  await writeFile(HTML_FILE, updated);
  console.log(`\nWrote ${albums.length} albums to ${HTML_FILE}`);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
