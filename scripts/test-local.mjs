import ts from "typescript";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = path.join(root, ".sites-runtime", "checks");
for (const file of ["lib/hub-types.ts", "lib/google-review.ts", "lib/student-qr.ts", "lib/hub-service.ts", "tests/hub-smoke.ts", "tests/session-timing.ts", "server/types.ts", "server/auth.ts", "server/index.ts", "tests/production-api.ts"]) {
  const outputFile = path.join(outputRoot, file.replace(/\.ts$/, ".js"));
  mkdirSync(path.dirname(outputFile), { recursive: true });
  const source = readFileSync(path.join(root, file), "utf8").replace(/from (['"])(\.\.?\/[^'"]+)\1/g, (_, quote, name) => `from ${quote}${name}.js${quote}`);
  const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  writeFileSync(outputFile, result.outputText);
}
for (const test of ["hub-smoke.js", "production-api.js", "session-timing.js"]) {
  const result = spawnSync(process.execPath, [path.join(outputRoot, "tests", test)], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The frontend API loading tests run directly as ESM (no browser required).
const frontendResult = spawnSync(process.execPath, [path.join(root, "tests", "loading-reliability.mjs")], { cwd: root, stdio: "inherit" });
if (frontendResult.error) throw frontendResult.error;
if (frontendResult.status !== 0) process.exit(frontendResult.status ?? 1);

// Guard against the frontend/backend leave-form schema drifting apart.
const recipientCheck = spawnSync(process.execPath, [path.join(root, "tests", "leave-recipient-contract.mjs")], { cwd: root, stdio: "inherit" });
if (recipientCheck.error) throw recipientCheck.error;
if (recipientCheck.status !== 0) process.exit(recipientCheck.status ?? 1);
