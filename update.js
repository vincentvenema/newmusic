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

function extractNote(text, artist, album, maxLen = 600) {
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

function keyOf(a) {
  return ((a.url || '') + '|' + (a.artist || '') + '|' + (a.album || a.title || '')).toLowerCase().trim();
}

// Keep everything already stored; only add genuinely new entries, and fill any
// gaps (cover / note / bandcamp) on existing ones if a fresh scrape supplies them.
function mergeAlbums(existing, fresh) {
  existing = existing || [];
  fresh = fresh || [];
  let changed = false;
  const freshByKey = new Map(fresh.map((a) => [keyOf(a), a]));
  for (const a of existing) {
    const f = freshByKey.get(keyOf(a));
    if (!f) continue;
    if (!a.cover && f.cover) { a.cover = f.cover; changed = true; }
    if (!a.note && f.note) { a.note = f.note; changed = true; }
    if (!a.bandcamp && f.bandcamp) { a.bandcamp = f.bandcamp; changed = true; }
  }
  const have = new Set(existing.map(keyOf));
  const seen = new Set();
  const added = [];
  for (const a of fresh) {
    const k = keyOf(a);
    if (have.has(k) || seen.has(k)) continue;
    seen.add(k); added.push(a);
  }
  if (added.length) changed = true;
  return { albums: added.concat(existing), added: added.length, changed };
}

function setUpdated(template) {
  const re = /const LAST_UPDATED = "[^"]*";/;
  if (!re.test(template)) return template;
  return template.replace(re, () => `const LAST_UPDATED = "${new Date().toISOString()}";`);
}

// ---- funkentechno (Bluesky) ----
function bskyPostUrl(post) {
  const rkey = String(post && post.uri ? post.uri : '').split('/').pop();
  return rkey ? `https://bsky.app/profile/${HANDLE}/post/${rkey}` : '';
}

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
    if (byUrl.has(normUrl)) { const a = byUrl.get(normUrl); if (!a.url) { const u = bskyPostUrl(post); if (u) a.url = u; } albums.push(a); continue; }
    process.stdout.write(`  bandcamp ${normUrl} ... `);
    try {
      await sleep(300);
      const meta = await fetchBandcampMeta(normUrl);
      const note = extractNote(post.record.text, meta.artist, meta.album);
      const date = formatDate(post.record.createdAt);
      albums.push({ ...meta, note, date, url: bskyPostUrl(post) });
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
  note = snippet(note, 600);

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
async function fetchADExtras() {
  const map = new Map();
  try {
    const xml = await fetchFeedXml('https://aquariumdrunkard.com/feed/');
    const items = parseRssItems(xml);
    for (const it of items) {
      if (!it.link) continue;
      const body = it.content || it.description || '';
      const note = cleanADNote(stripHtml(it.description || it.content || ''));
      const bandcamp = (body.match(/https?:\/\/[\w-]+\.bandcamp\.com\/(?:album|track)\/[^"'\s)<]+/) || [])[0] || '';
      const bcId = bandcamp ? '' : ((body.match(/EmbeddedPlayer\/album=(\d+)/) || [])[1] || '');
      map.set(normLink(it.link), { note, bandcamp, bcId });
    }
    console.log(`  AD feed: ${map.size} posts available`);
  } catch (e) { console.error('  AD feed fetch failed:', e.message); }
  return map;
}

async function buildAquariumDrunkard(known = null) {
  const posts = await fetchADPosts(SINCE.toISOString());
  console.log(`  ${posts.length} posts scanned`);
  const extras = await fetchADExtras();
  const seen = new Set();
  const albums = [];
  let filled = 0;
  let bcFilled = 0;
  for (const post of posts) {
    const a = parseADPost(post);
    if (!a) continue;
    const key = (a.url || a.spotify || a.apple).split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    const ex = extras.get(normLink(a.url));
    if (ex) {
      if (!a.note && ex.note) { a.note = snippet(ex.note, 600); filled++; }
      if (!a.bandcamp && ex.bandcamp) { a.bandcamp = ex.bandcamp; bcFilled++; }
      else if (!a.bandcamp && ex.bcId && (!known || !known.has(keyOf(a)))) {
        await sleep(300);
        const meta = await resolveBandcampCover(ex.bcId);
        if (meta.bandcamp) { a.bandcamp = meta.bandcamp; bcFilled++; }
        if (!a.cover && meta.cover) a.cover = meta.cover;
      }
    }
    if (!a.cover && (!known || !known.has(keyOf(a)))) {
      await sleep(300);
      const ic = await coverFromItunes(a.artist, a.album);
      if (ic) a.cover = ic;
    }
    albums.push(a);
  }
  console.log(`  ${filled} notes, ${bcFilled} bandcamp links filled from RSS`);
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
      note: String(ext.description || '').slice(0, 600),
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
    `https://vincentvenema.com/newmusic/feedproxy.php?u=${encodeURIComponent(url)}`,
    `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  ];
}

async function fetchFeedXml(url) {
  let lastErr;
  for (const u of substackFetchers(url)) {
    const via = u.includes('feedproxy.php') ? 'hostinger'
      : u.includes('codetabs') ? 'codetabs'
      : u.includes('allorigins') ? 'allorigins'
      : u.includes('corsproxy') ? 'corsproxy' : 'direct';
    try {
      const res = await fetch(u, { headers: { 'User-Agent': SUBSTACK_UA, 'Accept': 'application/rss+xml, application/xml, text/xml, */*' } });
      if (!res.ok) { console.log(`    ${via}: HTTP ${res.status}`); lastErr = new Error(`${res.status}`); continue; }
      const text = await res.text();
      if (text && text.indexOf('<item') !== -1) { console.log(`    ${via}: ok`); return text; }
      console.log(`    ${via}: no items (head: ${text.slice(0, 60).replace(/\s+/g, ' ')})`);
      lastErr = new Error('no items');
    } catch (e) { console.log(`    ${via}: ${e.message}`); lastErr = e; }
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
      note: snippet(stripHtml(it.description), 600),
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

async function buildFuturismAlbums(known = null) {
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
      if (known && known.has(keyOf({ url: edUrl, artist: pk.artist, album: pk.album }))) continue;
      let cover = '';
      let bandcamp = '';
      if (pk.id) {
        await sleep(300);
        const meta = await resolveBandcampCover(pk.id);
        cover = meta.cover || '';
        bandcamp = meta.bandcamp || '';
      }
      if (!cover) { await sleep(300); cover = await coverFromItunes(pk.artist, pk.album); }
      console.log(`      - ${pk.artist} \u2014 ${pk.album}${cover ? ' [cover]' : ''}`);
      albums.push({ artist: pk.artist, album: pk.album, note: snippet(pk.note, 600), cover, bandcamp, date: edDate, url: edUrl });
    }
  }
  return albums;
}

// ---- In Sheep's Clothing Hi-Fi (WordPress RSS, one card per feature) ----
async function fetchFirstWorkingFeed(urls) {
  let lastErr;
  for (const u of urls) {
    try { const xml = await fetchFeedXml(u); console.log(`  feed: ${u.replace(/^https:\/\//, '')}`); return xml; }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no feed url worked');
}

async function buildInSheeps() {
  // the features section, not the whole-site feed (which is mostly mixes and events)
  const xml = await fetchFirstWorkingFeed([
    'https://insheepsclothinghifi.com/features/feed/',
    'https://insheepsclothinghifi.com/category/feature/feed/',
    'https://insheepsclothinghifi.com/category/features/feed/',
  ]);
  const items = parseRssItems(xml);
  console.log(`  ${items.length} features scanned`);
  const seen = new Set();
  const albums = [];
  for (const it of items) {
    if (albums.length >= 30) break;
    const title = stripHtml(it.title).trim();
    const url = String(it.link || '').split('?')[0];
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    const when = it.pubDate ? new Date(it.pubDate) : null;
    console.log(`    - ${title}`);
    albums.push({
      post: true,
      album: title,
      note: snippet(cleanADNote(stripHtml(it.description || it.content || '')), 600),
      cover: it.cover || '',
      date: formatDate(when && !isNaN(when) ? when.toISOString() : ''),
      url,
    });
  }
  return albums;
}

// ---- First Floor: releases live inside the weekly digest's "Recommended Releases" section ----
function firstFloorReleases(contentHtml) {
  const out = [];
  let rr = String(contentHtml || '');
  const start = rr.search(/RECOMMENDED RELEASES/i);
  if (start === -1) return out;
  rr = rr.slice(start);
  const end = rr.search(/That brings us to the end/i);
  if (end !== -1) rr = rr.slice(0, end);

  const headRe = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  const heads = [];
  let hm;
  while ((hm = headRe.exec(rr))) heads.push({ text: hm[1], end: headRe.lastIndex, start: hm.index });
  for (let i = 0; i < heads.length; i++) {
    const title = decodeEntities(stripHtml(heads[i].text)).trim();
    const mt = title.match(/^(.+?)\s+[\u2013\u2014-]\s+(.+?)\s*\(([^()]+)\)\s*$/);  // Artist - Album (Label)
    if (!mt) continue;
    const body = rr.slice(heads[i].end, i + 1 < heads.length ? heads[i + 1].start : rr.length);
    const urlM = body.match(/href="(https:\/\/firstfloor\.substack\.com\/p\/[^"]+)"/i);
    const note = decodeEntities(stripHtml(body))
      .replace(/LISTEN TO THE MUSIC \+ READ THE FULL WRITE-?UP/ig, '')
      .replace(/^[\s\u2026.]+/, '')
      .trim();
    out.push({ artist: mt[1].trim(), album: mt[2].trim(), label: mt[3].trim(), note, url: urlM ? urlM[1].split('?')[0] : '' });
  }
  return out;
}

// each release links to its own post; the post's og:image is the cover
async function resolveSubstackOgImage(postUrl) {
  const routes = [
    postUrl,
    `https://vincentvenema.com/newmusic/feedproxy.php?u=${encodeURIComponent(postUrl)}`,
    `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(postUrl)}`,
  ];
  for (const u of routes) {
    try {
      const res = await fetch(u, { headers: { 'User-Agent': SUBSTACK_UA } });
      if (!res.ok) continue;
      const html = await res.text();
      const m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
      if (m && m[1]) return m[1].replace(/&amp;/g, '&');
    } catch (e) {}
  }
  return '';
}

let ITUNES_BUDGET = 80;
async function coverFromItunes(artist, album) {
  if (!artist || !album || ITUNES_BUDGET <= 0) return '';
  ITUNES_BUDGET--;
  try {
    const term = encodeURIComponent((artist + ' ' + album).trim());
    const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=album&limit=1`, { headers: { 'User-Agent': SUBSTACK_UA } });
    if (!res.ok) return '';
    const data = JSON.parse(await res.text());
    const r = data && data.results && data.results[0];
    if (!r || !r.artworkUrl100) return '';
    return r.artworkUrl100.replace(/\/\d+x\d+bb\.(jpg|png)/, '/600x600bb.$1');
  } catch (e) { return ''; }
}

async function buildFirstFloor(known = null) {
  // 1) Try the recommended-releases section feed, where each item is one release post.
  for (const u of [
    'https://firstfloor.substack.com/feed/s/recommended-releases',
    'https://firstfloor.substack.com/s/recommended-releases/feed',
  ]) {
    let xml;
    try { xml = await fetchFeedXml(u); } catch (e) { continue; }
    const items = parseRssItems(xml);
    const out = [];
    const seen = new Set();
    for (const it of items) {
      const title = decodeEntities(stripHtml(it.title)).trim();
      const parts = title.split(/\s+[\u2013\u2014-]\s+/);
      if (parts.length < 2) continue;
      const artist = parts[0].trim();
      const album = parts.slice(1).join(' \u2013 ').trim();
      const url = String(it.link || '').split('?')[0];
      const k = keyOf({ url, artist, album });
      if (seen.has(k)) continue;
      seen.add(k);
      if (known && known.has(k)) continue;
      await sleep(300);
      let cover = await coverFromItunes(artist, album);
      if (!cover) cover = it.cover || '';
      out.push({ artist, album, note: snippet(decodeEntities(stripHtml(it.description || it.content || '')), 600), cover, date: formatDate(it.pubDate ? new Date(it.pubDate).toISOString() : ''), url });
    }
    if (out.length) { console.log(`  via section feed (${u.replace(/^https:\/\//, '')}): ${out.length} new`); return out; }
  }
  console.log('  no section feed; parsing weekly digests');

  // 2) Fall back to parsing the "Recommended Releases" section out of each digest.
  const xml = await fetchSubstackFeed('firstfloor');
  const items = parseRssItems(xml);
  console.log(`  ${items.length} digests scanned`);
  const seen = new Set();
  const albums = [];
  const CAP = 24;
  for (const it of items) {
    if (albums.length >= CAP) break;
    const body = it.content || '';
    const releases = firstFloorReleases(body);
    console.log(`    ${stripHtml(it.title)} | body ${body.length} chars | RR: ${/RECOMMENDED RELEASES/i.test(body) ? 'yes' : 'no'} | ${releases.length} releases`);
    const when = it.pubDate ? new Date(it.pubDate) : null;
    const date = formatDate(when && !isNaN(when) ? when.toISOString() : '');
    for (const r of releases) {
      if (albums.length >= CAP) break;
      const k = keyOf({ url: r.url, artist: r.artist, album: r.album });
      if (!r.artist || !r.album || seen.has(k)) continue;
      seen.add(k);
      if (known && known.has(k)) continue;
      await sleep(300);
      let cover = await coverFromItunes(r.artist, r.album);
      if (!cover && r.url) cover = await resolveSubstackOgImage(r.url);
      albums.push({ artist: r.artist, album: r.album, note: snippet(r.note, 600), cover, date, url: r.url });
    }
  }
  return albums;
}

async function buildQuietus(known = null) {
  const xml = await fetchFeedXml('https://thequietus.com/columns/quietus-reviews/album-of-the-week/feed/');
  const items = parseRssItems(xml);
  console.log(`  ${items.length} reviews scanned`);
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (out.length >= 30) break;
    const title = decodeEntities(stripHtml(it.title)).trim().replace(/[\s:]*is\s+our\s+album\s+of\s+the\s+week\.?$/i, '').trim();
    const url = String(it.link || '').split('?')[0];
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    const k = keyOf({ url, album: title });
    if (known && known.has(k)) continue;
    let cover = it.cover || '';
    if (!cover) { await sleep(300); cover = await resolveSubstackOgImage(url); }
    const when = it.pubDate ? new Date(it.pubDate) : null;
    out.push({ post: true, album: title, note: snippet(cleanADNote(stripHtml(it.description || it.content || '')), 600), cover, date: formatDate(when && !isNaN(when) ? when.toISOString() : ''), url });
  }
  return out;
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
    const existing = readArray(template, 'AQUARIUMDRUNKARD') || [];
    const fresh = await buildAquariumDrunkard(new Set(existing.filter((a) => a.cover).map(keyOf)));
    const m = mergeAlbums(existing, fresh);
    if (m.changed) { template = replaceArray(template, 'AQUARIUMDRUNKARD', m.albums); changed = true; }
    console.log(`  ${m.added} new, ${m.albums.length} total`);
  } catch (e) { console.error('aquarium drunkard failed:', e.message); }

  try {
    console.log('line of best fit: fetching Bluesky...');
    const fresh = await buildLineOfBestFit();
    const existing = readArray(template, 'LOBF') || [];
    const m = mergeAlbums(existing, fresh);
    if (m.changed) { template = replaceArray(template, 'LOBF', m.albums); changed = true; }
    console.log(`  ${m.added} new, ${m.albums.length} total`);
  } catch (e) { console.error('line of best fit failed:', e.message); }

  try {
    console.log('first floor: fetching digest feed...');
    const existing = readArray(template, 'FIRSTFLOOR') || [];
    const fresh = await buildFirstFloor(new Set(existing.filter((a) => a.cover).map(keyOf)));
    const m = mergeAlbums(existing, fresh);
    if (m.changed) { template = replaceArray(template, 'FIRSTFLOOR', m.albums); changed = true; }
    console.log(`  ${m.added} new, ${m.albums.length} total`);
  } catch (e) { console.error('first floor failed:', e.message); }

  try {
    console.log('futurism restated: fetching RSS feed...');
    const existing = readArray(template, 'FUTURISM') || [];
    const fresh = await buildFuturismAlbums(new Set(existing.filter((a) => a.cover).map(keyOf)));
    const m = mergeAlbums(existing, fresh);
    if (m.changed) { template = replaceArray(template, 'FUTURISM', m.albums); changed = true; }
    console.log(`  ${m.added} new, ${m.albums.length} total`);
  } catch (e) { console.error('futurism restated failed:', e.message); }

  try {
    console.log('in sheeps clothing: fetching RSS feed...');
    const fresh = await buildInSheeps();
    const existing = readArray(template, 'INSHEEPS') || [];
    const m = mergeAlbums(existing, fresh);
    if (m.changed) { template = replaceArray(template, 'INSHEEPS', m.albums); changed = true; }
    console.log(`  ${m.added} new, ${m.albums.length} total`);
  } catch (e) { console.error('in sheeps clothing failed:', e.message); }

  try {
    console.log('the quietus: fetching RSS feed...');
    const existing = readArray(template, 'QUIETUS') || [];
    const fresh = await buildQuietus(new Set(existing.filter((a) => a.cover).map(keyOf)));
    const m = mergeAlbums(existing, fresh);
    if (m.changed) { template = replaceArray(template, 'QUIETUS', m.albums); changed = true; }
    console.log(`  ${m.added} new, ${m.albums.length} total`);
  } catch (e) { console.error('the quietus failed:', e.message); }

  if (!changed) { console.log('\nNo changes.'); return; }
  template = setUpdated(template);
  await writeFile(HTML_FILE, template);
  console.log(`\nWrote ${HTML_FILE}`);
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
