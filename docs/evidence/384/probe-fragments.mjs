/** Research-only loopback capture. No deployed endpoint, real document or external request. */
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { URL, fileURLToPath } from 'node:url';
import process from 'node:process';

const targets = [];
const server = createServer((request, response) => {
  targets.push(request.url);
  response.end('synthetic capture only');
});
function read(url) {
  return new Promise((resolve, reject) => {
    const request = get(url, response => { response.resume(); response.once('end', resolve); });
    request.once('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('Loopback probe timed out')));
  });
}
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
try {
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const original = new URL('/embed.html#doc=SYNTHETIC_SENTINEL', origin);
  await read(original);
  const forwarded = new URL('/capture', origin);
  forwarded.searchParams.set('url', original.href);
  await read(forwarded);
  assert.equal(targets[0], '/embed.html');
  assert(!targets[0].includes('SYNTHETIC_SENTINEL'));
  assert(targets[1].includes('%23doc%3D'));
  assert.equal(new URL(targets[1], origin).searchParams.get('url'), original.href);
  process.stdout.write(JSON.stringify({
    script: fileURLToPath(import.meta.url).split('/').pop(),
    node: process.version,
    directRequestHasFragment: false,
    encodedQueryDisclosesFullOriginalURL: true,
    externalRequests: 0,
    scope: 'Node HTTP loopback only; not a Medium/Embedly behavior test',
  }, null, 2) + '\n');
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
