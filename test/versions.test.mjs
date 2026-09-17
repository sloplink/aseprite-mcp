// Version rules:
// - server.mjs, package.json, package-lock.json and CHANGELOG.md carry the release version
// - the extension has its own version (extension/package.json = EXTENSION_VERSION) and is
//   only bumped when its code changes
// - the extension in this repository must satisfy the API level the server requires
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");
const num = (v) => v.split(".").map(Number);
const cmp = (a, b) => {
  const [x, y] = [num(a), num(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

test("server and package versions match", () => {
  const pkg = JSON.parse(read("package.json")).version;
  const lock = JSON.parse(read("package-lock.json")).version;
  const server = read("server.mjs").match(/const VERSION = "([^"]+)"/)[1];
  assert.deepEqual({ lock, server }, { lock: pkg, server: pkg });
  assert.match(read("CHANGELOG.md"), new RegExp(`^## ${pkg.replace(/\./g, "\\.")}\\b`, "m"), "CHANGELOG entry");
});

test("extension version and API level are consistent", () => {
  const pkg = JSON.parse(read("package.json")).version;
  const ext = JSON.parse(read("extension/package.json")).version;
  const handlers = read("extension/handlers.lua");
  const lua = handlers.match(/local EXTENSION_VERSION = "([^"]+)"/)[1];
  const api = Number(handlers.match(/local API_LEVEL = (\d+)/)[1]);
  const required = Number(read("server.mjs").match(/const REQUIRED_API = (\d+)/)[1]);
  assert.equal(lua, ext, "extension/package.json and EXTENSION_VERSION");
  assert.ok(cmp(ext, pkg) <= 0, `extension ${ext} must not be newer than the release ${pkg}`);
  assert.ok(api >= required, `extension API level ${api} < server REQUIRED_API ${required}`);
});
