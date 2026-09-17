// Runs test/aseprite-handlers.lua inside a real Aseprite in batch mode (no window).
// Set ASEPRITE=/path/to/aseprite if it is not found automatically; skipped otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.ASEPRITE,
  "aseprite",
  join(homedir(), ".local/share/Steam/steamapps/common/Aseprite/aseprite"),
  join(homedir(), ".steam/steam/steamapps/common/Aseprite/aseprite"),
  "/Applications/Aseprite.app/Contents/MacOS/aseprite",
  join(homedir(), "Library/Application Support/Steam/steamapps/common/Aseprite/Aseprite.app/Contents/MacOS/aseprite"),
  "C:\\Program Files\\Aseprite\\Aseprite.exe",
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Aseprite\\Aseprite.exe",
].filter(Boolean);

const works = (bin) =>
  (bin.includes("/") || bin.includes("\\") ? existsSync(bin) : true) &&
  spawnSync(bin, ["--version"], { timeout: 20000 }).status === 0;
const ASEPRITE = candidates.find(works);

test("extension handlers in a real Aseprite", { skip: ASEPRITE ? false : "Aseprite not found (set ASEPRITE)" }, () => {
  const r = spawnSync(
    ASEPRITE,
    ["-b", "--script-param", `ext=${join(root, "extension")}`, "--script", join(root, "test/aseprite-handlers.lua")],
    { encoding: "utf8", timeout: 120000 }
  );
  const out = `${r.stdout}${r.stderr}`;
  const fails = out.split("\n").filter((l) => l.startsWith("FAIL "));
  assert.deepEqual(fails, [], out);
  assert.match(out, /^DONE 0$/m, out);
  assert.ok(out.split("\n").filter((l) => l.startsWith("PASS ")).length >= 15, out);
});
