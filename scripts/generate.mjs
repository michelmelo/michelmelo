#!/usr/bin/env node
// Regenerates every SVG in ../assets for the michelmelo profile README.
//
//   node scripts/generate.mjs            fetch live numbers, write assets/*.svg + assets/data.json
//   node scripts/generate.mjs --offline  reuse assets/data.json, only re-render
//
// Sources (all read-only, no secrets):
//   GitHub   via the `gh` CLI (already logged in on the box), public data only
//   pub.dev  public score API for the published Flutter packages
//
// If a source fails, the last good value from assets/data.json is kept, so a
// flaky network never breaks the whole page.
//
// No npm dependencies. Node >= 20.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ASSETS = path.join(ROOT, 'assets');
const FONTS = path.join(HERE, 'fonts');
const DATA_FILE = path.join(ASSETS, 'data.json');
const OFFLINE = process.argv.includes('--offline');

const USER = 'michelmelo';
const PUB_PACKAGES = ['flutter_miniplayer', 'flutter_imagecards', 'flutter_youtube_video_player'];

const log = (...a) => console.log('[profile]', ...a);

// ---------------------------------------------------------------- data

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).trim();
}
const ghJson = (args) => JSON.parse(gh(args));
const ghCount = (q) => Number(ghJson(['api', `search/issues?per_page=1&q=${encodeURIComponent(q)}`]).total_count);

async function fetchProfile() {
  const p = ghJson(['api', `users/${USER}`]);
  return {
    repos: p.public_repos,
    gists: p.public_gists,
    followers: p.followers,
    following: p.following,
    since: Number(p.created_at.slice(0, 4)),
  };
}

async function fetchRepos() {
  const all = ghJson(['repo', 'list', USER, '--visibility', 'public', '--limit', '1000',
    '--json', 'name,stargazerCount,forkCount,isFork,isPrivate,primaryLanguage,url,description']);
  const publicRepos = all.filter((r) => !r.isPrivate);
  const own = publicRepos.filter((r) => !r.isFork);
  const counts = {};
  for (const r of own) {
    const l = r.primaryLanguage?.name || 'outras';
    counts[l] = (counts[l] || 0) + 1;
  }
  const languages = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return {
    total: publicRepos.length,
    own: own.length,
    stars: own.reduce((a, r) => a + r.stargazerCount, 0),
    forks: own.reduce((a, r) => a + r.forkCount, 0),
    languageCount: languages.length,
    languages: languages.slice(0, 8),
  };
}

async function fetchPub() {
  const packages = [];
  for (const name of PUB_PACKAGES) {
    const r = await fetch(`https://pub.dev/api/packages/${name}/score`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`pub ${name} ${r.status}`);
    const j = await r.json();
    packages.push({ name, likes: j.likeCount || 0, downloads30d: j.downloadCount30Days || 0 });
  }
  return {
    count: packages.length,
    likes: packages.reduce((a, p) => a + p.likes, 0),
    downloads30d: packages.reduce((a, p) => a + p.downloads30d, 0),
    packages,
  };
}

async function fetchWeek() {
  const since = new Date(Date.now() - 7 * 864e5);
  const d = since.toISOString().slice(0, 10);
  const commits = Number(ghJson(['api', `search/commits?per_page=1&q=${encodeURIComponent(`author:${USER} author-date:>=${d}`)}`]).total_count);
  return {
    from: d,
    to: new Date().toISOString().slice(0, 10),
    commits,
    prsShipped: ghCount(`is:pr author:${USER} is:merged merged:>=${d}`),
    prsMergedForOthers: ghCount(`is:pr user:${USER} is:merged merged:>=${d} -author:${USER}`),
    prsReviewed: ghCount(`is:pr reviewed-by:${USER} -author:${USER} updated:>=${d}`),
    issuesClosed: ghCount(`is:issue user:${USER} is:closed closed:>=${d}`),
    threadsCommented: ghCount(`commenter:${USER} updated:>=${d}`),
  };
}

async function collect() {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  if (OFFLINE) { log('offline: re-rendering from data.json'); return prev; }
  const data = { generatedAt: new Date().toISOString() };
  const steps = { profile: fetchProfile, repos: fetchRepos, pub: fetchPub, week: fetchWeek };
  for (const [key, fn] of Object.entries(steps)) {
    try { data[key] = await fn(); log(`${key}: ok`); }
    catch (e) { if (prev[key]) data[key] = prev[key]; log(`${key}: FAILED (${e.message.split('\n')[0]}), keeping last value`); }
  }
  return data;
}

// ---------------------------------------------------------------- helpers

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fontCache = {};
function fontFace(family, file, weight) {
  fontCache[file] ||= fs.readFileSync(path.join(FONTS, file)).toString('base64');
  return `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:swap;src:url(data:font/woff2;base64,${fontCache[file]}) format('woff2');}`;
}
const INTER = `'P Inter',Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const MONO = `'P Mono','JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;
function fonts(list) {
  const map = { i400: ['P Inter', 'inter-400.woff2', 400], i600: ['P Inter', 'inter-600.woff2', 600],
    i700: ['P Inter', 'inter-700.woff2', 700], i800: ['P Inter', 'inter-800.woff2', 800],
    m400: ['P Mono', 'jbmono-400.woff2', 400], m500: ['P Mono', 'jbmono-500.woff2', 500],
    m700: ['P Mono', 'jbmono-700.woff2', 700] };
  return list.map((k) => fontFace(...map[k])).join('');
}
function compact(n) {
  if (n == null || Number.isNaN(n)) return '–';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return n.toLocaleString('pt-PT');
}
const fmtDate = (iso) => (iso || new Date().toISOString()).slice(0, 10);
function svgOpen(w, h, label, extraCss = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><style>${extraCss}</style>`;
}
function write(name, svg) {
  fs.writeFileSync(path.join(ASSETS, name), svg);
  const kb = Buffer.byteLength(svg) / 1024;
  log(`${name.padEnd(28)} ${kb.toFixed(0).padStart(4)} KB${kb > 200 ? '  <-- over budget' : ''}`);
}

const THEMES = {
  dark: {
    page: '#0d1117', surface: '#151b23', surface2: '#0f141b', border: '#30363d', text: '#e6edf3', muted: '#9198a1',
    faint: '#3d444d', accent: '#a78bfa', accentText: '#c4b5fd', blue: '#79c0ff', violet: '#d2a8ff', orange: '#ffa657',
    red: '#f85149', green: '#3fb950', termBg: '#0b0f14', termBar: '#161b22',
  },
  light: {
    page: '#ffffff', surface: '#f6f8fa', surface2: '#ffffff', border: '#d1d9e0', text: '#1f2328', muted: '#59636e',
    faint: '#d1d9e0', accent: '#7c3aed', accentText: '#5b21b6', blue: '#0550ae', violet: '#8250df', orange: '#bc4c00',
    red: '#cf222e', green: '#1a7f37', termBg: '#fbfcfd', termBar: '#eef1f4',
  },
};

// Discrete SMIL animation that loops with the whole timeline (period T seconds).
function discrete(attr, frames, T, extra = '') {
  const kt = frames.map(([t]) => Math.min(t / T, 1).toFixed(5)).join(';');
  const vals = frames.map(([, v]) => v).join(';');
  return `<animate attributeName="${attr}" dur="${T}s" repeatCount="indefinite" calcMode="discrete" keyTimes="${kt}" values="${vals}" ${extra}/>`;
}

// ---------------------------------------------------------------- 1. terminal header

function terminal(data, th) {
  const W = 1000, FS = 16, CW = FS * 0.6, LH = 27, X0 = 28, Y0 = 82;
  const prompt = [['michel', th.green], ['@', th.muted], ['dev', th.blue], [':', th.muted], ['~', th.violet], ['$ ', th.muted]];
  const PL = prompt.reduce((n, [s]) => n + s.length, 0);
  const p = data.profile || {}, r = data.repos || {}, pub = data.pub || {};
  const years = p.since ? new Date().getFullYear() - p.since : null;
  const upBits = [
    `${years ? years + ' anos' : 'anos'} de GitHub`,
    `${compact(r.own)} projetos próprios`,
    `${compact(pub.count)} packages no pub.dev`,
  ];
  const script = [
    { cmd: 'whoami', out: [[['Michel Melo', th.text, 700], [', engenheiro de software · ', th.text], ['PHP/Laravel & Flutter', th.accentText, 700]]] },
    { cmd: 'ls projects/', out: [
      [['laravel-instagram-api/  ', th.accentText, 700], ['laravel-easypay/  ', th.blue, 700], ['michelangelo/', th.blue, 700]],
      [['periquita/  ', th.blue, 700], ['flutter-miniplayer/  ', th.blue, 700], ['instagram-cli/', th.blue, 700]],
    ] },
    { cmd: 'uptime', out: [[[' ' + upBits.join(', '), th.muted]]] },
    { cmd: 'cat motto.txt', out: [[['Construir pequeno, publicar cedo, aprender sempre.', th.orange]]] },
    { cmd: null },
  ];
  const rows = script.reduce((n, s) => n + 1 + (s.out ? s.out.length : 0), 0);
  const H = Y0 + rows * LH + 6;
  const T = 26; // seconds per loop
  let t = 0.8, row = 0, body = '', cursorX = [[0, X0 + PL * CW]], cursorY = [[0, Y0 - FS + 3]];
  const lineY = (r) => Y0 + r * LH;
  const spans = (segs) => segs.map(([s, c, w]) => `<tspan fill="${c}"${w ? ` font-weight="${w}"` : ''}>${esc(s)}</tspan>`).join('');

  script.forEach((step, si) => {
    const y = lineY(row);
    const appear = si === 0 ? 0 : t;
    body += `<g opacity="1">${si ? discrete('opacity', [[0, 0], [appear, 1]], T) : ''}<text x="${X0}" y="${y}" xml:space="preserve">${spans(prompt)}</text>`;
    cursorX.push([appear, X0 + PL * CW]); cursorY.push([appear, y - FS + 3]);
    if (step.cmd) {
      const n = step.cmd.length, start = appear + 0.45, dt = 0.085;
      const id = `c${si}`;
      const frames = [[0, 0]];
      for (let i = 1; i <= n; i++) frames.push([start + i * dt, (i * CW).toFixed(1)]);
      body += `<clipPath id="${id}"><rect x="${X0 + PL * CW}" y="${y - FS - 4}" height="${LH}" width="${(n * CW).toFixed(1)}">${discrete('width', frames, T)}</rect></clipPath>`;
      body += `<text x="${X0 + PL * CW}" y="${y}" fill="${th.text}" clip-path="url(#${id})" xml:space="preserve">${esc(step.cmd)}</text>`;
      for (let i = 1; i <= n; i++) cursorX.push([start + i * dt, X0 + (PL + i) * CW]);
      t = start + n * dt + 0.45;
    }
    body += '</g>';
    row++;
    for (const out of step.out || []) {
      body += `<text x="${X0}" y="${lineY(row)}" xml:space="preserve" opacity="1">${discrete('opacity', [[0, 0], [t, 1]], T)}${spans(out)}</text>`;
      row++;
      t += 0.12;
    }
    t += 0.9;
  });
  if (t > T - 6) throw new Error(`terminal timeline too long (${t.toFixed(1)}s)`);
  const sortByT = (a) => a.sort((q, p) => q[0] - p[0]);
  const lastY = cursorY[cursorY.length - 1][1];
  const lastX = cursorX[cursorX.length - 1][1];
  body += `<rect x="${lastX}" y="${lastY}" width="${CW}" height="${FS + 3}" fill="${th.accent}">` +
    discrete('x', sortByT(cursorX), T) + discrete('y', sortByT(cursorY), T) +
    `<animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" dur="1.1s" repeatCount="indefinite"/></rect>`;

  const css = fonts(['m400', 'm700']) + `text{font-family:${MONO};font-size:${FS}px;}`;
  let s = svgOpen(W, H, 'Terminal: whoami, Michel Melo, engenheiro de software, PHP/Laravel e Flutter', css);
  s += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="${th.termBg}" stroke="${th.border}"/>`;
  s += `<path d="M0.5 44V14.5A14 14 0 0 1 14.5 0.5H${W - 14.5}A14 14 0 0 1 ${W - 0.5} 14.5V44Z" fill="${th.termBar}" stroke="${th.border}"/>`;
  s += ['#ff5f57', '#febc2e', '#28c840'].map((c, i) => `<circle cx="${26 + i * 20}" cy="22" r="6" fill="${c}"/>`).join('');
  s += `<text x="${W / 2}" y="27" text-anchor="middle" fill="${th.muted}" style="font-size:13px">michel@dev: ~ (bash)</text>`;
  s += `<text x="${W - 24}" y="27" text-anchor="end" fill="${th.faint}" style="font-size:12px">${fmtDate(data.generatedAt)}</text>`;
  s += body + '</svg>';
  return s;
}

// ---------------------------------------------------------------- 2. open source card

function codeMark(x, y, scale, fill) {
  return `<g transform="translate(${x},${y}) scale(${scale})" fill="none" stroke="${fill}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M-28 -30 L-60 0 L-28 30"/><path d="M28 -30 L60 0 L28 30"/><path d="M12 -42 L-12 42"/></g>`;
}

function statsCard(data, mode) {
  const dark = mode === 'dark';
  const c = dark
    ? { bg1: '#12151b', bg2: '#0c0e12', border: '#2b3140', text: '#eef1f6', muted: '#8b94a7', faint: '#5c6475', accent: '#a78bfa', accentText: '#c4b5fd', cell: '#151a22', cellBorder: '#232a36' }
    : { bg1: '#fbfaff', bg2: '#f3efff', border: '#ddd5f0', text: '#12151b', muted: '#4b5563', faint: '#6b7280', accent: '#7c3aed', accentText: '#5b21b6', cell: '#ffffff', cellBorder: '#e4dcf5' };
  const p = data.profile || {}, r = data.repos || {}, pub = data.pub || {};
  const W = 1000, H = 312;
  const cells = [
    { big: compact(r.total), label: 'REPOSITÓRIOS' },
    { big: compact(r.stars), label: 'GITHUB STARS' },
    { big: compact(p.followers), label: 'SEGUIDORES' },
    { big: compact(pub.count), label: 'PACKAGES', small: 'no pub.dev' },
    { big: compact(pub.likes), label: 'LIKES', small: 'no pub.dev' },
    { big: compact(pub.downloads30d), label: 'DOWNLOADS', small: 'últimos 30 dias' },
  ];
  const css = fonts(['i600', 'i800', 'm500']) + `.i{font-family:${INTER}}.m{font-family:${MONO}}`;
  let s = svgOpen(W, H, `Open source: ${compact(r.total)} repositórios públicos, ${compact(r.stars)} stars, ${compact(p.followers)} seguidores, ${compact(pub.count)} packages no pub.dev com ${compact(pub.likes)} likes e ${compact(pub.downloads30d)} downloads nos últimos 30 dias`, css);
  s += `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.bg1}"/><stop offset="1" stop-color="${c.bg2}"/></linearGradient>
  <radialGradient id="glow" cx="0.12" cy="0.2" r="0.5"><stop offset="0" stop-color="${c.accent}" stop-opacity="${dark ? 0.13 : 0.12}"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0"/></radialGradient></defs>`;
  s += `<rect width="${W}" height="${H}" rx="22" fill="url(#bg)"/><rect width="${W}" height="${H}" rx="22" fill="url(#glow)"/>`;
  s += `<rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="20.5" fill="none" stroke="${c.border}" stroke-width="3"/>`;
  s += codeMark(104, 92, 0.52, c.accent);
  s += `<text class="i" x="176" y="104" font-size="52" font-weight="800" letter-spacing="-2"><tspan fill="${c.text}">michel</tspan><tspan fill="${c.accentText}">melo</tspan></text>`;
  s += `<text class="i" x="178" y="134" font-size="17" font-weight="600" fill="${c.muted}">PHP/Laravel, Flutter e packages pequenos que resolvem problemas reais</text>`;
  s += `<g transform="translate(${W - 176},40)"><rect width="140" height="30" rx="15" fill="none" stroke="${c.accent}" stroke-opacity="0.6"/>
    <circle cx="20" cy="15" r="4.5" fill="${c.accent}"><animate attributeName="opacity" values="1;0.25;1" dur="2.4s" repeatCount="indefinite"/></circle>
    <text class="m" x="34" y="20" font-size="12.5" font-weight="500" fill="${c.accentText}">LIVE NUMBERS</text></g>`;
  const cw = 148, gap = 10, x0 = (W - (cw * 6 + gap * 5)) / 2, y0 = 166, chH = 98;
  cells.forEach((cell, i) => {
    const x = x0 + i * (cw + gap);
    s += `<rect x="${x}" y="${y0}" width="${cw}" height="${chH}" rx="14" fill="${c.cell}" stroke="${c.cellBorder}"/>`;
    const fs2 = cell.big.length > 7 ? 21 : 30;
    s += `<text class="i" x="${x + 16}" y="${y0 + 44}" font-size="${fs2}" font-weight="800" fill="${c.text}" letter-spacing="-0.5">${esc(cell.big)}</text>`;
    s += `<text class="m" x="${x + 16}" y="${y0 + 68}" font-size="11" font-weight="500" fill="${c.muted}" letter-spacing="0.6">${esc(cell.label)}</text>`;
    const sub = cell.small;
    if (sub) s += `<text class="m" x="${x + 16}" y="${y0 + 87}" font-size="11" font-weight="500" fill="${c.accentText}">${esc(sub)}</text>`;
  });
  s += `<text class="m" x="${x0}" y="${H - 22}" font-size="11.5" fill="${c.faint}">dados de GitHub + pub.dev em ${fmtDate(data.generatedAt)}  ·  Portugal</text>`;
  s += `<text class="m" x="${W - x0}" y="${H - 22}" text-anchor="end" font-size="11.5" font-weight="500" fill="${c.accentText}">github.com/michelmelo  →</text>`;
  return s + '</svg>';
}

// ---------------------------------------------------------------- 3. stack rack

function stackRack(data, th) {
  const r = data.repos || {}, pub = data.pub || {}, p = data.profile || {};
  const W = 1000, RX = 60, RW = W - 2 * RX, U = 42, top = 84;
  const units = [2, 1, 2, 1];
  const H = top + units.reduce((a, b) => a + b, 0) * U + 22 + 56;
  const css = fonts(['m400', 'm700', 'i700']) + `.m{font-family:${MONO}}.i{font-family:${INTER}}`;
  const metal = th === THEMES.dark ? { frame: '#1b2129', unit: '#202832', unit2: '#262f3b', edge: '#36404d', screw: '#0d1117', label: '#c9d1d9', bay: '#151b23' }
    : { frame: '#d6dbe1', unit: '#eef1f4', unit2: '#e4e8ed', edge: '#c3cad3', screw: '#9aa4b1', label: '#24292f', bay: '#d9dee5' };
  const phpCount = (r.languages || []).find(([k]) => k === 'PHP')?.[1];
  let s = svgOpen(W, H, 'A minha stack por camadas: backend PHP/Laravel/MySQL, mobile Flutter/Dart, web JavaScript/HTML/CSS', css);
  s += `<text class="i" x="${RX}" y="40" font-size="22" font-weight="700" fill="${th.text}">A minha stack, por camadas</text>`;
  const sum = `${compact(r.own)} projetos próprios · ${r.languageCount ?? '–'} linguagens · ${compact(pub.count)} packages no pub.dev · desde ${p.since ?? '–'}`;
  s += `<text class="m" x="${RX}" y="64" font-size="13" fill="${th.muted}">${esc(sum)}</text>`;
  const RH = units.reduce((a, b) => a + b, 0) * U;
  s += `<rect x="${RX - 26}" y="${top - 12}" width="${RW + 52}" height="${RH + 24}" rx="10" fill="${metal.frame}" stroke="${metal.edge}"/>`;
  for (let i = 0; i < units.reduce((a, b) => a + b, 0); i++) {
    for (const sx of [RX - 13, RX + RW + 13]) {
      s += `<rect x="${sx - 3.5}" y="${top + i * U + U / 2 - 3.5}" width="7" height="7" rx="1.5" fill="${metal.screw}"/>`;
    }
  }
  let y = top, seed = 11;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const panel = (hU) => `<rect x="${RX}" y="${y + 2}" width="${RW}" height="${hU * U - 4}" rx="5" fill="${metal.unit}" stroke="${metal.edge}"/>`;
  const label = (x, yy, t, sz = 12, w = 700, fill = metal.label) => `<text class="m" x="${x}" y="${yy}" font-size="${sz}" font-weight="${w}" fill="${fill}" letter-spacing="0.5">${esc(t)}</text>`;
  const led = (cx, cy, col, r = 4.5, bad = false) => {
    const dur = bad ? 0.7 : 2.2 + rnd() * 2.4;
    return `<circle cx="${cx}" cy="${cy}" r="${r + 4}" fill="${col}" opacity="0.18"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="${col}"><animate attributeName="opacity" values="1;${bad ? 0.15 : 0.55};1" dur="${dur.toFixed(2)}s" repeatCount="indefinite"/></circle>`;
  };
  // U1-2: backend
  s += panel(2);
  s += led(RX + 24, y + 24, th.green);
  s += label(RX + 42, y + 29, 'BACKEND');
  s += label(RX + 42, y + 50, `php · laravel · mysql · rest apis${phpCount ? `  ·  ${phpCount} repos em PHP` : ''}`, 11.5, 400, th.muted);
  s += label(RX + 42, y + 68, 'packages, APIs e integrações de pagamentos', 11.5, 400, th.muted);
  for (let i = 0; i < 8; i++) {
    const bx = RX + 470 + i * 50;
    s += `<rect x="${bx}" y="${y + 12}" width="42" height="60" rx="4" fill="${metal.bay}" stroke="${metal.edge}"/>`;
    for (let j = 0; j < 5; j++) s += `<rect x="${bx + 8}" y="${y + 22 + j * 7}" width="26" height="2" rx="1" fill="${metal.edge}"/>`;
    s += `<circle cx="${bx + 21}" cy="${y + 63}" r="2.6" fill="${th.blue}"><animate attributeName="opacity" values="0.2;1;0.2;0.2;1;0.2" dur="${(0.9 + rnd() * 2.2).toFixed(2)}s" begin="${(rnd() * 2).toFixed(2)}s" repeatCount="indefinite"/></circle>`;
  }
  y += 2 * U;
  // U3: mobile
  s += panel(1);
  s += led(RX + 24, y + U / 2, th.blue);
  s += label(RX + 42, y + U / 2 + 4, 'MOBILE');
  s += label(RX + 160, y + U / 2 + 4, `flutter · dart · ${compact(pub.count)} packages · ${compact(pub.downloads30d)} downloads (30d)`, 11.5, 400, th.muted);
  y += U;
  // U4-5: tools patch panel
  s += panel(2);
  s += label(RX + 18, y + 22, 'FERRAMENTAS', 11, 700, th.muted);
  const tools = [
    { k: 'php', lvl: 'daily' }, { k: 'laravel', lvl: 'daily' }, { k: 'mysql', lvl: 'daily' },
    { k: 'flutter', lvl: 'project' }, { k: 'dart', lvl: 'project' }, { k: 'javascript', lvl: 'project' },
    { k: 'html/css', lvl: 'daily' }, { k: 'git', lvl: 'daily' }, { k: 'docker', lvl: 'occasional' },
  ];
  const toolColor = (lvl) => lvl === 'daily' ? th.green : lvl === 'project' ? th.blue : th.orange;
  const pw = (RW - 36) / tools.length;
  tools.forEach((t, i) => {
    const px = RX + 18 + i * pw;
    s += `<rect x="${px + 6}" y="${y + 33}" width="26" height="20" rx="3" fill="${metal.screw}" stroke="${metal.edge}"/><rect x="${px + 13}" y="${y + 47}" width="12" height="6" fill="${metal.unit2}"/>`;
    s += led(px + 46, y + 43, toolColor(t.lvl), 4);
    s += label(px + 6, y + 74, t.k, 12, 400, metal.label);
  });
  y += 2 * U;
  // U6: web
  s += panel(1);
  s += led(RX + 24, y + U / 2, th.green);
  s += label(RX + 42, y + U / 2 + 4, 'WEB');
  s += label(RX + 160, y + U / 2 + 4, 'javascript · html · css · dashboards e integrações', 11.5, 400, th.muted);
  y += U;
  // legend
  const ly = H - 26;
  s += `<circle cx="${RX + 4}" cy="${ly - 4}" r="4.5" fill="${th.green}"/>${label(RX + 16, ly, 'diário', 11.5, 400, th.muted)}`;
  s += `<circle cx="${RX + 74}" cy="${ly - 4}" r="4.5" fill="${th.blue}"/>${label(RX + 86, ly, 'por projeto', 11.5, 400, th.muted)}`;
  s += `<circle cx="${RX + 176}" cy="${ly - 4}" r="4.5" fill="${th.orange}"/>${label(RX + 188, ly, 'pontual', 11.5, 400, th.muted)}`;
  s += `<text class="m" x="${RX + RW}" y="${ly}" text-anchor="end" font-size="11.5" fill="${th.muted}">baseado no que está público no GitHub</text>`;
  return s + '</svg>';
}

// ---------------------------------------------------------------- 4. project tiles

const TILES = [
  {
    id: 'instagram', title: 'laravel-instagram-api', sub: 'github.com/michelmelo/laravel-instagram-api',
    desc: 'API de Instagram para Laravel: feed, stories e métricas embrulhados numa API que se instala com Composer.',
    chips: ['php', 'laravel', 'instagram'],
    art: (th, X, Y) => {
      let a = `<rect x="${X + 40}" y="${Y - 18}" width="126" height="158" rx="18" fill="${th.surface2}" stroke="${th.border}" stroke-width="2"/>`;
      a += `<rect x="${X + 50}" y="${Y - 8}" width="106" height="138" rx="12" fill="${th.page}"/>`;
      a += `<circle cx="${X + 66}" cy="${Y + 8}" r="7" fill="${th.border}"/><rect x="${X + 78}" y="${Y + 3}" width="46" height="4" rx="2" fill="${th.faint}"/><rect x="${X + 78}" y="${Y + 10}" width="30" height="3" rx="1.5" fill="${th.faint}"/>`;
      const cols = ['#ec4899', '#8b5cf6', '#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#eab308', '#14b8a6', '#f97316'];
      for (let i = 0; i < 9; i++) {
        const cx = X + 52 + (i % 3) * 35, cy = Y + 22 + Math.floor(i / 3) * 35;
        a += `<rect x="${cx}" y="${cy}" width="31" height="31" rx="4" fill="${cols[i]}" opacity="0.8"/>`;
      }
      a += `<path d="M${X + 150} ${Y + 114} c -6 -10 -20 -6 -20 4 c 0 8 12 16 20 21 c 8 -5 20 -13 20 -21 c 0 -10 -14 -14 -20 -4z" fill="${th.red}"/>`;
      return a;
    },
  },
  {
    id: 'easypay', title: 'laravel-easypay', sub: 'github.com/michelmelo/laravel-easypay',
    desc: 'Gateway de pagamentos Easypay para Laravel: referências, cartões e callbacks tratados sem dor.',
    chips: ['php', 'laravel', 'payments'],
    art: (th, X, Y) => {
      let a = `<rect x="${X + 8}" y="${Y + 8}" width="196" height="124" rx="14" fill="${th.surface2}" stroke="${th.border}" stroke-width="2"/>`;
      a += `<rect x="${X + 8}" y="${Y + 8}" width="196" height="30" rx="14" fill="${th.termBar}"/><rect x="${X + 8}" y="${Y + 24}" width="196" height="14" fill="${th.termBar}"/>`;
      a += `<rect x="${X + 26}" y="${Y + 50}" width="32" height="24" rx="4" fill="${th.orange}" opacity="0.85"/>`;
      a += `<rect x="${X + 30}" y="${Y + 58}" width="24" height="2" rx="1" fill="${th.page}" opacity="0.6"/><rect x="${X + 30}" y="${Y + 64}" width="18" height="2" rx="1" fill="${th.page}" opacity="0.6"/>`;
      a += `<text class="m" x="${X + 26}" y="${Y + 94}" font-size="11" fill="${th.muted}">•••• 4242</text>`;
      a += `<rect x="${X + 26}" y="${Y + 108}" width="52" height="6" rx="3" fill="${th.faint}"/>`;
      a += `<circle cx="${X + 170}" cy="${Y + 98}" r="24" fill="${th.green}"/>`;
      a += `<path d="M${X + 159} ${Y + 98} l8 9 l16 -18" stroke="${th.page}" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
      a += `<text class="m" x="${X + 170}" y="${Y + 62}" text-anchor="middle" font-size="20" font-weight="700" fill="${th.text}">€</text>`;
      return a;
    },
  },
  {
    id: 'miniplayer', title: 'flutter-miniplayer', sub: 'pub.dev/packages/flutter_miniplayer',
    desc: 'Package Flutter leve para criar um miniplayer: entra e sai do ecrã sem reescrever a lógica de áudio.',
    chips: ['dart', 'flutter', 'pub.dev'],
    art: (th, X, Y) => {
      let a = `<defs><linearGradient id="mp" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${th.violet}"/><stop offset="1" stop-color="${th.blue}"/></linearGradient></defs>`;
      a += `<rect x="${X + 30}" y="${Y - 18}" width="130" height="160" rx="18" fill="${th.surface2}" stroke="${th.border}" stroke-width="2"/>`;
      a += `<rect x="${X + 40}" y="${Y - 8}" width="110" height="140" rx="12" fill="${th.page}"/>`;
      a += `<rect x="${X + 52}" y="${Y + 4}" width="86" height="70" rx="8" fill="url(#mp)"/>`;
      a += `<circle cx="${X + 95}" cy="${Y + 39}" r="14" fill="${th.page}" opacity="0.9"/><path d="M${X + 91} ${Y + 31} l12 8 l-12 8z" fill="${th.violet}"/>`;
      a += `<rect x="${X + 52}" y="${Y + 84}" width="60" height="5" rx="2.5" fill="${th.faint}"/><rect x="${X + 52}" y="${Y + 94}" width="40" height="4" rx="2" fill="${th.faint}" opacity="0.7"/>`;
      a += `<rect x="${X + 52}" y="${Y + 108}" width="86" height="4" rx="2" fill="${th.faint}"/>`;
      a += `<rect x="${X + 52}" y="${Y + 107}" width="34" height="6" rx="3" fill="${th.accent}"><animate attributeName="width" values="34;62;34" dur="6s" repeatCount="indefinite"/></rect>`;
      a += `<circle cx="${X + 95}" cy="${Y + 124}" r="8" fill="${th.text}"/><path d="M${X + 92} ${Y + 119} l8 5 l-8 5z" fill="${th.page}"/>`;
      return a;
    },
  },
  {
    id: 'periquita', title: 'periquita', sub: 'github.com/michelmelo/periquita',
    desc: 'Arranque de projetos Laravel com um padrão organizado: estrutura, configuração e convenções prontas a usar.',
    chips: ['php', 'laravel', 'scaffolding'],
    art: (th, X, Y) => {
      let a = `<rect x="${X + 10}" y="${Y - 6}" width="200" height="140" rx="10" fill="${th.surface2}" stroke="${th.border}" stroke-width="2"/>`;
      a += `<rect x="${X + 10}" y="${Y - 6}" width="200" height="24" rx="10" fill="${th.termBar}"/><rect x="${X + 10}" y="${Y + 6}" width="200" height="12" fill="${th.termBar}"/>`;
      ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => { a += `<circle cx="${X + 24 + i * 12}" cy="${Y + 6}" r="3.5" fill="${c}"/>`; });
      a += `<text class="m" x="${X + 26}" y="${Y + 42}" font-size="10" fill="${th.muted}">$ composer create-project</text>`;
      const rows = [['app/', th.accentText, 0], ['config/', th.blue, 1], ['routes/', th.blue, 1], ['tests/', th.blue, 1], ['.env.example', th.muted, 2]];
      rows.forEach(([t, c, ind], i) => {
        a += `<text class="m" x="${X + 26 + ind * 14}" y="${Y + 60 + i * 13}" font-size="10.5" fill="${c}">${t}</text>`;
      });
      a += `<rect x="${X + 26}" y="${Y + 120}" width="80" height="8" rx="4" fill="${th.green}" opacity="0.9"/>`;
      return a;
    },
  },
];

function wrap(text, max) {
  const out = [];
  for (const w of text.split(' ')) {
    if (out.length && (out[out.length - 1] + ' ' + w).length <= max) out[out.length - 1] += ' ' + w;
    else out.push(w);
  }
  return out;
}

function tile(t, th) {
  const W = 490, H = 270;
  const css = fonts(['i400', 'i800', 'm400', 'm700']) + `.m{font-family:${MONO}}.i{font-family:${INTER}}`;
  let s = svgOpen(W, H, `${t.title}: ${t.desc}`, css);
  s += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="16" fill="${th.surface}" stroke="${th.border}"/>`;
  s += `<text class="i" x="26" y="50" font-size="26" font-weight="800" fill="${th.text}" letter-spacing="-0.6">${esc(t.title)}</text>`;
  s += `<text class="m" x="27" y="72" font-size="11.5" fill="${th.muted}">${esc(t.sub)}</text>`;
  wrap(t.desc, 30).forEach((l, i) => { s += `<text class="i" x="26" y="${106 + i * 21}" font-size="14" fill="${th.text}" opacity="0.92">${esc(l)}</text>`; });
  let cx = 26;
  for (const c of t.chips) {
    const w = c.length * 7.2 + 20;
    s += `<rect x="${cx}" y="${H - 44}" width="${w}" height="24" rx="12" fill="none" stroke="${th.border}"/><text class="m" x="${cx + w / 2}" y="${H - 28}" text-anchor="middle" font-size="12" fill="${th.muted}">${esc(c)}</text>`;
    cx += w + 8;
  }
  s += `<text class="m" x="${W - 24}" y="${H - 27}" text-anchor="end" font-size="13" font-weight="700" fill="${th.accentText}">open →</text>`;
  s += t.art(th, 262, 92);
  return s + '</svg>';
}

// ---------------------------------------------------------------- tech stack strip

function stack(th) {
  const W = 1000, FS = 14, LH = 23;
  const deps = [['php', '8.x, todos os dias'], ['laravel', 'o framework'], ['mysql', 'sempre'], ['flutter', 'apps'], ['dart', 'packages'], ['composer', 'sempre']];
  const dev = [['javascript', 'web'], ['html', 'web'], ['css', 'web'], ['git', 'sempre'], ['docker', 'quando ajuda'], ['gh', 'cli']];
  const col = (x, y0, title, list) => {
    let o = `<text x="${x}" y="${y0}" xml:space="preserve"><tspan fill="${th.blue}">"${title}"</tspan><tspan fill="${th.muted}">: {</tspan></text>`;
    list.forEach(([k, v], i) => {
      o += `<text x="${x + 22}" y="${y0 + (i + 1) * LH}" xml:space="preserve"><tspan fill="${th.green}">"${esc(k)}"</tspan><tspan fill="${th.muted}">: </tspan><tspan fill="${th.orange}">"${esc(v)}"</tspan><tspan fill="${th.muted}">${i < list.length - 1 ? ',' : ''}</tspan></text>`;
    });
    o += `<text x="${x}" y="${y0 + (list.length + 1) * LH}" fill="${th.muted}">}</text>`;
    return o;
  };
  const H = 58 + (deps.length + 2) * LH + 24;
  const css = fonts(['m400']) + `text{font-family:${MONO};font-size:${FS}px}`;
  let s = svgOpen(W, H, 'Tech stack: PHP, Laravel, MySQL, Flutter, Dart, Composer; também JavaScript, HTML, CSS, Git e Docker', css);
  s += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="${th.termBg}" stroke="${th.border}"/>`;
  s += `<text x="24" y="32" fill="${th.muted}" style="font-size:12px">~/michel/stack.json</text><line x1="0" y1="46" x2="${W}" y2="46" stroke="${th.border}"/>`;
  s += col(24, 76, 'dependencies', deps);
  s += col(530, 76, 'devDependencies', dev);
  return s + '</svg>';
}

// ---------------------------------------------------------------- 5. week receipt

function setsReps(n) {
  if (!n) return '0 x 0';
  for (const r of [10, 8, 12, 6, 5, 9, 7, 11]) if (n % r === 0 && n / r >= 2) return `${n / r} x ${r}`;
  return n >= 10 ? `${Math.floor(n / 10)} x 10 +${n % 10}` : `1 x ${n}`;
}

function receipt(data) {
  const w = data.week || {};
  const paper = '#fffdf6', ink = '#25231f', inkSoft = '#6b675c';
  const W = 460, CH = 13.5 * 0.6, FS = 13.5, LH = 21, COLS = 46;
  const pad = (l, r) => l + ' '.repeat(Math.max(1, COLS - l.length - r.length)) + r;
  const center = (t) => ' '.repeat(Math.max(0, Math.floor((COLS - t.length) / 2))) + t;
  const rule = '-'.repeat(COLS);
  const fd = (iso) => { const [y, m, d] = (iso || '').split('-'); return d ? `${d}.${m}.${y}` : '?'; };
  const lines = [
    ['b', center("MICHEL'S CODE & WINE")],
    ['s', center('Portugal · PHP & vinho')],
    ['s', center(`${fd(w.from)} - ${fd(w.to)}`)],
    ['', rule],
    ['s', pad('ITEM', 'QTY')],
    ['', pad('COMMITS', `${setsReps(w.commits)}`.padStart(11) + `${w.commits ?? 0}`.padStart(9))],
    ['', pad('PRS ENVIADOS', `${w.prsShipped ?? 0}`)],
    ['', pad('PRS REVISTOS', `${w.prsReviewed ?? 0}`)],
    ['', pad('ISSUES FECHADAS', `${w.issuesClosed ?? 0}`)],
    ['', pad('THREADS RESPONDIDAS', `${w.threadsCommented ?? 0}`)],
    ['', rule],
    ['', pad('SUBSCRIÇÃO', '0.00 EUR')],
    ['', pad('ADS E TRACKERS', '0.00 EUR')],
    ['', pad('CÁLICE DE VINHO', 'não faturado')],
    ['', rule],
    ['b', pad('TOTAL', '0.00 EUR')],
    ['s', pad('PAGO COM', 'CAFÉ + PHP')],
    ['', ''],
    ['s', center('sem contas, sem paywalls.')],
    ['s', center('obrigado pela visita!')],
  ];
  const top = 34, H = top + lines.length * LH + 92;
  const x0 = (W - COLS * CH) / 2;
  const css = fonts(['m400', 'm700']) + `text{font-family:${MONO};font-size:${FS}px}`;
  let s = svgOpen(W, H, `A minha semana no GitHub em forma de recibo: ${w.commits ?? 0} commits, ${w.prsShipped ?? 0} PRs enviados, ${w.issuesClosed ?? 0} issues fechadas. Subscrição 0.00 EUR.`, css);
  const pts = [];
  for (let x = 0; x <= W; x += 12) pts.push([x, 7], [Math.min(x + 6, W), 0]);
  for (let x = W; x >= 0; x -= 12) pts.push([x, H - 7], [Math.max(x - 6, 0), H]);
  const shape = 'M' + pts.map(([px, py]) => `${px} ${py}`).join('L') + 'Z';
  s += `<defs><clipPath id="print"><rect x="0" y="0" width="${W}" height="${H}"><animate attributeName="height" from="0" to="${H}" dur="2.4s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.3 0 0.4 1"/></rect></clipPath></defs>`;
  s += `<g clip-path="url(#print)"><path d="${shape}" fill="${paper}" stroke="#e5e1d3"/>`;
  lines.forEach(([kind, t], i) => {
    s += `<text x="${x0}" y="${top + 14 + i * LH}" xml:space="preserve" fill="${kind === 's' ? inkSoft : ink}"${kind === 'b' ? ' font-weight="700"' : ''}>${esc(t)}</text>`;
  });
  let bx = x0 + 30, seed = (w.commits || 1) * 31 + (w.issuesClosed || 1);
  const by = top + lines.length * LH + 8;
  while (bx < W - x0 - 30) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const bw = 1 + (seed % 3);
    s += `<rect x="${bx.toFixed(1)}" y="${by}" width="${bw}" height="40" fill="${ink}"/>`;
    bx += bw + 1 + ((seed >> 4) % 3);
  }
  s += `<text x="${W / 2}" y="${by + 58}" text-anchor="middle" fill="${inkSoft}" style="font-size:11px">github.com/${USER}  ·  #${(w.to || '').replace(/-/g, '')}</text>`;
  s += '</g>';
  return s + '</svg>';
}

// ---------------------------------------------------------------- main

const data = await collect();
fs.mkdirSync(ASSETS, { recursive: true });
for (const mode of ['dark', 'light']) {
  const th = THEMES[mode];
  write(`terminal-${mode}.svg`, terminal(data, th));
  write(`packages-${mode}.svg`, statsCard(data, mode));
  write(`stackrack-${mode}.svg`, stackRack(data, th));
  for (const t of TILES) write(`tile-${t.id}-${mode}.svg`, tile(t, th));
  write(`stack-${mode}.svg`, stack(th));
  write(`receipt-${mode}.svg`, receipt(data));
}
if (!OFFLINE) fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n');
log('done');
