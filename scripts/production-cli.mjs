import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const database = config.d1_databases?.find(item => item.binding === 'DB');
if (!database || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(database.database_id) || database.database_id.startsWith('00000000')) {
  throw new Error('Create a real D1 database and copy its database_id into wrangler.jsonc before a production command.');
}
function run(args, capture = false) {
  const result = spawnSync(process.execPath, [wrangler, ...args, '--config', 'wrangler.jsonc'], {
    cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(capture ? 'Cloudflare command failed. Run wrangler login and check your account.' : 'Cloudflare command failed.');
  return result.stdout;
}
const [command] = process.argv.slice(2);
if (command === 'migrate') {
  run(['d1', 'migrations', 'apply', 'DB', '--remote']);
} else if (command === 'backup') {
  const directory = path.join(root, 'production-backups'); mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, 'studenthub-' + new Date().toISOString().replace(/[:.]/g, '-') + '.sql');
  run(['d1', 'export', 'DB', '--remote', '--output', filename]);
  console.log('Database backup saved to ' + filename);
} else if (command === 'deploy') {
  const required = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'ADMIN_EMAIL'];
  const secretsFile = path.join(root, '.secrets.production.json');
  if (existsSync(secretsFile)) {
    let secrets;
    try { secrets = JSON.parse(readFileSync(secretsFile, 'utf8')); }
    catch { throw new Error('.secrets.production.json must be valid JSON.'); }
    const missing = required.filter(name => typeof secrets[name] !== 'string' || !secrets[name].trim() || /REPLACE|your-project|owner@example/i.test(secrets[name]));
    if (missing.length) throw new Error('Replace the placeholders in .secrets.production.json: ' + missing.join(', '));
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(secrets.SUPABASE_URL)
      || !secrets.SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_')
      || !secrets.SUPABASE_SECRET_KEY.startsWith('sb_secret_')
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(secrets.ADMIN_EMAIL)) {
      throw new Error('Check the Supabase URL, new publishable/secret keys, and administrator email in .secrets.production.json.');
    }
  } else {
    const names = new Set(JSON.parse(run(['secret', 'list'], true)).map(item => item.name));
    const missing = required.filter(name => !names.has(name));
    if (missing.length) throw new Error('Create .secrets.production.json from its example and fill in: ' + missing.join(', '));
  }
  const build = spawnSync(process.execPath, ['scripts/run-project.mjs', 'build'], { cwd: root, stdio: 'inherit' });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error('Build failed. Deployment stopped.');
  run(existsSync(secretsFile) ? ['deploy', '--secrets-file', secretsFile] : ['deploy']);
} else throw new Error('Expected migrate, backup, or deploy.');
