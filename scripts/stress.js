#!/usr/bin/env node
// Build a large synthetic canvas for measuring the viewer.
//
//   node scripts/stress.js 10000 /tmp/big     → /tmp/big/.paper-canvas with 10k frames
//   cd /tmp/big && paper serve                 → then press P for render stats
//
// Frames are written straight into the store (the CLI would re-read the whole
// canvas for every add), with a handful of templates in random palettes so
// thumbnails look like a real board rather than one image repeated.
import fs from 'node:fs';
import path from 'node:path';
import { Store, newId, wrapHtml } from '../src/store.js';

const count = Number(process.argv[2] || 1000);
const dir = path.resolve(process.argv[3] || `stress-${count}`);
const store = new Store(path.join(dir, '.paper-canvas'));
store.init();

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = (a) => a[Math.floor(rand() * a.length)];

const SIZES = [
  [1440, 900],
  [1440, 900],
  [1280, 800],
  [390, 844],
  [390, 844],
  [834, 1112],
  [1000, 620],
  [480, 320],
];
const PALETTES = [
  ['#0f1013', '#e9ebee', '#8b7cff'],
  ['#ffffff', '#111318', '#2f6fed'],
  ['#f6f1e9', '#2b2118', '#d9622b'],
  ['#0b1f1a', '#d8f3e8', '#3ddc97'],
  ['#fff7fb', '#2a1030', '#d6336c'],
  ['#101826', '#dbe6ff', '#4c8dff'],
  ['#fafafa', '#1c1c1c', '#f5a524'],
];
const WORDS = 'ship design canvas agent build frame layout pricing profile settings team docs launch focus quiet bold fast simple honest review draft board'.split(' ');
const title = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ').replace(/^./, (c) => c.toUpperCase());

const TEMPLATES = [
  ([bg, fg, ac]) => `<div style="background:${bg};color:${fg};height:100%;padding:8% 10%;font-family:system-ui">
  <nav style="display:flex;justify-content:space-between;font-size:14px;opacity:.8"><b>${title(1)}</b><span>${title(3)}</span></nav>
  <h1 style="font-size:64px;letter-spacing:-.03em;margin:12% 0 16px;line-height:1">${title(4)} <span style="color:${ac}">${title(1)}</span>.</h1>
  <p style="font-size:18px;max-width:520px;opacity:.7">${title(14)}</p>
  <button style="background:${ac};color:${bg};border:0;padding:12px 22px;border-radius:8px;font-size:15px;margin-top:20px">${title(2)}</button></div>`,
  ([bg, fg, ac]) => `<div style="background:${bg};color:${fg};height:100%;padding:40px;font-family:system-ui">
  <h2 style="text-align:center;font-size:32px;margin:10px 0 30px">${title(3)}</h2>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">${[0, 1, 2]
    .map(
      (i) => `<div style="border:1px solid ${ac}55;border-radius:12px;padding:20px;${i === 1 ? `background:${ac}18` : ''}">
    <div style="font-size:12px;text-transform:uppercase;opacity:.6">${title(1)}</div>
    <div style="font-size:36px;font-weight:700;margin:8px 0">$${i * 24}</div>
    <div style="font-size:13px;line-height:2;opacity:.8">✓ ${title(2)}<br>✓ ${title(2)}<br>✓ ${title(2)}</div></div>`
    )
    .join('')}</div></div>`,
  ([bg, fg, ac]) => `<div style="background:${bg};color:${fg};height:100%;padding:24px 20px;font-family:system-ui">
  <div style="width:64px;height:64px;border-radius:16px;background:linear-gradient(135deg,${ac},${fg}40)"></div>
  <h3 style="font-size:24px;margin:16px 0 4px">${title(2)}</h3><p style="opacity:.6;font-size:14px">${title(8)}</p>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-top:20px">${Array.from(
    { length: 12 },
    (_, i) => `<div style="aspect-ratio:1;background:${ac}${(20 + ((i * 37) % 60)).toString(16)}"></div>`
  ).join('')}</div></div>`,
  ([bg, fg, ac]) => `<div style="display:flex;background:${bg};color:${fg};height:100%;font-family:system-ui">
  <aside style="width:200px;border-right:1px solid ${fg}22;padding:20px;font-size:13px;line-height:2.2">${Array.from({ length: 6 }, () => title(1)).join('<br>')}</aside>
  <main style="flex:1;padding:28px"><h2 style="margin:0 0 20px">${title(2)}</h2>
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px">${Array.from(
    { length: 4 },
    () => `<div style="border-radius:10px;background:${fg}0d;padding:14px"><div style="font-size:12px;opacity:.6">${title(1)}</div><div style="font-size:26px;font-weight:600;color:${ac}">${Math.floor(rand() * 999)}</div></div>`
  ).join('')}</div>
  <div style="margin-top:20px;height:220px;border-radius:10px;background:linear-gradient(180deg,${ac}40,transparent)"></div></main></div>`,
];

const cols = Math.max(1, Math.round(Math.sqrt(count) * 1.6));
const GAP = 120;
const CELL_W = 1440 + GAP;
const CELL_H = 1112 + GAP;
const frames = [];
const ids = new Set();
fs.mkdirSync(store.framesDir, { recursive: true });
for (let i = 0; i < count; i++) {
  const [w, h] = pick(SIZES);
  const palette = pick(PALETTES);
  let id = newId();
  while (ids.has(id)) id = newId(); // 32-bit ids collide at this scale
  ids.add(id);
  const name = `${pick(WORDS)}-${i + 1}`;
  fs.writeFileSync(store.framePath(id), wrapHtml(pick(TEMPLATES)(palette), { background: palette[0], title: name }));
  frames.push({
    id,
    name,
    x: (i % cols) * CELL_W,
    y: Math.floor(i / cols) * CELL_H,
    w,
    h,
    background: palette[0],
    note: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}
store.update((s) => {
  s.frames = frames;
});
console.log(`Wrote ${count} frames to ${store.root}`);
