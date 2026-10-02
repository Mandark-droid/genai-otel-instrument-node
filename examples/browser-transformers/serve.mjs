/**
 * A static file server for the example, nothing more.
 *
 *   npm run serve            # http://localhost:8080
 *   PORT=9000 npm run serve
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
/** @type {Record<string, string>} */
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};
const port = Number(process.env.PORT ?? 8080);

createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  const file = normalize(join(root, pathname === '/' ? 'index.html' : pathname));
  // Nothing outside this directory is served.
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
}).listen(port, () => console.log('http://localhost:' + port));
