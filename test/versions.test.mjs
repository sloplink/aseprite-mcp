// Version rules:
// - server.mjs, package.json, package-lock.json and CHANGELOG.md carry the release version
// - the extension has its own version (extension/package.json = EXTENSION_VERSION) and is
//   only bumped when its code changes
// - the extension in this repository must be at least the server's MIN_EXTENSION
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

test("extension version fits the server", () => {
  const pkg = JSON.parse(read("package.json")).version;
  const ext = JSON.parse(read("extension/package.json")).version;
  const lua = read("extension/handlers.lua").match(/local EXTENSION_VERSION = "([^"]+)"/)[1];
  const min = read("server.mjs").match(/const MIN_EXTENSION = "([^"]+)"/)[1];
  assert.equal(lua, ext, "extension/package.json and EXTENSION_VERSION");
  assert.ok(cmp(ext, pkg) <= 0, `extension ${ext} must not be newer than the release ${pkg}`);
  assert.ok(cmp(ext, min) >= 0, `extension ${ext} is older than the server's MIN_EXTENSION ${min}`);
});
