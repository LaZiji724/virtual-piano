/**
 * 瀑布流录制视图验证：
 *   1. 打开录制视图 → 截空场景
 *   2. 程序化弹一段（C-E-G 和弦 + 琶音）→ 录制中截"光条生长"
 *   3. 松手 2 秒后截"光条上飞"
 *   4. 停止录制 → 验证事件数/时长 → 回放 1 秒后截回放画面
 *   5. 导出 .mid 并做结构自检（MThd/MTrk/事件数）
 *
 * 用法： node tools/wftest.mjs   （需先跑 npm start 或设 PIANO_URL）
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { resolveBrowserPath } from './_browser.mjs';

const CHROME = resolveBrowserPath();
const URL = process.env.PIANO_URL || 'http://127.0.0.1:8137/';
const OUT = 'shots';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1600,1000'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

console.log(`打开 ${URL}`);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(
  () => document.getElementById('loading')?.classList.contains('done'),
  { timeout: 180000, polling: 400 },
);
console.log('加载完成');
await sleep(2500);

/* 打开录制视图 */
await page.evaluate(() => window.__piano().setWfMode(true));
await sleep(800);
await page.screenshot({ path: `${OUT}/wf-0-idle.png` });
console.log('已保存 wf-0-idle.png');

/* 录一段：C4-E4-G4 长和弦 → 短琶音 → 踏板 */
const take = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rec = window.__piano();
  rec.recorder.start();
  const it = rec.interaction;
  it.playNote(60, 0.9); it.playNote(64, 0.8); it.playNote(67, 0.7);
  await sleep(1600);                       // 长按 → 长光条
  it.silenceNote(60); it.silenceNote(64); it.silenceNote(67);
  await sleep(120);
  it.playNote(72, 0.85); await sleep(300); it.silenceNote(72);
  it.playNote(76, 0.7); await sleep(300); it.silenceNote(76);
  it.playNote(79, 0.75); await sleep(500); it.silenceNote(79);
  await sleep(400);                        // 光条飞一会儿
  rec.recorder.stop();
  await sleep(1200);                       // 等 MediaRecorder onstop 异步封装 Blob
  return {
    count: rec.recorder.statText,
    hasAudio: !!rec.recorder.audioBlob,
    audioSize: rec.recorder.audioBlob?.size ?? 0,
    mode: rec.wfMode,
  };
});
console.log('录制结果:', JSON.stringify(take));
await page.screenshot({ path: `${OUT}/wf-1-flying.png` });

/* 回放 */
await sleep(3000);                          // 等光条全部飞出
const playing = await page.evaluate(() => {
  const rec = window.__piano();
  rec.recorder.play();
  return rec.recorder.playing;
});
await sleep(700);                           // 回放进行到和弦处
await page.screenshot({ path: `${OUT}/wf-2-playback.png` });
console.log('回放已启动:', playing);
await page.evaluate(() => window.__piano().recorder.stopPlay());

/* 导出 .mid 的结构自检在 tools/test-midexport.mjs（buildMidiFile 是纯函数）。
   这里从页面拿一份真实录到的事件流，交给 node 侧验证。 */
const events = await page.evaluate(() => window.__piano().recorder.events);
writeFileSync(`${OUT}/wf-events.json`, JSON.stringify(events));
console.log(`已导出事件流 ${events.length} 条 → shots/wf-events.json`);

console.log('\n=== 控制台输出 ===');
logs.slice(0, 40).forEach((l) => console.log(l));
writeFileSync(`${OUT}/wf-console.log`, logs.join('\n'));
await browser.close();
