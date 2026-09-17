// Server, npm package and extension must always ship with the same version.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");

test("all version numbers match", () => {
  const pkg = JSON.parse(read("package.json")).version;
  const lock = JSON.parse(read("package-lock.json")).version;
  const ext = JSON.parse(read("extension/package.json")).version;
  const server = read("server.mjs").match(/const VERSION = "([^"]+)"/)[1];
  const lua = read("extension/handlers.lua").match(/local EXTENSION_VERSION = "([^"]+)"/)[1];
  assert.deepEqual({ lock, ext, server, lua }, { lock: pkg, ext: pkg, server: pkg, lua: pkg });
  assert.match(read("CHANGELOG.md"), new RegExp(`^## ${pkg.replace(/\./g, "\\.")}\\b`, "m"), "CHANGELOG entry");
});
