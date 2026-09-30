/**
 * 性能测量台：逐档测帧时间，并核对自动降档是否按预期工作。
 *
 * 静态截图看不出性能问题——要靠这个把"卡"拆成具体的毫秒数，
 * 才知道该砍谁、砍到什么程度。
 *
 * 用法：
 *   node tools/perf.mjs            # 跑默认档位矩阵
 *   W=1920 H=1080 DPR=2 node tools/perf.mjs
 */

import puppeteer from 'puppeteer-core';
import { resolveBrowserPath } from './_browser.mjs';

const CHROME = resolveBrowserPath();
const URL = process.env.PIANO_URL || 'http://127.0.0.1:8137/';
const W = Number(process.env.W || 1600);
const H = Number(process.env.H || 1000);
const DPR = Number(process.env.DPR || 1);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', `--window-size=${W},${H}`],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: DPR });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(
  () => document.getElementById('loading')?.classList.contains('done'),
  { timeout: 180000, polling: 400 },
);

const gpu = await page.evaluate(() => {
  const gl = window.__piano().renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '(未知)',
    buf: [gl.drawingBufferWidth, gl.drawingBufferHeight],
  };
});
console.log(`GPU : ${gpu.renderer}`);
console.log(`视口: ${W}×${H} @${DPR}x   渲染缓冲: ${gpu.buf.join('×')}\n`);

async function measure(label, samples = 90) {
  const r = await page.evaluate(async (n) => {
    const t = [];
    await new Promise((res) => {
      let i = 0;
      const tick = () => {
        const a = performance.now();
        requestAnimationFrame(() => {
          const b = performance.now();
          i++;
          if (i > 12) t.push(b - a);        // 丢掉前 12 帧，避开编译与首帧抖动
          if (i < n) tick(); else res();
        });
      };
      tick();
    });
    t.sort((x, y) => x - y);
    return {
      median: t[Math.floor(t.length / 2)],
      p95: t[Math.floor(t.length * 0.95)],
      max: t[t.length - 1],
    };
  }, samples);
  console.log(
    `${label.padEnd(20)} 中位 ${r.median.toFixed(1).padStart(6)} ms`
    + `  ${(1000 / r.median).toFixed(0).padStart(4)} fps`
    + `   p95 ${r.p95.toFixed(1).padStart(6)} ms`,
  );
  return r.median;
}

// 关掉自动降档，才能逐档测出各自真实开销
await page.evaluate(() => { window.__piano().setTier('high'); });

for (const tier of ['high', 'medium', 'low']) {
  await page.evaluate((t) => window.__piano().setTier(t), tier);
  await new Promise((r) => setTimeout(r, 700));
  await measure(`档位 ${tier}`);
}

// 再验一遍自动档：恢复默认后跑一会儿，看它自己落到哪一档
await page.evaluate(() => {
  const p = window.__piano();
  p.stats().changes;             // 只读
});
console.log('\n自动降档验证：重载页面后观察 12 秒');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => document.getElementById('loading')?.classList.contains('done'),
  { timeout: 180000, polling: 400 },
);
await new Promise((r) => setTimeout(r, 12000));
const auto = await page.evaluate(() => window.__piano().stats());
console.log(`  最终档位 ${auto.tier}，中位帧 ${auto.medianMs.toFixed(1)} ms`
  + ` ≈ ${(1000 / auto.medianMs).toFixed(0)} fps（自动调整 ${auto.changes} 次）`);

await browser.close();
