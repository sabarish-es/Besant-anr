import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const student = readFileSync(new URL('../frontend/src/components/student-qr-card.tsx', import.meta.url), 'utf8');
const trainer = readFileSync(new URL('../frontend/src/components/trainer-qr-scanner.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../frontend/src/styles.css', import.meta.url), 'utf8');

assert.match(student, /export function StudentQRCard\(/);
assert.doesNotMatch(student, /download\s*=|Download QR|<Download/);
assert.match(student, /onContextMenu=\{/);
assert.match(student, /onDragStart=\{/);
assert.match(student, /visibilitychange/);
assert.match(student, /pageActive/);
assert.match(student, /qr-student-name/);
assert.match(css, /@media print\s*\{[\s\S]*?\.student-qr-card \.personal-qr-frame img[\s\S]*?display:\s*none\s*!important/);
assert.match(trainer, /getUserMedia/);
assert.doesNotMatch(trainer, /type="file"|Scan QR image|readImage\(/);
console.log('PASS QR download action removed');
console.log('PASS QR context menu, drag, and inactive-tab deterrents present');
console.log('PASS QR hidden from printed page');
console.log('PASS Trainer scanner accepts live camera only');
