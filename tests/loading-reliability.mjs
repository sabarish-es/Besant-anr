import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the real frontend API client without needing a browser or D1.
const source = readFileSync(new URL('../frontend/src/lib/api.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { apiFetch, apiPost, readApiJson, apiErrorMessage } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
let checks = 0;
async function check(name, fn) { await fn(); ++checks; console.log('PASS ' + name); }

await check('Loading works with a valid server JSON response', async () => {
  globalThis.fetch = async () => Response.json({ ok: true });
  const value = await readApiJson(await apiFetch('/api/session'));
  assert.equal(value.ok, true);
});
await check('An HTML error response produces a readable loading error', async () => {
  await assert.rejects(() => readApiJson(new Response('<html>Gateway error</html>', { status: 503 })), /unavailable.*503/);
});
await check('Structured API errors become plain text, never a React object', () => {
  assert.equal(apiErrorMessage({ error: { message: 'Database busy' } }), 'Database busy');
  assert.equal(apiErrorMessage({ error: 'Try again' }), 'Try again');
  assert.equal(apiErrorMessage({ error: {} }), 'Unable to complete your request.');
});
await check('A failed save shows the actual server error', async () => {
  globalThis.fetch = async () => Response.json({ error: 'Missing field' }, { status: 400 });
  await assert.rejects(() => apiPost('/api/hub', { op: 'create' }), /Missing field/);
});
await check('Stalled loading requests time out instead of spinning forever', async () => {
  const timer = globalThis.setTimeout;
  globalThis.setTimeout = ((callback, ms) => timer(callback, ms >= 30000 ? 0 : ms));
  globalThis.fetch = async (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  try { await assert.rejects(() => apiFetch('/api/session'), /took too long/); }
  finally { globalThis.setTimeout = timer; }
});
await check('Stalled response bodies fail instead of freezing the loading screen', async () => {
  const timer = globalThis.setTimeout;
  globalThis.setTimeout = ((callback, ms) => timer(callback, ms >= 30000 ? 0 : ms));
  try {
    await assert.rejects(() => readApiJson({ text: () => new Promise(() => {}), ok: true }), /response took too long/);
  } finally { globalThis.setTimeout = timer; }
});
await check('Token refresh retries an unauthorized dashboard request once', async () => {
  const calls = [];
  globalThis.fetch = async (path) => {
    calls.push(path);
    if (path === '/api/auth/refresh') return Response.json({ ok: true });
    return calls.filter(p => p === '/api/hub').length === 1 ? Response.json({ error: 'Expired' }, { status: 401 }) : Response.json({ data: { ok: true } });
  };
  const result = await apiFetch('/api/hub');
  assert.equal(result.status, 200);
  assert.deepEqual(calls, ['/api/hub', '/api/auth/refresh', '/api/hub']);
});
await check('Caller cancellation stays a cancellation rather than a server error', async () => {
  globalThis.fetch = async (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const controller = new AbortController();
  const request = apiFetch('/api/attendance', { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => request, /abort/i);
});
console.log(`${checks} frontend loading checks passed`);
