/* 把 index.html + piano.js 打包发布到 vibedrop 线上站点。
 *
 *   node tools/deploy.mjs
 *
 * 带不带 SLUG 的区别（见隔壁 grand-piano/deploy.mjs 踩过的坑）：
 *   - POST /v1/sites 带 slug → 覆盖同一站点，链接稳定；
 *   - 不带 slug → 新建站点，返回新链接。
 * 首次部署用新建；以后更新同一站点时把返回的 slug 填进 SLUG 再跑。
 * 注意 PATCH /v1/sites/<slug> 返回 200 但会静默忽略 zip，不能用。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

// 线上站点 slug（覆盖旧 grand-piano 站点，链接保持稳定）；
// 置空则新建站点。注意 PATCH /v1/sites/<slug> 返回 200 但会静默忽略 zip，不能用。
const SLUG = process.env.VIBEDROP_SLUG || 't42knbdk';
const ROOT = path.resolve(import.meta.dirname, '..');
const ZIP = path.join(ROOT, 'site.zip');
const STAGE = path.join(ROOT, '.deploy');

/* 采样音源有 700 MB，只在本机用；线上的包就是两个文件 + 一个空清单桩。
   桩存在是为了让页面探测音源时不会打出一个 404（控制台干净），
   它声明"没有任何采样库"，页面就安静地用内置合成音源。 */
function stage() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(path.join(STAGE, 'samples'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(STAGE, 'index.html'));
  fs.copyFileSync(path.join(ROOT, 'piano.js'), path.join(STAGE, 'piano.js'));
  fs.writeFileSync(path.join(STAGE, 'samples', 'index.json'),
    JSON.stringify({ libraries: [] }));
  return STAGE;
}

const cfg = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), '.vibedrop', 'config.json'), 'utf8'),
);
const BASE = cfg.apiUrl.replace(/\/$/, '');

function makeZip() {
  fs.rmSync(ZIP, { force: true });
  execFileSync('zip', ['-q', '-r', ZIP, 'index.html', 'piano.js', 'samples'], { cwd: STAGE });
  if (!fs.existsSync(ZIP)) throw new Error('打包失败：没生成 site.zip');
}

const main = async () => {
  stage();
  makeZip();
  const buf = fs.readFileSync(ZIP);
  const fd = new FormData();
  fd.append('zip', new Blob([buf], { type: 'application/zip' }), 'site.zip');
  if (SLUG) fd.append('slug', SLUG);       // 带 slug 才是覆盖，不带是新建

  const r = await fetch(`${BASE}/v1/sites`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: fd,
  });
  const j = await r.json();
  if (!r.ok) {
    console.error('部署失败:', r.status, JSON.stringify(j));
    process.exit(1);
  }
  const s = j.site;
  console.log(`✓ 已发布  ${s.url}`);
  console.log(`  slug ${s.slug}   大小 ${s.sizeBytes} B   更新 ${s.updatedAt}   到期 ${s.expiresAt}`);
  if (!SLUG) {
    console.log(`  下次更新请用: VIBEDROP_SLUG=${s.slug} node tools/deploy.mjs`);
  }
  fs.rmSync(ZIP, { force: true });
  fs.rmSync(STAGE, { recursive: true, force: true });
};

main().catch((e) => { console.error(e); process.exit(1); });
