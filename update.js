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

function setUpdated(template) {
  const re = /const LAST_UPDATED = "[^"]*";/;
  if (!re.test(template)) return template;
  return template.replace(re, () => `const LAST_UPDATED = "${new Date().toISOString()}";`);
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

function snippet(text, max) {
  let s = String(text || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

async function fetchADPosts(sinceISO) {
  const posts = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${AD_API}?per_page=100&_embed=1&orderby=date&order=desc&after=${encodeURIComponent(sinceISO)}&page=${page}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' } });
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

  let note = stripHtml((post.excerpt && post.excerpt.rendered) || '').replace(/\s*\[?\s*…\s*\]?\s*$/, '');
  if (!note) { const y = post.yoast_head_json || {}; note = stripHtml(y.og_description || y.description || ''); }
  if (!note) note = stripHtml(content);
  note = snippet(note, 300);

  const out = { artist, album, note, cover, date: formatDate(post.date), url: post.link || '' };
  if (spotify) out.spotify = spotify;
  if (apple) out.apple = apple;
  if (bandcamp) out.bandcamp = bandcamp;
  return out;
}

const normLink = (u) => String(u || '').split('?')[0].split('#')[0].replace(/\/$/, '').toLowerCase();

function cleanADNote(text) {
  return String(text || '')
    .replace(/\bcontinue reading\b.*$/i, '')
    .replace(/the post .*? appeared first on .*$/i, '')
    .replace(/\s*\[(?:\u2026|\.\.\.)\]\s*$/, '')
    .replace(/\s*(?:read more|\u2192)\s*$/i, '')
    .trim();
}

// AD's RSS feed carries the write-ups the REST API leaves empty. Build a link -> note map.
async function fetchADNotes() {
  const map = new Map();
  try {
    const xml = await fetchFeedXml('https://aquariumdrunkard.com/feed/');
    const items = parseRssItems(xml);
    for (const it of items) {
      const note = cleanADNote(stripHtml(it.description || it.content || ''));
      if (it.link && note) map.set(normLink(it.link), note);
    }
    console.log(`  AD feed: ${map.size} write-ups available`);
  } catch (e) { console.error('  AD feed fetch failed:', e.message); }
  return map;
}

async function buildAquariumDrunkard() {
  const posts = await fetchADPosts(SINCE.toISOString());
  console.log(`  ${posts.length} posts scanned`);
  const notes = await fetchADNotes();
  const seen = new Set();
  const albums = [];
  let filled = 0;
  for (const post of posts) {
    const a = parseADPost(post);
    if (!a) continue;
    const key = (a.url || a.spotify || a.apple).split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    if (!a.note) { const n = notes.get(normLink(a.url)); if (n) { a.note = snippet(n, 300); filled++; } }
    albums.push(a);
  }
  console.log(`  ${filled} notes filled from RSS`);
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

// ---- Substack newsletters (via RSS; the JSON archive API blocks datacenter IPs) ----
const SUBSTACK_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// RSS is served where the JSON API is blocked. Try direct first, then fall back through
// read-only proxies that fetch from a non-blocked IP and hand back the body verbatim.
function substackFetchers(url) {
  return [
    url,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  ];
}

async function fetchFeedXml(url) {
  let lastErr;
  for (const u of substackFetchers(url)) {
    try {
      const res = await fetch(u, { headers: { 'User-Agent': SUBSTACK_UA, 'Accept': 'application/rss+xml, application/xml, text/xml, */*' } });
      if (!res.ok) { lastErr = new Error(`${res.status}`); continue; }
      const text = await res.text();
      if (text && text.indexOf('<item') !== -1) return text;
      lastErr = new Error(`no items (head: ${text.slice(0, 80).replace(/\s+/g, ' ')})`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all fetchers failed');
}

async function fetchSubstackFeed(subdomain) {
  return fetchFeedXml(`https://${subdomain}.substack.com/feed`);
}

function rssTag(block, name) {
  const m = block.match(new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)<\\/' + name + '>'));
  if (!m) return '';
  return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function parseRssItems(xml) {
  const items = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/g) || [];
  for (const b of blocks) {
    const enclosure = (b.match(/<enclosure[^>]*\burl="([^"]+)"/) || [])[1] || '';
    const contentEncoded = rssTag(b, 'content:encoded');
    const imgInContent = (contentEncoded.match(/<img[^>]*\bsrc="([^"]+)"/) || [])[1] || '';
    const cats = [];
    const catRe = /<category\b[^>]*>([\s\S]*?)<\/category>/g;
    let cm;
    while ((cm = catRe.exec(b))) cats.push(cm[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim());
    items.push({
      title: rssTag(b, 'title'),
      link: rssTag(b, 'link'),
      pubDate: rssTag(b, 'pubDate'),
      description: rssTag(b, 'description') || contentEncoded,
      content: contentEncoded,
      cover: enclosure || imgInContent,
      categories: cats,
    });
  }
  return items;
}

async function buildSubstack(subdomain, opts = {}) {
  const xml = await fetchSubstackFeed(subdomain);
  const items = parseRssItems(xml);
  console.log(`  ${items.length} posts scanned`);
  const seen = new Set();
  const albums = [];
  for (const it of items) {
    const when = it.pubDate ? new Date(it.pubDate) : null;
    if (when && !isNaN(when) && when < SINCE) continue;
    const title = stripHtml(it.title).trim();
    if (!title) continue;
    console.log(`    - ${title}`);                            // log every title so the filter can be tuned
    if (opts.include && !opts.include.test(title)) continue;  // keep only editions matching the pattern (e.g. "FR 173:")
    if (opts.exclude && opts.exclude.test(title)) continue;   // skip the weekly digests
    let artist = '';
    let album = title;
    let isRelease = false;
    if (opts.split) {                                         // "Artist - Album" -> artist + album
      const parts = title.split(/\s+[\u2013\u2014-]\s+/);
      if (parts.length >= 2) { artist = parts[0].trim(); album = parts.slice(1).join(' \u2013 ').trim(); isRelease = true; }
    }
    if (opts.tag) {                                           // or matched by a feed category
      const cats = (it.categories || []).map((c) => c.toLowerCase());
      if (cats.some((c) => c.includes(opts.tag))) isRelease = true;
    }
    if (opts.releasesOnly && !isRelease) continue;            // keep only individual recommended releases
    const url = String(it.link || '').split('?')[0];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    albums.push({
      post: true,
      artist,
      album,
      note: snippet(stripHtml(it.description), 300),
      cover: it.cover || '',
      date: formatDate(when && !isNaN(when) ? when.toISOString() : ''),
      url,
    });
  }
  return albums;
}

// ---- Futurism Restated: split each weekly FR edition into individual album picks ----
async function resolveBandcampCover(albumId) {
  const url = `https://bandcamp.com/EmbeddedPlayer/album=${albumId}/`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FunkentechnoFeed/1.0)' } });
    if (!res.ok) return {};
    const html = await res.text();
    const meta = (p) => (html.match(new RegExp('<meta property="og:' + p + '" content="([^"]+)"', 'i')) || [])[1] || '';
    return { cover: meta('image'), bandcamp: meta('url') };
  } catch (e) { return {}; }
}

function futurismPicks(contentHtml) {
  const picks = [];
  const paras = contentHtml.match(/<p\b[\s\S]*?<\/p>/gi) || [];
  let current = null;
  const flush = () => { if (current) { picks.push(current); current = null; } };
  for (const p of paras) {
    const text = stripHtml(p);
    const m = text.match(/^([^:]{1,80}):\s+(.+?)\s+\(([^()]{1,40})\)\s*$/);
    const hasItalicAlbum = /<em\b/i.test(p);
    if (m && hasItalicAlbum) {                                // a pick header: "Artist: Album (Label)"
      flush();
      current = { artist: m[1].trim(), album: m[2].trim(), label: m[3].trim(), note: '', id: '' };
      const idm = p.match(/album=(\d+)/);
      if (idm) current.id = idm[1];
      continue;
    }
    if (current) {                                            // following prose / embed belongs to the current pick
      const idm = p.match(/album=(\d+)/);
      if (idm && !current.id) current.id = idm[1];
      if (text) current.note = current.note ? (current.note + ' ' + text) : text;
    }
  }
  flush();
  return picks;
}

async function buildFuturismAlbums() {
  const xml = await fetchSubstackFeed('futurismrestated');
  const items = parseRssItems(xml);
  const editions = items.filter((it) => /^FR\s*\d+\s*:/i.test(stripHtml(it.title)));
  console.log(`  ${editions.length} FR editions in feed`);
  const seen = new Set();
  const albums = [];
  const CAP = 80;
  for (const ed of editions) {
    const when = ed.pubDate ? new Date(ed.pubDate) : null;
    if (when && !isNaN(when) && when < SINCE) continue;
    const edUrl = String(ed.link || '').split('?')[0];
    const edDate = formatDate(when && !isNaN(when) ? when.toISOString() : '');
    const picks = futurismPicks(ed.content || '');
    console.log(`    ${stripHtml(ed.title)} -> ${picks.length} picks`);
    for (const pk of picks) {
      if (albums.length >= CAP) break;
      const key = (pk.artist + ' - ' + pk.album).toLowerCase();
      if (!pk.artist || !pk.album || seen.has(key)) continue;
      seen.add(key);
      let cover = '';
      let bandcamp = '';
      if (pk.id) {
        await sleep(300);
        const meta = await resolveBandcampCover(pk.id);
        cover = meta.cover || '';
        bandcamp = meta.bandcamp || '';
      }
      console.log(`      - ${pk.artist} \u2014 ${pk.album}${cover ? ' [cover]' : ''}`);
      albums.push({ artist: pk.artist, album: pk.album, note: snippet(pk.note, 300), cover, bandcamp, date: edDate, url: edUrl });
    }
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

  try {
    console.log('first floor: fetching RSS feed...');
    const albums = await buildSubstack('firstfloor', { exclude: /^First Floor\b/i, split: true, tag: 'recommended-releases', releasesOnly: true });
    if (albums.length) { template = replaceArray(template, 'FIRSTFLOOR', albums); changed = true; console.log(`  ${albums.length} releases`); }
    else console.log('  none found, leaving unchanged');
  } catch (e) { console.error('first floor failed:', e.message); }

  try {
    console.log('futurism restated: fetching RSS feed...');
    const albums = await buildFuturismAlbums();
    if (albums.length) { template = replaceArray(template, 'FUTURISM', albums); changed = true; console.log(`  ${albums.length} albums`); }
    else console.log('  none found, leaving unchanged');
  } catch (e) { console.error('futurism restated failed:', e.message); }

  if (!changed) { console.log('\nNo changes.'); return; }
  template = setUpdated(template);
  await writeFile(HTML_FILE, template);
  console.log(`\nWrote ${HTML_FILE}`);
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
