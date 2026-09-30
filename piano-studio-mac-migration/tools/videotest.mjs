/**
 * 瀑布流视频导出实测（端到端，真下载真校验）。
 *
 *   1. 录一小段（和弦 + 旋律 + 延音踏板）；
 *   2. 点面板上的「导出瀑布流视频」按钮，走用户真会走的那条路径；
 *   3. 导三遍：补偿关 / 补偿 0.3s（从 3D 视图点，顺带验自动切视图）/ 中途取消；
 *   4. 若安装了 ffprobe/ffmpeg，量这三件事：
 *        · 有视频轨 + 有音频轨，且音轨非静音（原声真的在里面）；
 *        · **音画对齐**：键盘条亮度起跳时刻（画面按键）vs 声音起点。
 *          补偿关时两者应当对齐；补偿 0.3s 时画面应当正好晚 0.3s，
 *          而声音时间轴一动不动；
 *        · 画面在动（逐帧亮度有起伏，不是一张空背景）。
 *   5. 取消导出不留文件、状态复位。
 *
 * 用法： node tools/videotest.mjs      （需先 npm start；ffprobe/ffmpeg 用于附加文件分析）
 *        KEEP=1 保留导出文件，否则跑完删掉
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { resolveBrowserPath } from './_browser.mjs';

const CHROME = resolveBrowserPath();
const URL = process.env.PIANO_URL || 'http://127.0.0.1:8137/';
const OUT = process.env.OUT_DIR || 'shots/video';
const VIEW_W = 1600;
const VIEW_H = 1000;
mkdirSync(OUT, { recursive: true });

const FFPROBE = process.env.FFPROBE || 'ffprobe';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const hasMediaTools = [FFPROBE, FFMPEG].every((bin) => {
  const result = spawnSync(bin, ['-version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
});
if (!hasMediaTools) {
  console.log('未找到 ffprobe/ffmpeg；继续验证浏览器录制、下载、取消和界面状态，跳过文件内容分析。');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${msg}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ── 录制一段：和弦 + 上行旋律 + 踏板 ── */
const TAKE_MS = 4200;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required', `--window-size=${VIEW_W},${VIEW_H}`,
    '--use-fake-ui-for-media-stream'],
});
const page = await browser.newPage();
await page.setViewport({ width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1 });
page.on('console', (m) => {
  if (m.type() === 'error' || /\[video\]|\[recorder\]/.test(m.text())) {
    console.log('[页面]', m.text());
  }
});

/* 下载落到 shots/video/，好直接拿来校验 */
const cdp = await page.target().createCDPSession();
await cdp.send('Browser.setDownloadBehavior', {
  behavior: 'allow', downloadPath: path.resolve(OUT), eventsEnabled: true,
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => document.getElementById('loading')?.classList.contains('done'),
  { timeout: 120000, polling: 400 },
);
await page.click('body');                     // 解锁音频上下文
await sleep(600);

const before = new Set(readdirSync(OUT));

/* ── 1) 录一段 ── */
await page.evaluate(() => window.__piano().setWfMode(true));
await sleep(300);
// 键盘几何从页面取（键床高度由键形比例算出来，别在测试里另写一份硬编码）
const geo = await page.evaluate(() => window.__piano().wf.metrics);
await page.evaluate(() => {
  const P = window.__piano();
  P.recorder.start();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const keys = new Set();
  const noteOn = (m) => { keys.add(m); P.interaction.playNote(m, 0.78); };
  const noteOff = (m) => { keys.delete(m); P.interaction.silenceNote(m); };
  const SCORE = [
    { at: 0, on: [48, 60, 64, 67], off: 900 },
    { at: 1000, on: [62], off: 1400 },
    { at: 1500, on: [65], off: 1900 },
    { at: 2000, on: [69], off: 2600 },
    { at: 2700, on: [72, 76, 79], off: 3600 },
  ];
  return (async () => {
    const t0 = performance.now();
    P.interaction.setSustain(true);           // 全程踩住延音，光条能连成瀑布
    const pending = SCORE.flatMap((g) => [
      sleep(Math.max(0, g.at - (performance.now() - t0))).then(() => g.on.forEach(noteOn)),
      sleep(Math.max(0, g.off - (performance.now() - t0))).then(() => g.on.forEach(noteOff)),
    ]);
    await Promise.all(pending);
    for (const m of keys) noteOff(m);
    P.interaction.setSustain(false);
  })();
});

const rec = await page.evaluate(() => {
  const P = window.__piano();
  P.recorder.stop();
  return {
    take: P.recorder.hasTake,
    notes: P.recorder.events.filter((e) => e.type === 'on').length,
    duration: Math.round(P.recorder.events.at(-1)?.t ?? 0),
    stat: P.recorder.statText,
  };
});
ok(rec.take && rec.notes >= 9, '录到事件流', `${rec.notes} 个音 · 末尾事件 ${rec.duration} ms`);

/* ── 2) 按钮与对齐控件就位 ── */
const ui = await page.evaluate(() => {
  const b = document.getElementById('dlVideo');
  const s = document.getElementById('avOff');
  return {
    disabled: b.disabled, text: b.textContent, videoOK: window.__piano().exporter.videoOK,
    offsetDefault: s.value, offsetOpts: [...s.options].map((o) => o.value),
    offsetStat: document.getElementById('avOffStat').textContent,
  };
});
ok(ui.videoOK, '浏览器支持视频导出（MediaRecorder + captureStream）');
ok(!ui.disabled, '有录制内容时导出按钮可用', `按钮文案：${ui.text}`);
ok(ui.offsetOpts.includes('300') && ui.offsetDefault === '300',
  '音画对齐默认 0.3 秒、可调到 0', `选项 ${ui.offsetOpts.join('/')}`);
console.log(`   ${ui.offsetStat}`);

/* ── 3) 导出 A：补偿关（文件本身的音画基准） ── */
await sleep(4000);          // 等上一条录音的余音/混响尾巴散尽，否则会被算进视频开头
await page.select('#avOff', '0');
const storedA = await page.evaluate(() => localStorage.getItem('piano.avOffset'));
ok(storedA === '0', '对齐值记进 localStorage');
const A = await exportOnce('补偿关');
ok(A.count === 1 && A.file, '导出一个文件', A.file ? path.basename(A.file) : '没有新文件');
ok(A.mid.exporting && A.mid.wfMode, '点下去即进入导出中且画面切到瀑布流');
ok(A.mid.btn.includes('取消'), '导出中按钮变成取消', A.mid.btn);
ok(A.mid.offsetDisabled, '导出中锁定对齐控件', String(A.mid.offsetDisabled));
console.log(`   状态行：${A.mid.stat}`);
ok(A.wall > TAKE_MS, '实时录制耗时符合预期', `${(A.wall / 1000).toFixed(1)}s（演奏 ${(TAKE_MS / 1000).toFixed(1)}s）`);
ok(A.after.hasVideo && A.after.size > 50000 && !A.after.playing,
  '导出产出视频并停下回放', `${(A.after.size / 1048576).toFixed(2)} MB · ${A.after.type}`);

/* ── 4) 导出 B：补偿 0.3s，且从 3D 视图点（验自动切视图 + 自动切回） ── */
await page.select('#avOff', '300');
await page.evaluate(() => window.__piano().setWfMode(false));
await sleep(200);
const B = await exportOnce('补偿0.3s');
ok(B.count === 1 && B.file, '补偿 0.3s 再导一份', B.file ? path.basename(B.file) : '没有新文件');
ok(B.mid.wfMode, '从 3D 视图导出会自动切到瀑布流视图');
ok(!B.after.wfMode && B.after.hasVideo, '导出结束后自动切回 3D 视图');

/* ── 5) 量音画对齐 ── */
if (hasMediaTools && A.file && B.file) {
  const a = measureAV(A.file);
  const b = measureAV(B.file);
  console.log(`   补偿关  ：画面按键 ${a.visualOnset?.toFixed(3)}s · 声音起点 ${a.audioOnset?.toFixed(3)}s · 偏移 ${a.delta?.toFixed(3)}s`);
  console.log(`   补偿0.3s：画面按键 ${b.visualOnset?.toFixed(3)}s · 声音起点 ${b.audioOnset?.toFixed(3)}s · 偏移 ${b.delta?.toFixed(3)}s`);
  ok(a.delta !== null && Math.abs(a.delta) <= 0.12,
    '不补偿时文件本身音画就是对齐的', `偏移 ${a.delta?.toFixed(3)}s`);
  ok(b.delta !== null && Math.abs(b.delta - (-0.3)) <= 0.15,
    '补偿 0.3s 后画面确实比声音晚 0.3s', `偏移 ${b.delta?.toFixed(3)}s`);
  ok(Math.abs(b.audioOnset - a.audioOnset) <= 0.1,
    '补偿只动画面，声音时间轴不变',
    `${a.audioOnset?.toFixed(3)}s → ${b.audioOnset?.toFixed(3)}s`);
  ok(Math.abs((b.visualOnset - a.visualOnset) - 0.3) <= 0.15,
    '画面起点整体后移了 0.3s',
    `${a.visualOnset?.toFixed(3)}s → ${b.visualOnset?.toFixed(3)}s`);
}

/* ── 6) 中途取消：不留文件、状态复位 ── */
const nBeforeCancel = readdirSync(OUT).length;
await page.click('#dlVideo');
await sleep(1500);
const cancelLabel = await page.$eval('#dlVideo', (b) => b.textContent);
await page.click('#dlVideo');                          // 同一个按钮变取消
await page.waitForFunction(() => !window.__piano().exporter.busy, { timeout: 20000, polling: 150 });
await sleep(1500);
const afterCancel = await page.evaluate(() => ({
  wf: window.__piano().wfMode,
  btn: document.getElementById('dlVideo').textContent,
  offDisabled: document.getElementById('avOff').disabled,
}));
ok(cancelLabel.includes('取消') && readdirSync(OUT).length === nBeforeCancel,
  '取消后不产出文件', `点前 ${nBeforeCancel} 个 · 点后 ${readdirSync(OUT).length} 个`);
ok(!afterCancel.wf && /含原声/.test(afterCancel.btn) && !afterCancel.offDisabled,
  '取消后视图、按钮、对齐控件都复位', afterCancel.btn);

/* ── 7) 文件内容校验（拿 A 那份） ── */
if (hasMediaTools && A.file && statSync(A.file).size > 50000) {
  const probe = JSON.parse(execFileSync(FFPROBE, [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', A.file,
  ], { encoding: 'utf8', maxBuffer: 1 << 24 }));
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const au = probe.streams.find((s) => s.codec_type === 'audio');
  ok(!!v, '视频轨存在', v ? `${v.codec_name} ${v.width}×${v.height} @${Math.round(Number(v.r_frame_rate.split('/')[0]) / Number(v.r_frame_rate.split('/')[1] || 1))}fps` : '');
  ok(!!au, '音频轨存在（原声进视频了）', au ? `${au.codec_name} ${au.channels}ch ${au.sample_rate}Hz` : '');
  const dur = Number(probe.format?.duration ?? 0);
  ok(dur > TAKE_MS / 1000 && dur < 40, '时长包含前奏与尾巴', `${dur.toFixed(1)}s`);

  const vol = spawnSync(FFMPEG, ['-hide_banner', '-i', A.file, '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 1 << 24 });
  const vlog = (vol.stderr ?? '') + (vol.stdout ?? '');
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(vlog)?.[1];
  const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(vlog)?.[1];
  ok(Number(mean) > -70 && Number(peak) > -30, '音轨有实际琴声（非静音）',
    `平均 ${mean} dB · 峰值 ${peak} dB`);

  const stats = execFileSync(FFPROBE, ['-v', 'error', '-f', 'lavfi',
    '-i', `movie=${A.file.replace(/\\/g, '/')},signalstats`,
    '-show_entries', 'frame_tags=lavfi.signalstats.YAVG', '-of', 'csv=p=0'],
    { encoding: 'utf8', maxBuffer: 1 << 26 })
    .trim().split('\n').map(Number).filter((n) => Number.isFinite(n));
  const spread = stats.length ? Math.max(...stats) - Math.min(...stats) : 0;
  ok(stats.length > 30 && spread > 1.5, '画面确实在动（逐帧亮度有起伏）',
    `${stats.length} 帧 · 亮度跨度 ${spread.toFixed(1)}`);
}

/* ── 收尾 ── */
const all = readdirSync(OUT).filter((f) => !before.has(f)).map((f) => path.join(OUT, f));
if (process.env.KEEP) console.log(`   保留：${all.map((f) => path.basename(f)).join('、')}`);
else {
  for (const f of all) unlinkSync(f);
  console.log(`   已清理 ${all.length} 个导出文件（KEEP=1 可保留）`);
}

await browser.close();
console.log(failures ? `\n=== 失败 ${failures} 项 ===` : '\n=== 全部通过 ===');
process.exit(failures ? 1 : 0);

/* ══ 辅助 ═══════════════════════════════════════════════════ */

/** 点一次导出按钮，等收尾与落盘，返回下载到的文件与各处状态 */
async function exportOnce(tag) {
  const had = new Set(readdirSync(OUT));
  const t0 = Date.now();
  await page.click('#dlVideo');
  await sleep(500);
  const mid = await page.evaluate(() => {
    const P = window.__piano();
    return {
      exporting: P.exporter.exporting, wfMode: P.wfMode, playing: P.recorder.playing,
      btn: document.getElementById('dlVideo').textContent,
      stat: document.getElementById('recStat').textContent,
      offsetDisabled: document.getElementById('avOff').disabled,
    };
  });
  await page.waitForFunction(() => !window.__piano().exporter.busy, { timeout: 60000, polling: 200 });
  const wall = Date.now() - t0;
  await sleep(1500);                                  // 等浏览器把 blob 落盘
  const after = await page.evaluate(() => {
    const P = window.__piano();
    return {
      hasVideo: P.exporter.state.hasVideo, size: P.exporter.lastBlob?.size ?? 0,
      type: P.exporter.lastBlob?.type ?? null, wfMode: P.wfMode,
      playing: P.recorder.playing,
      stat: document.getElementById('recStat').textContent,
    };
  });
  const news = readdirSync(OUT).filter((f) => !had.has(f)).sort();   // 文件名带时间戳，字典序即时间序
  return { tag, mid, after, wall, count: news.length, file: news.length ? path.join(OUT, news.at(-1)) : null };
}

/**
 * 量一份导出文件的音画偏移。
 *   画面：底部键盘条的饱和度跳变——白键是米色（几乎无饱和度），按下变青，
 *         这个跳变就是"虚拟键盘按下"的时刻，比亮度钝指标干净得多。
 *   声音：10 ms 一块的 RMS 包络，取"连续 3 块越过噪声底 +25 dB"的时刻——
 *         比 silencedetect 稳，编码器启动的轻响噪点骗不过连续判定。
 *         前 0.5 s 不参与判定：那是前奏，还可能有上一遍的余音没散。
 */
function measureAV(file) {
  const filter = `movie=${file.replace(/\\/g, '/')},crop=${VIEW_W}:${Math.round(geo.kbH - 2)}:0:${Math.round(geo.kbTop + 2)},signalstats`;
  const out = execFileSync(FFPROBE, ['-v', 'error', '-f', 'lavfi', '-i', filter,
    '-show_entries', 'frame=best_effort_timestamp_time:frame_tags=lavfi.signalstats.SATAVG',
    '-of', 'json'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const frames = JSON.parse(out).frames
    .map((f) => [Number(f.best_effort_timestamp_time), Number(f.tags['lavfi.signalstats.SATAVG'])]);
  const early = frames.filter(([t]) => t < 0.5).map(([, s]) => s).sort((x, y) => x - y);
  const base = early[Math.floor(early.length / 2)];
  const hit = frames.find(([, s]) => s > base + 1.5);

  const visualOnset = hit ? hit[0] : null;
  const audioOnset = audioOnsetOf(file);
  return { visualOnset, audioOnset, base, delta: visualOnset != null && audioOnset != null ? audioOnset - visualOnset : null };
}

/** 声音起点：10 ms RMS 包络 + 连续越限判定（毫秒级精度足够比对 0.3 s 的补偿） */
function audioOnsetOf(file, { skipSec = 0.5, blockMs = 10, sr = 8000 } = {}) {
  const raw = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(sr), '-f', 's16le', '-'],
    { maxBuffer: 1 << 26 }).stdout;
  const n = Math.floor(raw.length / 2);
  const bs = Math.round((sr * blockMs) / 1000);
  const db = [];
  for (let i = 0; i + bs <= n; i += bs) {
    let sum = 0;
    for (let j = i; j < i + bs; j++) {
      const v = raw.readInt16LE(j * 2) / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / bs);
    db.push(rms > 0 ? 20 * Math.log10(rms) : -120);
  }
  if (!db.length) return null;
  const floor = [...db].sort((a, b) => a - b)[Math.floor(db.length * 0.1)];
  const thr = Math.max(floor + 25, Math.max(...db) - 30);
  for (let i = Math.floor((skipSec * 1000) / blockMs); i < db.length - 2; i++) {
    if (db[i] > thr && db[i + 1] > thr && db[i + 2] > thr) return (i * blockMs) / 1000;
  }
  return null;
}
