#!/usr/bin/env node
/**
 * 王者荣耀五排 BP 平台 · 英雄头像离线化
 * ---------------------------------------------------------------
 * 零 npm 依赖（只用 node 内置模块）。把天元之弈 /api/allheroes 里的
 * avatarUrl（图像 CDN img.pvp.mcxssg.net）逐张下载到 web/icons/，
 * 并按 bp/data/heroes.js 的名单生成 web/heroicons.js 映射表。
 *
 * 用法：
 *   node tools/fetch-icons.mjs            增量：缺的/坏的重下，好的跳过，最后重写映射
 *   node tools/fetch-icons.mjs --force    强制重下全部 133 张
 *   node tools/fetch-icons.mjs --check    只校验本地文件（不联网、不写盘）
 *   node tools/fetch-icons.mjs --verbose  额外打印「跳过」明细
 *   node tools/fetch-icons.mjs --snapshot=2026-10-23   指定快照日期
 *   node tools/fetch-icons.mjs --no-transcode          禁用本机转码（非 PNG 源保留 .jpg/.webp）
 *   node tools/fetch-icons.mjs --help
 *
 * 校验规则（逐张）：
 *   - HTTP 200、content-type 以 image/ 开头
 *   - 字节数 5KB ~ 2MB
 *   - 文件魔数必须是合法图片（PNG / JPEG / WebP / GIF）
 *   - 入库统一为 PNG：上游本就是 PNG 的直接落盘；仅提供 JPEG/WebP 的，
 *     先试同路径 .png 变体，再退到本机转码器（ffmpeg 或 Python+Pillow）
 *     降采样到 128×128 转成 PNG；都没有时才保留原格式（.jpg/.webp），
 *     并在汇总里标注，绝不伪造占位图。
 *
 * 失败重试 3 次（退避 300 / 900 / 2400ms），并发上限 6，单张超时 20s。
 * 退出码：0 = 全部成功；1 = 有失败/缺失/映射不同步。
 *
 * 数据来源与致谢：天元之弈（tianyuanzhiyi.com）/ mcxssg 图床，仅供本地个人 BP 工具使用。
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_ROOT = path.join(ROOT, 'data', 'snapshot');
const HEROES_JS = path.join(ROOT, 'bp', 'data', 'heroes.js');
const ICON_DIR = path.join(ROOT, 'web', 'icons');
const MAPPING_JS = path.join(ROOT, 'web', 'heroicons.js');
const TMP_DIR = path.join(ICON_DIR, '.tmp');

const MIN_BYTES = 5 * 1024;          // 5KB
const MAX_BYTES = 2 * 1024 * 1024;   // 2MB
const CONCURRENCY = 6;
const TIMEOUT_MS = 20000;
const RETRIES = 3;
const BACKOFF_MS = [300, 900, 2400];
const ICON_SIZE = 128;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const REFERER = 'https://tianyuanzhiyi.com/heroes';

/* ---------------- 参数 ---------------- */

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (name, dflt) => {
  const hit = argv.find((a) => a === name || a.startsWith(name + '='));
  if (!hit) return dflt;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  const i = argv.indexOf(hit);
  return argv[i + 1] || dflt;
};
const FLAGS = {
  force: has('--force'),
  check: has('--check'),
  verbose: has('--verbose') || has('-v'),
  help: has('--help') || has('-h'),
  noTranscode: has('--no-transcode'), // 禁用本机转码：非 PNG 源按原格式保留（.jpg/.webp）
  concurrency: Math.max(1, Math.min(16, Number(val('--concurrency', CONCURRENCY)) || CONCURRENCY)),
  snapshot: val('--snapshot', null),
};

if (FLAGS.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(0);
}

/* ---------------- 小工具 ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function readHeroes() {
  const code = fs.readFileSync(HEROES_JS, 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox, { filename: HEROES_JS });
  const list = sandbox.window.HEROES;
  if (!Array.isArray(list) || !list.length) throw new Error('bp/data/heroes.js 未解析出 window.HEROES');
  return list;
}

/** 找到快照目录（默认取 data/snapshot/ 下日期最新的一个） */
function resolveSnapshot() {
  if (FLAGS.snapshot) {
    const p = path.isAbsolute(FLAGS.snapshot) ? FLAGS.snapshot : path.join(SNAPSHOT_ROOT, FLAGS.snapshot);
    const file = fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ? path.join(p, 'allheroes.json') : p;
    if (!fs.existsSync(file)) throw new Error(`快照不存在：${file}`);
    return file;
  }
  const dirs = fs.existsSync(SNAPSHOT_ROOT)
    ? fs.readdirSync(SNAPSHOT_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse()
    : [];
  for (const d of dirs) {
    const f = path.join(SNAPSHOT_ROOT, d, 'allheroes.json');
    if (fs.existsSync(f)) return f;
  }
  throw new Error('data/snapshot/ 下找不到任何 allheroes.json');
}

function readAllHeroes(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('allheroes.json 不是数组');
  return raw;
}

/* ---------------- 图片校验 ---------------- */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 按魔数识别图片格式，返回扩展名或 null */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) return 'gif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp'; // BMP 视为非法头像（不透明/体积大）
  return null;
}

/** 校验一段字节是否是可入库的头像；返回 { ok, format, error } */
function validateBuffer(buf, { contentType = '', expectedFormat = null } = {}) {
  if (!buf || !buf.length) return { ok: false, error: '空响应体' };
  if (contentType && !contentType.toLowerCase().startsWith('image/')) {
    return { ok: false, error: `content-type 非图片：${contentType || '(空)'}` };
  }
  if (buf.length < MIN_BYTES) return { ok: false, error: `体积过小 ${buf.length}B < 5KB` };
  if (buf.length > MAX_BYTES) return { ok: false, error: `体积过大 ${buf.length}B > 2MB` };
  const format = sniffImage(buf);
  if (!format) return { ok: false, error: `魔数不是合法图片：${buf.subarray(0, 8).toString('hex')}` };
  if (format === 'bmp') return { ok: false, error: '不支持的图片格式 BMP' };
  if (expectedFormat && format !== expectedFormat) {
    return { ok: false, error: `扩展名 .${expectedFormat} 与实际格式 ${format} 不符` };
  }
  return { ok: true, format };
}

/** 校验磁盘上的一个头像文件；返回 { ok, format, bytes, error } */
function validateFile(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const expect = ext === 'jpeg' ? 'jpg' : ext === 'jpe' ? 'jpg' : ext;
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { ok: false, bytes: 0, error: '读文件失败：' + e.message };
  }
  const v = validateBuffer(buf, { expectedFormat: ['png', 'jpg', 'webp', 'gif'].includes(expect) ? expect : null });
  return { ...v, bytes: buf.length };
}

/* ---------------- HTTP ---------------- */

function httpGet(url, { timeoutMs = TIMEOUT_MS, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const req = https.get(url, {
      headers: { 'user-agent': UA, referer: REFERER, accept: 'image/*,*/*' },
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (redirects >= 3) return done(reject, new Error('重定向次数过多'));
        const next = new URL(res.headers.location, url).href;
        return httpGet(next, { timeoutMs, redirects: redirects + 1 }).then((r) => done(resolve, r), (e) => done(reject, e));
      }
      const chunks = [];
      let received = 0;
      res.on('data', (d) => {
        received += d.length;
        if (received > MAX_BYTES + 1024) {
          res.destroy();
          return done(reject, new Error(`响应体超过 ${mb(MAX_BYTES)}`));
        }
        chunks.push(d);
      });
      res.on('end', () => done(resolve, { status, contentType: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks), finalUrl: url }));
      res.on('error', (e) => done(reject, e));
    });
    req.on('timeout', () => { req.destroy(); done(reject, new Error(`超时 ${timeoutMs}ms`)); });
    req.on('error', (e) => done(reject, e));
  });
}

/** 失败重试 retries 次，退避 300/900/2400ms */
async function withRetry(label, fn) {
  const errs = [];
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      errs.push(e && e.message ? e.message : String(e));
      if (attempt < RETRIES) await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
    }
  }
  const last = errs[errs.length - 1] || '未知错误';
  throw new Error(errs.length > 1 ? `${last}（共试 ${errs.length} 次：${[...new Set(errs)].join(' / ')}）` : last);
}

/* ---------------- 可选本机转码器（仅在需要把 JPEG/WebP 统一成 PNG 时才用） ---------------- */

const PIL_SCRIPT = [
  'import sys',
  'from PIL import Image',
  'src, dst, size = sys.argv[1], sys.argv[2], int(sys.argv[3])',
  'im = Image.open(src).convert("RGBA")',
  'if im.size != (size, size):',
  '    im = im.resize((size, size), Image.LANCZOS)',
  'im.save(dst, "PNG", optimize=True)',
].join('\n');

let converterCache;
function detectConverter() {
  if (converterCache !== undefined) return converterCache;
  const cands = [];
  for (const bin of ['ffmpeg']) {
    const r = spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 10000 });
    if (r.status === 0) {
      cands.push({
        name: 'ffmpeg',
        run: (src, dst) => spawnSync('ffmpeg', [
          '-y', '-loglevel', 'error', '-i', src,
          '-vf', `scale=${ICON_SIZE}:${ICON_SIZE}:force_original_aspect_ratio=decrease,pad=${ICON_SIZE}:${ICON_SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
          '-frames:v', '1', '-pix_fmt', 'rgba', dst,
        ], { stdio: 'ignore', timeout: 30000 }),
      });
      break;
    }
  }
  for (const bin of ['python', 'python3', 'py']) {
    const r = spawnSync(bin, ['-c', 'import PIL'], { stdio: 'ignore', timeout: 10000 });
    if (r.status === 0) {
      cands.push({
        name: `python+Pillow(${bin})`,
        run: (src, dst) => spawnSync(bin, ['-c', PIL_SCRIPT, src, dst, String(ICON_SIZE)], { stdio: 'ignore', timeout: 30000 }),
      });
      break;
    }
  }
  converterCache = cands;
  return cands;
}

/**
 * 把任意格式图片转成 128×128 PNG。返回 { ok, converter, bytes, error }
 * 没有可用转码器时返回 { ok:false, unavailable:true }
 */
function transcodeToPng(srcBuf, id) {
  const converters = detectConverter();
  if (!converters.length) return { ok: false, unavailable: true, error: '本机无 ffmpeg / Python+Pillow，无法转码' };
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const srcFile = path.join(TMP_DIR, `${id}.src`);
  const dstFile = path.join(TMP_DIR, `${id}.png`);
  fs.writeFileSync(srcFile, srcBuf);
  const errors = [];
  try {
    for (const c of converters) {
      try {
        fs.rmSync(dstFile, { force: true });
        const r = c.run(srcFile, dstFile);
        if (r.error) throw new Error(r.error.message);
        if (r.status !== 0) throw new Error(`退出码 ${r.status}`);
        if (!fs.existsSync(dstFile)) throw new Error('未生成输出文件');
        const out = fs.readFileSync(dstFile);
        const v = validateBuffer(out, { expectedFormat: 'png' });
        if (!v.ok) throw new Error(v.error);
        return { ok: true, converter: c.name, bytes: out };
      } catch (e) {
        errors.push(`${c.name}: ${e.message}`);
      }
    }
  } finally {
    fs.rmSync(srcFile, { force: true });
    fs.rmSync(dstFile, { force: true });
  }
  return { ok: false, error: errors.join(' | ') };
}

/* ---------------- 落盘 ---------------- */

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];

/** 在 web/icons/ 里找已存在的头像文件（不含 .tmp） */
function findExisting(id) {
  for (const ext of IMAGE_EXTS) {
    const f = path.join(ICON_DIR, `${id}${ext}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

function removeOtherFormats(id, keepFile) {
  const removed = [];
  for (const ext of IMAGE_EXTS) {
    const f = path.join(ICON_DIR, `${id}${ext}`);
    if (f !== keepFile && fs.existsSync(f)) {
      fs.rmSync(f, { force: true });
      removed.push(path.basename(f));
    }
  }
  return removed;
}

/* ---------------- 单张处理 ---------------- */

/**
 * 下载并落盘一张头像。
 * 返回 { status: 'downloaded'|'skipped', file, format, bytes, converter?, pngSibling? }
 * 抛错即表示失败（含原因）。
 */
async function fetchOne(hero, avatarUrl) {
  const id = hero.id;
  if (!FLAGS.force) {
    const existing = findExisting(id);
    if (existing) {
      const v = validateFile(existing);
      if (v.ok) return { status: 'skipped', file: existing, format: v.format, bytes: v.bytes };
    }
  }

  return withRetry(`下载 ${hero.name}`, async () => {
    const res = await httpGet(avatarUrl);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const v = validateBuffer(res.body, { contentType: res.contentType });
    if (!v.ok) throw new Error(v.error);

    let outBuf = res.body;
    let format = v.format;
    let converter = null;
    let pngSibling = false;

    if (format !== 'png') {
      // 1) 同路径 .png 变体（部分上游为 webp 但保留 png 兄弟文件）
      if (!/\.png(\?|$)/i.test(avatarUrl)) {
        const siblingUrl = avatarUrl.replace(/\.[a-z0-9]+(\?.*)?$/i, '.png$1');
        if (siblingUrl !== avatarUrl) {
          try {
            const s = await httpGet(siblingUrl);
            if (s.status === 200) {
              const sv = validateBuffer(s.body, { contentType: s.contentType });
              if (sv.ok && sv.format === 'png') {
                outBuf = s.body; format = 'png'; pngSibling = true;
              }
            }
          } catch { /* 忽略，走转码 */ }
        }
      }
      // 2) 本机转码成 128×128 PNG
      if (format !== 'png' && !FLAGS.noTranscode) {
        const t = transcodeToPng(outBuf, id);
        if (t.ok) { outBuf = t.bytes; format = 'png'; converter = t.converter; }
        else if (!t.unavailable) throw new Error(`转码失败：${t.error}`);
        // t.unavailable → 保留原格式（降级）
      }
    }

    const file = path.join(ICON_DIR, `${id}.${format}`);
    writeAtomic(file, outBuf);
    // 落盘后再校验一次，防止磁盘问题
    const check = validateFile(file);
    if (!check.ok) { fs.rmSync(file, { force: true }); throw new Error('落盘校验失败：' + check.error); }
    const removed = removeOtherFormats(id, file);
    return { status: 'downloaded', file, format, bytes: check.bytes, converter, pngSibling, removed };
  });
}

/* ---------------- 映射表 ---------------- */

function buildMapping(heroes) {
  const map = {};
  const missing = [];
  const formats = {};
  let totalBytes = 0;
  for (const h of heroes) {
    const f = findExisting(h.id);
    if (!f) { missing.push(h); continue; }
    const v = validateFile(f);
    if (!v.ok) { missing.push(h); continue; }
    map[h.name] = '/icons/' + path.basename(f);
    formats[v.format] = (formats[v.format] || 0) + 1;
    totalBytes += v.bytes;
  }
  return { map, missing, formats, totalBytes };
}

function renderMappingJs({ map, formats, totalBytes, snapshotFile, heroesTotal }) {
  const entries = Object.entries(map);
  const body = entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  const fmtLine = Object.entries(formats).map(([k, n]) => `${k.toUpperCase()} ${n}`).join(' / ') || '无';
  return `/* 王者荣耀五排 BP 平台 · 英雄头像映射表（自动生成，请勿手工修改）
 *
 * 头像来源：天元之弈 tianyuanzhiyi.com（/api/allheroes 的 avatarUrl），
 *           图像 CDN img.pvp.mcxssg.net（128×128）。
 * 数据快照：${rel(snapshotFile)}
 * 生成命令：node tools/fetch-icons.mjs${FLAGS.force ? ' --force' : ''}
 * 生成时间：${new Date().toISOString()}
 * 覆盖情况：${entries.length}/${heroesTotal} 个英雄有本地头像（${fmtLine}），合计 ${mb(totalBytes)}
 *
 * 结构：英雄名 -> 本地头像路径（/icons/<英雄id>.<ext>），仅收录实际存在且校验通过的图。
 * 用法：<img src="${'${window.HERO_ICON[hero.name]}'}">，缺失时自行回退占位样式。
 */
window.HERO_ICON = {
${body}
};
`;
}

/** 只从现存映射文件里解析键值，用于 --check 比对 */
function readMappingKeys() {
  if (!fs.existsSync(MAPPING_JS)) return null;
  const sandbox = { window: {} };
  try {
    vm.runInNewContext(fs.readFileSync(MAPPING_JS, 'utf8'), sandbox, { filename: MAPPING_JS });
    const m = sandbox.window.HERO_ICON;
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

/* ---------------- 主流程 ---------------- */

const snapshotFile = resolveSnapshot();
const allHeroes = readAllHeroes(snapshotFile);
const heroes = readHeroes();

const byId = new Map();
for (const a of allHeroes) if (a && a.id !== undefined) byId.set(Number(a.id), a);

console.log(`[icons] 英雄名单 ${heroes.length} 个（bp/data/heroes.js）`);
console.log(`[icons] 头像数据 ${allHeroes.length} 条（${rel(snapshotFile)}）`);
console.log(`[icons] 输出目录 web/icons/  | 映射 web/heroicons.js  | 模式 ${FLAGS.check ? '--check 只校验' : FLAGS.force ? '--force 全量重下' : '增量'}`);

if (FLAGS.check) {
  /* ---------- 只校验 ---------- */
  let pass = 0;
  const bad = [];
  const formats = {};
  let totalBytes = 0;
  for (const h of heroes) {
    const f = findExisting(h.id);
    if (!f) { bad.push({ name: h.name, id: h.id, reason: '文件缺失' }); continue; }
    const v = validateFile(f);
    if (!v.ok) { bad.push({ name: h.name, id: h.id, reason: `${path.basename(f)}：${v.error}` }); continue; }
    pass++;
    formats[v.format] = (formats[v.format] || 0) + 1;
    totalBytes += v.bytes;
  }
  const mapping = readMappingKeys();
  const expect = buildMapping(heroes);
  const mapEntries = mapping ? Object.keys(mapping).length : -1;
  let mapIssues = [];
  if (!mapping) mapIssues.push('web/heroicons.js 缺失或不是合法 JS');
  else {
    for (const [k, v] of Object.entries(expect.map)) {
      if (mapping[k] !== v) mapIssues.push(`映射不匹配 ${k}: 文件=${v} 映射=${mapping[k] ?? '(缺)'}`);
    }
    for (const k of Object.keys(mapping)) if (!(k in expect.map)) mapIssues.push(`映射多出 ${k}`);
  }

  console.log(`\n[check] 文件校验：通过 ${pass}/${heroes.length}`);
  if (pass) console.log(`[check] 合计 ${mb(totalBytes)}，平均 ${kb(totalBytes / pass)}，格式 ${Object.entries(formats).map(([k, n]) => `${k.toUpperCase()} ${n}`).join(' / ')}`);
  if (bad.length) {
    console.log(`[check] 不通过 ${bad.length} 张：`);
    for (const b of bad) console.log(`  ✗ ${b.name} ${b.id}  ${b.reason}`);
  }
  console.log(`[check] 映射表 web/heroicons.js：${mapEntries} 条${mapIssues.length ? `，${mapIssues.length} 处不同步` : '，与磁盘一致'}`);
  for (const m of mapIssues.slice(0, 10)) console.log(`  ! ${m}`);
  if (mapIssues.length > 10) console.log(`  ! ……另有 ${mapIssues.length - 10} 处`);

  const okAll = bad.length === 0 && mapIssues.length === 0 && pass === heroes.length;
  console.log(okAll ? '\n[check] ✅ 全部通过' : '\n[check] ❌ 存在问题（见上）');
  process.exit(okAll ? 0 : 1);
}

/* ---------- 下载 ---------- */
fs.mkdirSync(ICON_DIR, { recursive: true });
fs.rmSync(TMP_DIR, { recursive: true, force: true });

const stats = { total: heroes.length, downloaded: 0, skipped: 0, failed: 0 };
const failures = [];
const fresh = [];
let doneCount = 0;

const tasks = heroes.map((h) => {
  const a = byId.get(Number(h.id));
  return { hero: h, avatarUrl: a && a.avatarUrl ? String(a.avatarUrl) : null };
});

let nextIndex = 0;
async function worker() {
  while (true) {
    const i = nextIndex++;
    if (i >= tasks.length) return;
    const { hero, avatarUrl } = tasks[i];
    const tag = `[${String(i + 1).padStart(3, ' ')}/${tasks.length}]`;
    if (!avatarUrl) {
      stats.failed++;
      failures.push({ name: hero.name, id: hero.id, url: '(无 avatarUrl)', reason: '快照里缺少该英雄的 avatarUrl' });
      console.log(`${tag} ✗ ${hero.name} ${hero.id}  快照缺 avatarUrl`);
      continue;
    }
    try {
      const r = await fetchOne(hero, avatarUrl);
      if (r.status === 'skipped') {
        stats.skipped++;
        if (FLAGS.verbose) console.log(`${tag} · ${hero.name} ${hero.id}  已存在且校验通过，跳过（${path.basename(r.file)}, ${kb(r.bytes)}）`);
      } else {
        stats.downloaded++;
        fresh.push(r);
        const note = r.converter ? ` 转码自 ${r.converter}` : r.pngSibling ? ' 用 .png 兄弟文件' : '';
        console.log(`${tag} ✓ ${hero.name} ${hero.id}  ${path.basename(r.file)} ${kb(r.bytes)}${note}`);
      }
    } catch (e) {
      stats.failed++;
      failures.push({ name: hero.name, id: hero.id, url: avatarUrl, reason: e.message });
      console.log(`${tag} ✗ ${hero.name} ${hero.id}  ${e.message}`);
    }
    doneCount++;
  }
}

await Promise.all(Array.from({ length: Math.min(FLAGS.concurrency, tasks.length) }, worker));

fs.rmSync(TMP_DIR, { recursive: true, force: true });

/* ---------- 生成映射表 ---------- */
const built = buildMapping(heroes);
const mappingText = renderMappingJs({ ...built, snapshotFile, heroesTotal: heroes.length });
const prev = fs.existsSync(MAPPING_JS) ? fs.readFileSync(MAPPING_JS, 'utf8') : null;
// 去掉易变的时间行再比较，避免每次都判定「有变化」
const stable = (s) => s.replace(/^ \* 生成时间：.*$/m, '').replace(/^ \* 生成命令：.*$/m, '');
if (prev === null || stable(prev) !== stable(mappingText)) {
  writeAtomic(MAPPING_JS, Buffer.from(mappingText, 'utf8'));
  console.log(`[icons] 已更新映射 web/heroicons.js（${Object.keys(built.map).length} 条）`);
} else {
  console.log(`[icons] 映射 web/heroicons.js 无变化（${Object.keys(built.map).length} 条）`);
}

/* ---------- 汇总 ---------- */
const formatCount = Object.entries(built.formats).map(([k, n]) => `${k.toUpperCase()} ${n}`).join(' / ') || '无';
const transcoded = fresh.filter((r) => r.converter);
const siblingUsed = fresh.filter((r) => r.pngSibling);
console.log('\n================ 汇总 ================');
console.log(`总数      ${stats.total}`);
console.log(`新下载    ${stats.downloaded}`);
if (transcoded.length) console.log(`          └ 转码为 PNG：${transcoded.length} 张（${[...new Set(transcoded.map((r) => r.converter))].join(' / ')}）`);
if (siblingUsed.length) console.log(`          └ 用 .png 兄弟文件：${siblingUsed.length} 张`);
console.log(`跳过      ${stats.skipped}`);
console.log(`失败      ${stats.failed}`);
console.log(`磁盘合计  ${Object.keys(built.map).length} 张 / ${mb(built.totalBytes)} / 平均 ${kb(built.totalBytes / Math.max(1, Object.keys(built.map).length))}（${formatCount}）`);
console.log(`映射      web/heroicons.js → ${Object.keys(built.map).length} 条`);
if (built.missing.length) {
  console.log(`映射缺口  ${built.missing.length} 个英雄：${built.missing.map((h) => `${h.name}(${h.id})`).join('、')}`);
}
if (failures.length) {
  console.log('\n失败清单（name id url 原因）：');
  for (const f of failures) console.log(`  ✗ ${f.name} ${f.id} ${f.url} ${f.reason}`);
}
const allOk = stats.failed === 0 && built.missing.length === 0 && Object.keys(built.map).length === heroes.length;
console.log(allOk ? '\n[icons] ✅ 133 个英雄头像已全部本地化' : '\n[icons] ❌ 存在缺口，见上');
process.exit(allOk ? 0 : 1);
