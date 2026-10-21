import { copyFileSync, existsSync } from 'node:fs';
import { runD1 } from './local-db.mjs';
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Install Node.js 24 LTS or newer.');
const vars = new URL('../.dev.vars', import.meta.url);
if (!existsSync(vars)) { copyFileSync(new URL('../.dev.vars.example', import.meta.url), vars); console.log('Created .dev.vars. Fill in your Supabase keys and real administrator email.'); }
runD1(['migrations', 'apply']);
console.log('Schema applied. No institutes, users, branches, courses, or demo attendance were seeded.');
console.log('Complete .dev.vars, create the first Admin in Supabase Authentication, then run: npx pnpm@11.25.0 dev');
