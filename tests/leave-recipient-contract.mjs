import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A regression guard for a production bug: the backend required the leave
// recipient, but the frontend field schema omitted it and silently hid the UI.
const backend = readFileSync(new URL('../lib/hub-types.ts', import.meta.url), 'utf8');
const frontend = readFileSync(new URL('../frontend/src/lib/hub-types.ts', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../frontend/src/pages/hub.tsx', import.meta.url), 'utf8');
for (const [name, source] of [['backend', backend], ['frontend', frontend]]) {
  const leaveDefinition = source.match(/^\s*leaves:\s*\{[^\n]*$/m)?.[0];
  assert.ok(leaveDefinition, `${name} leave definition must exist`);
  assert.match(leaveDefinition, /key:\s*'recipientId',\s*label:\s*'Send to',\s*required:\s*true/, `${name} must require recipientId`);
}
assert.match(editor, /next\.recipientIds\s*=\s*data\.me\.role/, 'new leave requests should have a visible recipient selection');
assert.match(editor, /editor\?\.kind\s*===\s*'leaves'\s*&&\s*f\.key\s*===\s*'recipientId'/,
  'leave form must render its recipient field');
assert.match(editor, /<legend>Send to/, 'leave form must render multi-select recipients');
assert.match(editor, /recipientIds: updated/, 'leave form must update the full selection');
console.log('PASS frontend and backend both require and render leave recipient');
