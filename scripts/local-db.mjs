import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

export function runD1(action, args = [], { capture = false } = {}) {
  if (!existsSync(wrangler)) throw new Error("Install dependencies first: npx pnpm@11.25.0 install --frozen-lockfile");
  mkdirSync(new URL("../.wrangler", import.meta.url), { recursive: true });
  const result = spawnSync(process.execPath, [wrangler, "d1", ...action, "DB", "--local", "--config", "wrangler.local.jsonc", "--persist-to", ".wrangler/state-production", ...args], {
    cwd: projectRoot,
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    encoding: "utf8",
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false", CLOUDFLARE_CF_FETCH_ENABLED: "false" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(capture ? (result.stderr || result.stdout || "Local database command failed.") : "Local database command failed.");
  return result.stdout || "";
}

export function localQuery(sql) {
  const output = runD1(["execute"], ["--command", sql, "--json"], { capture: true });
  const value = JSON.parse(output);
  return value[0]?.results || [];
}

export const sqlString = value => "'" + String(value).replaceAll("'", "''") + "'";
