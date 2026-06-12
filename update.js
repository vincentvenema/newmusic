// update.js
// Polls funkentechno's Bluesky feed for posts with Bandcamp links,
// enriches with Bandcamp metadata, regenerates index.html.
//
// Usage: node update.js
// Requires: Node 18+

import { readFile, writeFile } from 'fs/promises';

const HANDLE = 'funkentechno.bsky.social';
const BSKY_API = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed';
const PAGE_LIMIT = 100;          // posts per API page (max 100)
const MAX_PAGES = 25;            // safety cap on how far we page back
const SINCE = new Date('2026-01-01T00:00:00Z');  // only collect posts from this date on
const HTML_FILE = 'index.html';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAuthorFeedPage(actor, cursor) {
  let url = `${BSKY_API}?actor=${encodeURIComponent(actor)}&limit=${PAGE_LIMIT}&filter=posts_no_replies`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bluesky API ${res.status}`);
  return res.json();
}

// Page back through the feed (newest first) until we pass the cutoff date.
async function fetchPostsSince(actor, cutoff) {
  const posts = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await fetchAuthorFeedPage(actor, cursor);
    const batch = (data.feed || []).map((item) => item.post);
    posts.push(...batch);
    cursor = data.cursor;
    if (!cursor || batch.length === 0) break;
    const oldest = batch[batch.length - 1];
    if (oldest?.record?.createdAt && new Date(oldest.record.createdAt) < cutoff) break;
  }
  return posts;
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

function extractNote(text, artist, album, maxLen = 320) {
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

// ---- generic helpers for per-source arrays in index.html ----
function readArray(template, key) {
  const re = new RegExp('const ALBUMS_' + key + ' = (\\[[\\s\\S]*?\\n\\]);');
  const m = template.match(re);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

function replaceArray(template, key, albums) {
  const re = new RegExp('const ALBUMS_' + key + ' = (\\[[\\s\\S]*?\\n\\]);');
  if (!re.test(template)) {
    console.error(`  could not find ALBUMS_${key} in ${HTML_FILE}, leaving unchanged`);
    return template;
  }
  const body = albums.length ? JSON.stringify(albums, null, 2) : '[\n]';
  return template.replace(re, () => `const ALBUMS_${key} = ${body};`);
}

// ---- funkentechno (Bluesky) ----
async function buildFunkentechno(existing) {
  const posts = await fetchPostsSince(HANDLE, SINCE);
  const byUrl = new Map((existing || []).map((a) => [normalizeUrl(a.bandcamp), a]));
  const seen = new Set();
  const albums = [];
  for (const post of posts) {
    const created = post?.record?.createdAt ? new Date(post.record.createdAt) : null;
    if (!created || created < SINCE) continue;
    const bcUrl = extractBandcampUrl(post);
    if (!bcUrl) continue;
    const normUrl = normalizeUrl(bcUrl);
    if (seen.has(normUrl)) continue;
    seen.add(normUrl);
    if (byUrl.has(normUrl)) { albums.push(byUrl.get(normUrl)); continue; }
    process.stdout.write(`  bandcamp ${normUrl} ... `);
    try {
      await sleep(300);
      const meta = await fetchBandcampMeta(normUrl);
      const note = extractNote(post.record.text, meta.artist, meta.album);
      const date = formatDate(post.record.createdAt);
      albums.push({ ...meta, note, date });
      console.log('ok');
    } catch (e) { console.log(`failed (${e.message})`); }
  }
  return albums;
}

// ---- Aquarium Drunkard (WordPress REST API) ----
const AD_API = 'https://aquariumdrunkard.com/wp-json/wp/v2/posts';

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#8217;|&#8216;|&#0?39;|&#x27;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&#8211;|&#8212;/g, '-')
    .replace(/&#8230;/g, '…')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

function stripHtml(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

async function fetchADPosts(sinceISO) {
  const posts = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${AD_API}?per_page=100&_embed=1&orderby=date&order=desc&after=${encodeURIComponent(sinceISO)}&page=${page}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'NewMusicFeed/1.0' } });
    if (res.status === 400) break;            // page past the last
    if (!res.ok) throw new Error(`AD API ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    posts.push(...batch);
    if (batch.length < 100) break;
  }
  return posts;
}

function parseADPost(post) {
  const content = (post.content && post.content.rendered) || '';
  const spotify = (content.match(/https:\/\/open\.spotify\.com\/album\/[A-Za-z0-9]+/) || [])[0] || '';
  const apple = (content.match(/https:\/\/music\.apple\.com\/[a-z]{2}\/album\/[^"'\s)]+/) || [])[0] || '';
  const bandcamp = (content.match(/https:\/\/[\w-]+\.bandcamp\.com\/album\/[^"'\s)]+/) || [])[0] || '';
  const title = stripHtml((post.title && post.title.rendered) || '');
  const lower = title.toLowerCase();
  const EXCLUDE = ['aquarium drunkard show', 'book club', 'lagniappe', 'transmissions', 'all one song', 'videodrome', 'yesternow', 'picture show', 'mixtape', 'sirius', 'decade', 'interview', 'playlist', ' radio'];
  if (EXCLUDE.some((w) => lower.includes(w))) return null;    // not an album review

  const parts = title.split(/\s*::\s*/);
  if (parts.length < 2) return null;                          // not the "Artist :: Album" format
  const artist = parts[0].trim();
  const album = parts.slice(1).join(' :: ').trim();
  if (!artist || !album) return null;

  let cover = '';
  try { cover = post._embedded['wp:featuredmedia'][0].source_url || ''; } catch (e) { cover = ''; }

  if (!cover && !spotify && !apple && !bandcamp) return null; // skip text-only non-album posts

  const note = stripHtml((post.excerpt && post.excerpt.rendered) || '')
    .replace(/\s*\[?\s*…\s*\]?\s*$/, '')
    .slice(0, 320);

  const out = { artist, album, note, cover, date: formatDate(post.date), url: post.link || '' };
  if (spotify) out.spotify = spotify;
  if (apple) out.apple = apple;
  if (bandcamp) out.bandcamp = bandcamp;
  return out;
}

async function buildAquariumDrunkard() {
  const posts = await fetchADPosts(SINCE.toISOString());
  console.log(`  ${posts.length} posts scanned`);
  const seen = new Set();
  const albums = [];
  for (const post of posts) {
    const a = parseADPost(post);
    if (!a) continue;
    const key = (a.url || a.spotify || a.apple).split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    albums.push(a);
  }
  return albums;
}

// ---- orchestrate all sources, write index.html once ----
// ---- The Line of Best Fit (Bluesky link posts) ----
async function buildLineOfBestFit() {
  const posts = await fetchPostsSince('thelineofbestfit.com', SINCE);
  const seen = new Set();
  const albums = [];
  for (const post of posts) {
    const created = post?.record?.createdAt ? new Date(post.record.createdAt) : null;
    if (!created || created < SINCE) continue;
    const ext = (post.embed && post.embed.external) || (post.record && post.record.embed && post.record.embed.external);
    if (!ext || !ext.uri) continue;
    const title = String(ext.title || '').trim();
    const isAlbum = ext.uri.includes('/albums/') || /:\s.+\sreview\b/i.test(title);
    if (!isAlbum) continue;
    const url = ext.uri.split('?')[0];
    if (seen.has(url)) continue;
    seen.add(url);
    let artist = '';
    let album = title;
    const m = title.match(/^(.+?):\s*(.+?)\s+review\b/i);
    if (m) { artist = m[1].trim(); album = m[2].trim(); }
    albums.push({
      artist,
      album,
      note: String(ext.description || '').slice(0, 320),
      cover: typeof ext.thumb === 'string' ? ext.thumb : '',
      date: formatDate(post.record.createdAt),
      url
    });
  }
  return albums;
}

async function main() {
  let template = await readFile(HTML_FILE, 'utf-8');
  let changed = false;

  try {
    console.log('funkentechno: fetching Bluesky...');
    const existing = readArray(template, 'FUNKENTECHNO') || [];
    const albums = await buildFunkentechno(existing);
    if (albums.length) { template = replaceArray(template, 'FUNKENTECHNO', albums); changed = true; console.log(`  ${albums.length} albums`); }
    else console.log('  no albums found, leaving unchanged');
  } catch (e) { console.error('funkentechno failed:', e.message); }

  try {
    console.log('aquarium drunkard: fetching WordPress API...');
    const albums = await buildAquariumDrunkard();
    if (albums.length) { template = replaceArray(template, 'AQUARIUMDRUNKARD', albums); changed = true; console.log(`  ${albums.length} albums`); }
    else console.log('  no albums found, leaving unchanged');
  } catch (e) { console.error('aquarium drunkard failed:', e.message); }

  try {
    console.log('line of best fit: fetching Bluesky...');
    const albums = await buildLineOfBestFit();
    if (albums.length) { template = replaceArray(template, 'LOBF', albums); changed = true; console.log(`  ${albums.length} albums`); }
    else console.log('  no albums found, leaving unchanged');
  } catch (e) { console.error('line of best fit failed:', e.message); }

  if (!changed) { console.log('\nNo changes.'); return; }
  await writeFile(HTML_FILE, template);
  console.log(`\nWrote ${HTML_FILE}`);
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
