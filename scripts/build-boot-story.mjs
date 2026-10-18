#!/usr/bin/env node
/**
 * 为 docs/animation/boot.html 生成：
 *   boot/story-code.js    真实源码片段（保留原行号，折叠未编译的 #ifdef 与大段注释）
 *   boot/story-timing.js  每个 op 的配音文件与时长（读取 boot/audio/manifest.json）
 *   tmp/boot-story-tts.json  配音脚本输入
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ACTS, CODE_REFS } from '../docs/animation/boot/story-data.js';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'docs/animation/boot');
export const VOICE = process.env.BOOT_VOICE || 'zh-CN-XiaoxiaoNeural';

const norm = s => s.replace(/\s+/g, ' ').trim();
const config = new Set(fs.readFileSync(path.join(root, 'artifacts/build/linux/.config'), 'utf8')
  .split('\n').filter(l => /^CONFIG_\w+=[ym]/.test(l)).map(l => l.split('=')[0]));

function configTrue(cond) {
  const m = cond.match(/^#\s*ifdef\s+(CONFIG_\w+)/) || cond.match(/^#\s*if\s+IS_ENABLED\((CONFIG_\w+)\)/);
  if (m) return config.has(m[1]);
  const n = cond.match(/^#\s*ifndef\s+(CONFIG_\w+)/);
  if (n) return !config.has(n[1]);
  const d = [...cond.matchAll(/defined\((CONFIG_\w+)\)/g)].map(x => x[1]);
  if (/^#\s*if\s/.test(cond) && d.length && /^[#\sif()|definedCONFIG_\w]+$/.test(cond)) return d.some(x => config.has(x));
  return null;
}

function collapse(lines) {
  const out = [];
  const stack = [];
  let inComment = false;
  let commentStart = 0;
  let skipped = false;
  const visible = () => stack.every(f => f.keep);
  for (const line of lines) {
    const t = line.t.trim();
    if (inComment) {
      if (t.includes('*/')) inComment = false;
      continue;
    }
    if (/^#\s*if/.test(t)) {
      const v = configTrue(t);
      stack.push({ keep: v !== false, known: v !== null, cond: line });
      if (v === null && visible()) out.push(line);
      if (v === false) skipped = true;
      continue;
    }
    if (/^#\s*else/.test(t) && stack.length) {
      const f = stack.at(-1);
      if (f.known) { f.keep = !f.keep; skipped = true; continue; }
    }
    if (/^#\s*endif/.test(t) && stack.length) {
      const f = stack.pop();
      if (!f.known && visible()) out.push(line);
      continue;
    }
    if (!visible()) continue;
    if (/^\/\*/.test(t) || /^\*\s/.test(t) && false) {
      if (!t.includes('*/')) { inComment = true; commentStart = line.n; skipped = true; continue; }
      if (t.length > 50) { skipped = true; continue; }
    }
    if (skipped && out.length && !out.at(-1).gap) out.push({ gap: true });
    skipped = false;
    if (t === '' && (out.length === 0 || out.at(-1).t?.trim() === '' || out.at(-1).gap)) continue;
    out.push(line);
  }
  while (out.length && (out.at(-1).gap || out.at(-1).t.trim() === '')) out.pop();
  return out;
}

function expandTabs(line, size = 8) {
  let out = '';
  for (const c of line) out += c === '\t' ? ' '.repeat(size - (out.length % size)) : c;
  return out;
}

function extract(id, ref) {
  const text = fs.readFileSync(path.join(root, ref.file), 'utf8').split('\n');
  const from = text.findIndex(l => norm(l).includes(norm(ref.from)));
  if (from < 0) throw new Error(`${id}: from not found: ${ref.from}`);
  let to = -1;
  let seen = 0;
  for (let i = from; i < text.length; i++) {
    if (norm(text[i]).includes(norm(ref.to)) && ++seen === (ref.toNth || 1)) { to = i; break; }
  }
  if (to < 0) throw new Error(`${id}: to not found: ${ref.to}`);
  const lines = text.slice(from, to + 1).map((t, i) => ({ n: from + i + 1, t: expandTabs(t).replace(/\s+$/, '') }));
  const shown = collapse(lines);
  const indent = Math.min(...shown.filter(l => !l.gap && l.t.trim()).map(l => l.t.match(/^ */)[0].length));
  return {
    file: ref.file.replace(/^src\/linux-6\.12\.112\//, 'linux/').replace(/^artifacts\/build\/qemu-source\/roms\//, '').replace(/^artifacts\/build\//, ''),
    lang: ref.lang,
    lines: shown.map(l => (l.gap ? { gap: true } : { n: l.n, t: l.t.slice(indent) })),
  };
}

const CODE = {};
for (const [id, ref] of Object.entries(CODE_REFS)) CODE[id] = extract(id, ref);

const ops = ACTS.flatMap(act => act.ops.map(op => ({ ...op, act: act.id })));
const errors = [];
ops.forEach((op, i) => {
  if (!op.code) return;
  const code = CODE[op.code];
  if (!code) { errors.push(`op ${i}: unknown code ${op.code}`); return; }
  if (op.line && !code.lines.some(l => !l.gap && norm(l.t).includes(norm(op.line)))) errors.push(`op ${i} (${op.act}): line not in ${op.code}: ${op.line}`);
});
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }

fs.writeFileSync(path.join(outDir, 'story-code.js'),
  `// 由 scripts/build-boot-story.mjs 生成，请勿手改。\nexport const CODE = ${JSON.stringify(CODE, null, 1)};\n`);

export function speakable(text) {
  return text
    .replace(/0x([0-9A-Fa-f]+)/g, (_, h) => h.toUpperCase())
    .replace(/→/g, '到').replace(/……/g, '等等').replace(/[“”]/g, '');
}
const tts = ops.map(op => {
  const text = speakable(op.tts || op.say);
  return { key: crypto.createHash('sha1').update(`${VOICE}|${text}`).digest('hex').slice(0, 16), text };
});
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
fs.writeFileSync(path.join(root, 'tmp/boot-story-tts.json'), JSON.stringify({ voice: VOICE, items: tts }, null, 1));

const manifestPath = path.join(outDir, 'audio/manifest.json');
let timing = null;
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const byKey = new Map(manifest.entries.map(e => [e.key, e]));
  timing = tts.map(t => byKey.get(t.key)).map(e => (e ? { file: e.file, audio: e.duration } : null));
}
fs.writeFileSync(path.join(outDir, 'story-timing.js'),
  `// 由 scripts/build-boot-story.mjs 生成，请勿手改。\nexport const TIMING = ${JSON.stringify(timing)};\n`);

const missing = timing ? timing.filter(t => !t).length : ops.length;
console.log(`[boot-story] ${ACTS.length} acts, ${ops.length} ops, ${Object.keys(CODE).length} code snippets; audio missing for ${missing}`);
