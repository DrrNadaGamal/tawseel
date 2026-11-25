// Local dev server: serves /public and runs the same API handler Vercel runs (in-memory store).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { handle } from './lib/service.js';
import { MemoryStore } from './lib/store.js';

const store = new MemoryStore();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    let raw = ''; for await (const c of req) raw += c;
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch {}
    const r = await handle({ method: req.method, path: url.pathname.slice(5), body, headers: req.headers, ip: req.socket.remoteAddress, store });
    res.writeHead(r.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify(r.json));
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  try { const data = await readFile(join('public', p)); res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404); res.end('not found'); }
}).listen(process.env.PORT || 4173, () => console.log('http://localhost:' + (process.env.PORT || 4173)));
