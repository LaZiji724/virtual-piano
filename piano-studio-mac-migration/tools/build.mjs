/**
 * 打包成单文件经典脚本。
 *
 * 浏览器在 file:// 下禁止加载 ES 模块（CORS），但**放行经典 <script src>**。
 * 所以把整个依赖图（含 three）打成 IIFE，index.html 就能双击直接打开，
 * 不需要任何本地服务器。
 *
 * 用法： node tools/build.mjs
 */
import { build } from 'esbuild';
import { statSync } from 'node:fs';

const t0 = Date.now();
await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  outfile: 'piano.js',
  minify: true,
  target: ['chrome100', 'firefox100', 'safari15'],
  legalComments: 'none',
  logLevel: 'warning',
});
const kb = (statSync('piano.js').size / 1024).toFixed(0);
console.log(`piano.js  ${kb} KB  (${Date.now() - t0} ms)`);
