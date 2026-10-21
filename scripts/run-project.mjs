import { spawn } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const frontend = fileURLToPath(new URL('../frontend/', import.meta.url));
const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const [command] = process.argv.slice(2);
const envFile = new URL('../.env', import.meta.url);
const projectEnvFile = '/vercel/share/.env.project';
if (existsSync(envFile)) process.loadEnvFile(fileURLToPath(envFile));
if (existsSync(projectEnvFile)) process.loadEnvFile(projectEnvFile);
process.env.WRANGLER_SEND_METRICS ??= 'false';
if (!existsSync(vite) || !existsSync(wrangler)) { console.error('Install dependencies first: npx pnpm@11.25.0 install --frozen-lockfile'); process.exit(1); }
const children = new Set(); let stopping = false;
function start(script, args, cwd = root) {
  const child = spawn(process.execPath, [script, ...args], { cwd, stdio: 'inherit', env: process.env });
  children.add(child); child.once('exit', () => children.delete(child)); return child;
}
function stop(code = 0) {
  if (stopping) return; stopping = true; process.exitCode = code;
  for (const child of children) child.kill('SIGINT');
  const timeout = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 5000); timeout.unref();
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
async function run(script, args, cwd = root) {
  const child = start(script, args, cwd);
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))); });
  if (stopping) return;
  if (status !== 0) throw new Error('Command failed with exit code ' + status);
}
const apiArgs = ['dev', '--config', 'wrangler.local.jsonc', '--local', '--ip', '127.0.0.1', '--port', process.env.API_PORT || '8787', '--inspector-port', '0', '--persist-to', '.wrangler/state-production'];
for (const key of ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'ADMIN_EMAIL']) {
  if (process.env[key]) apiArgs.push('--var', `${key}:${process.env[key]}`);
}
async function check() { await run(tsc, ['--noEmit']); if (!stopping) await run(tsc, ['--noEmit', '-p', 'tsconfig.json'], frontend); }
async function buildFrontend() {
  await run(vite, ['build'], frontend);
  rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
  cpSync(new URL('../frontend/dist/', import.meta.url), new URL('../dist/', import.meta.url), { recursive: true });
}
async function build() { await check(); if (!stopping) await buildFrontend(); if (!stopping) await run(wrangler, ['deploy', '--dry-run', '--config', 'wrangler.local.jsonc', '--outdir', '.sites-runtime/worker-build']); }
try {
  if (command === 'typecheck') await check();
  else if (command === 'build') await build();
  else if (command === 'build:frontend') { await run(tsc, ['--noEmit', '-p', 'tsconfig.json'], frontend); if (!stopping) await run(vite, ['build'], frontend); }
  else if (command === 'build:api') await run(wrangler, ['deploy', '--dry-run', '--config', 'wrangler.local.jsonc', '--outdir', '.sites-runtime/worker-build']);
  else if (command === 'dev:frontend') await run(vite, [], frontend);
  else if (['dev', 'dev:api', 'preview'].includes(command)) {
    if (!existsSync(new URL('../frontend/dist/index.html', import.meta.url))) await run(vite, ['build'], frontend);
    if (!stopping) {
      const tasks = [start(wrangler, apiArgs)];
      if (command === 'dev') tasks.push(start(vite, [], frontend));
      console.log(command === 'dev' ? 'Starting React and API. Open http://127.0.0.1:5173. Press Ctrl+C to stop both.' : 'Serving the built React app and API on http://127.0.0.1:' + (process.env.API_PORT || '8787'));
      for (const child of tasks) { child.once('error', error => { console.error(error.message); stop(1); }); child.once('exit', code => { if (!stopping) stop(code || 1); }); }
    }
  } else throw new Error('Unknown project command.');
} catch (error) { console.error(error.message); stop(1); }
