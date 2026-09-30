import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8137);
const shouldOpen = process.argv.includes('--open');
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.m4a', 'audio/mp4'],
  ['.mid', 'audio/midi'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.wav', 'audio/wav'],
  ['.webm', 'video/webm'],
]);

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }

  const relative = pathname.replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(ROOT, relative);
  if (file !== ROOT && !file.startsWith(`${ROOT}${path.sep}`)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let target = file;
  try {
    if (statSync(target).isDirectory()) target = path.join(target, 'index.html');
    const info = statSync(target);
    if (!info.isFile()) throw new Error('Not a regular file');
    res.writeHead(200, {
      'Content-Type': mimeTypes.get(path.extname(target).toLowerCase()) || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404).end('Not Found');
  }
});

server.on('error', (error) => {
  console.error(`本地服务器启动失败：${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const url = `http://${displayHost}:${port}/`;
  console.log(`钢琴工作室已启动：${url}`);
  console.log('按 Control-C 停止服务器。');
  if (shouldOpen) {
    const opener = spawn('open', [url], { detached: true, stdio: 'ignore' });
    opener.on('error', (error) => console.error(`无法自动打开浏览器：${error.message}`));
    opener.unref();
  }
});
