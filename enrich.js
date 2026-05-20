// enrich.js
// Reads input.txt and regenerates index.html with updated album data.
//
// Usage: node enrich.js
// Requires: Node 18+ (uses built-in fetch)

import { readFile, writeFile } from 'fs/promises';

const INPUT_FILE = 'input.txt';
const HTML_FILE = 'index.html';

async function fetchAlbum(bandcampUrl) {
  const res = await fetch(bandcampUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FunkentechnoFeed/1.0)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const meta = (prop) => {
    const re = new RegExp(`<meta property="og:${prop}" content="([^"]+)"`, 'i');
    return (html.match(re) || [])[1] || '';
  };

  // Bandcamp og:title format: "Album Title, by Artist"
  const title = meta('title');
  const match = title.match(/^(.+),\s*by\s+(.+)$/i);
  const album = match ? match[1].trim() : title;
  const artist = match ? match[2].trim() : '';

  return {
    artist,
    album,
    bandcamp: meta('url') || bandcampUrl,
    cover: meta('image')
  };
}

async function main() {
  const input = await readFile(INPUT_FILE, 'utf-8');
  const lines = input
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  const albums = [];
  for (const line of lines) {
    const parts = line.split('|').map(s => s.trim());
    const [url, note, date] = parts;
    if (!url) continue;

    process.stdout.write(`  ${url} ... `);
    try {
      const data = await fetchAlbum(url);
      albums.push({ ...data, note: note || '', date: date || '' });
      console.log('ok');
    } catch (e) {
      console.log(`failed (${e.message})`);
    }
  }

  // Replace the const albums = [...] block in index.html
  const template = await readFile(HTML_FILE, 'utf-8');
  const json = JSON.stringify(albums, null, 2);
  const updated = template.replace(
    /const albums = \[[\s\S]*?\n\];/,
    `const albums = ${json};`
  );

  if (updated === template) {
    console.error('\nWarning: could not find "const albums = [...]" in index.html');
    process.exit(1);
  }

  await writeFile(HTML_FILE, updated);
  console.log(`\nWrote ${albums.length} entries to ${HTML_FILE}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
