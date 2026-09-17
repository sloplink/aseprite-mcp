#!/usr/bin/env node
// aseprite-mcp — lets an AI assistant (e.g. Claude) draw in a running Aseprite.
//
//   MCP client (Claude Code) <--stdio--> server.mjs <--WebSocket 127.0.0.1--> Aseprite (MCP Bridge extension)
//
// Usage:
//   aseprite-mcp               start the MCP server (normally launched by your MCP client)
//   aseprite-mcp token         print the pairing token (creates one if needed)
//   aseprite-mcp token --new   create a new token (the extension must be updated)
//
// stdout belongs to the MCP protocol – log only via console.error.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { readFile, writeFile, mkdir, unlink, chmod, rename, stat, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, dirname, isAbsolute, sep, delimiter } from "node:path";
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { deflateSync } from "node:zlib";

const VERSION = "0.6.0";
const PROTOCOL = 2;
// Oldest extension that has every command this server uses. Server-only releases keep it,
// so they work with the installed extension.
const MIN_EXTENSION = "0.4.0";
const PORT = Number(process.env.ASEPRITE_MCP_PORT ?? 9123);
const HOST = "127.0.0.1"; // local only, on purpose
const TIMEOUT_MS = Number(process.env.ASEPRITE_MCP_TIMEOUT ?? 15000);
const AUTH_TIMEOUT_MS = 5000;
const ALLOW_LUA = process.env.ASEPRITE_MCP_ALLOW_LUA === "1";
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "aseprite-mcp");
const TOKEN_FILE = process.env.ASEPRITE_MCP_TOKEN_FILE ?? join(CONFIG_DIR, "token");
const PALETTE_FILE = process.env.ASEPRITE_MCP_PALETTE_FILE ?? join(CONFIG_DIR, "palettes.json");
// Directories the `file` option may read from. Default: the system temp directory, plus /tmp on
// macOS/Linux (on macOS the temp directory is /var/folders/..., but tools often write to /tmp).
const DEFAULT_FILE_DIRS = [tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])].join(delimiter);
const FILE_DIRS = (process.env.ASEPRITE_MCP_FILE_DIRS ?? DEFAULT_FILE_DIRS).split(delimiter).filter(Boolean);

const log = (...a) => console.error("[aseprite-mcp]", ...a);

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------
async function loadToken({ create = true, renew = false } = {}) {
  if (process.env.ASEPRITE_MCP_TOKEN && !renew) return process.env.ASEPRITE_MCP_TOKEN.trim();
  if (!renew) {
    try {
      const t = (await readFile(TOKEN_FILE, "utf8")).trim();
      if (t.length >= 16) return t;
    } catch {}
  }
  if (!create && !renew) return null;
  const token = randomBytes(24).toString("hex");
  await mkdir(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_FILE, token + "\n", { mode: 0o600 });
  await chmod(TOKEN_FILE, 0o600).catch(() => {});
  return token;
}

const hmac = (token, msg) => createHmac("sha256", token).update(msg).digest("hex");

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv[0] === "token") {
  const renew = argv.includes("--new");
  if (process.env.ASEPRITE_MCP_TOKEN && !renew) {
    console.log(process.env.ASEPRITE_MCP_TOKEN.trim());
  } else {
    const token = await loadToken({ renew });
    console.log(token);
    console.error(
      renew
        ? `New token written to ${TOKEN_FILE}. Paste it into Aseprite (File > MCP Bridge...).`
        : `Token file: ${TOKEN_FILE}`
    );
  }
  process.exit(0);
}
if (argv[0] === "--help" || argv[0] === "-h") {
  console.log(`aseprite-mcp ${VERSION}

  aseprite-mcp               start the MCP server (stdio)
  aseprite-mcp token         print the pairing token
  aseprite-mcp token --new   generate a new pairing token

Environment:
  ASEPRITE_MCP_PORT          WebSocket port (default 9123)
  ASEPRITE_MCP_ALLOW_LUA=1   register the aseprite_run_lua tool
  ASEPRITE_MCP_TIMEOUT       per-command timeout in ms (default 15000)
  ASEPRITE_MCP_TOKEN         use this token instead of the token file
  ASEPRITE_MCP_TOKEN_FILE    token file location (default ${TOKEN_FILE})
  ASEPRITE_MCP_PALETTE_FILE  saved palettes (default ${PALETTE_FILE})
  ASEPRITE_MCP_FILE_DIRS     directories the file option may read (default ${DEFAULT_FILE_DIRS})`);
  process.exit(0);
}

const TOKEN = await loadToken();

// ---------------------------------------------------------------------------
// WebSocket bridge
// ---------------------------------------------------------------------------
let client = null; // authenticated Aseprite connection
let extensionVersion = null; // reported by the extension (null = older than 0.4.0)
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject, timer}

function rejectAll(reason) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

const wss = new WebSocketServer({ host: HOST, port: PORT, maxPayload: 8 * 1024 * 1024 });
wss.on("listening", () => log(`Waiting for Aseprite on ws://${HOST}:${PORT}`));
wss.on("error", (err) => log("WebSocket server error:", err.message));

wss.on("connection", (ws, req) => {
  const serverNonce = randomBytes(16).toString("hex");
  let authed = false;

  const authTimer = setTimeout(() => {
    if (!authed) ws.close(4001, "authentication timeout");
  }, AUTH_TIMEOUT_MS);

  ws.send(JSON.stringify({ type: "challenge", v: PROTOCOL, nonce: serverNonce }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!authed) {
      if (msg.type !== "hello") return;
      const nonceOk = typeof msg.nonce === "string" && msg.nonce.length >= 16 && msg.nonce.length <= 128;
      const expected = nonceOk ? hmac(TOKEN, `client|${serverNonce}|${msg.nonce}`) : "";
      if (msg.v !== PROTOCOL || !nonceOk || !safeEqualHex(msg.mac, expected)) {
        log(`Rejected connection from ${req.socket.remoteAddress}: bad token or protocol.`);
        ws.send(JSON.stringify({ type: "denied" }));
        ws.close(4003, "denied");
        return;
      }
      authed = true;
      clearTimeout(authTimer);
      ws.send(JSON.stringify({ type: "welcome", mac: hmac(TOKEN, `server|${msg.nonce}|${serverNonce}`) }));
      if (client && client !== ws) {
        log("New Aseprite connection replaces the previous one.");
        client.close(4000, "replaced");
      }
      client = ws;
      extensionVersion = typeof msg.extension === "string" ? msg.extension : null;
      log(`Aseprite ${msg.version ?? "?"} (extension ${extensionVersion ?? "< 0.4.0"}) connected and authenticated.`);
      if (versionWarning()) log(versionWarning());
      return;
    }

    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result ?? {});
    else p.reject(new Error(msg.error ?? "Unknown error in Aseprite"));
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    if (client === ws) {
      client = null;
      log("Aseprite disconnected.");
      rejectAll("Connection to Aseprite was lost.");
    }
  });
});

// "0.10.0" > "0.9.0"; anything unparsable counts as older
function compareVersions(a, b) {
  const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v ?? "") ? v.split(".").map(Number) : [-1, 0, 0]);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function requireExtension(min, feature) {
  if (compareVersions(extensionVersion, min) >= 0) return;
  throw new Error(
    `${feature} needs the MCP Bridge extension ${min} or newer (installed: ${extensionVersion ?? "< 0.4.0"}). ` +
      "Install it from the latest release and restart Aseprite."
  );
}

function versionWarning() {
  if (compareVersions(extensionVersion, MIN_EXTENSION) >= 0) return null;
  return (
    `The MCP Bridge extension in Aseprite (version ${extensionVersion ?? "< 0.4.0"}) is too old for server ${VERSION}. ` +
    "Install the extension from the latest release (or dist/aseprite-mcp-bridge.aseprite-extension) and restart Aseprite."
  );
}

function call(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    if (!client || client.readyState !== client.OPEN) {
      reject(
        new Error(
          "Aseprite is not connected. In Aseprite open File > MCP Bridge... and press Connect. " +
            "If it says the token was rejected, run `aseprite-mcp token` and paste the token into that window."
        )
      );
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout while running '${cmd}' (${TIMEOUT_MS} ms).`));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    client.send(JSON.stringify({ id, cmd, args }));
  });
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------
const INSTRUCTIONS = await readFile(new URL("./instructions.md", import.meta.url), "utf8").catch(() => undefined);
const server = new McpServer({ name: "aseprite", version: VERSION }, { instructions: INSTRUCTIONS });

// Compact JSON on purpose: every byte of a tool result costs the assistant tokens.
const asText = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }],
});

function tool(name, config, fn) {
  server.registerTool(name, config, async (args) => {
    try {
      return await fn(args ?? {});
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: String(err?.message ?? err) }] };
    }
  });
}

const color = z
  .string()
  .regex(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/)
  .describe("Hex color: #rgb, #rgba, #rrggbb or #rrggbbaa");
// Schemas avoid tuples, const and propertyNames: several MCP clients (e.g. Gemini) reject them.
// The exact shape is checked here instead.
const int = z.number().int();
const point = z.array(int).length(2).describe("[x, y]");
const target = {
  layer: z.string().optional().describe("Layer name (default: active layer)"),
  frame: z.number().int().min(1).optional().describe("Frame number, 1-based (default: active frame)"),
};
const MAX_PIXELS = 65536;
const rect = z
  .array(int)
  .length(4)
  .refine((r) => r[2] >= 1 && r[3] >= 1, "rect is [x, y, width, height] with width and height >= 1");
const mapPalette = z
  .object({})
  .catchall(color)
  .refine((p) => Object.keys(p).every((k) => k.length === 1), "palette keys must be single characters");
const rowsSchema = z.array(z.string().max(4096)).max(4096);
const stampsSchema = z
  .object({})
  .catchall(z.object({ rows: rowsSchema.min(1), palette: mapPalette.optional() }).strict())
  .refine((st) => Object.keys(st).every((k) => k.length >= 1 && k.length <= 64), "stamp names must be 1-64 characters")
  .describe('Reusable pixel maps: {"name": {"rows": [...], "palette"?: {...}}}');
const placeSchema = z
  .array(
    z
      .array(z.union([z.string(), int]))
      .min(3)
      .max(4)
      .refine(
        ([name, x, y, flip, ...rest]) =>
          typeof name === "string" && Number.isInteger(x) && Number.isInteger(y) && [undefined, "h", "v", "hv"].includes(flip) && !rest.length,
        'each place entry is [name, x, y] or [name, x, y, "h"|"v"|"hv"]'
      )
  )
  .max(4096)
  .describe('Stamps to draw after rows, in order: [name, x, y] or [name, x, y, "h"|"v"|"hv"] (flip); x/y relative to the map');
const fileSchema = z
  .string()
  .describe("Absolute path of a .json file with the drawing data (saves tokens for generated art); inline arguments override it");
const paletteName = z
  .string()
  .regex(/^[A-Za-z0-9][\w .-]{0,63}$/, "letters, digits, space, _ . - (max 64, starting with a letter or digit)")
  .describe("Name of a palette saved with aseprite_palette");

const region = z.union([rect, z.enum(["selection"])]);

// "selection" -> bounding box of the artist's current selection
async function resolveRect(r) {
  if (r !== "selection") return r;
  requireExtension("0.6.0", 'rect "selection"');
  const sel = await call("selection", {});
  if (sel.empty) throw new Error("Nothing is selected in Aseprite.");
  return [sel.x, sel.y, sel.width, sel.height];
}

// Pixel map (palette + text rows) -> [x, y, color] list for set_pixels
const SKIP_CHARS = new Set([".", " "]);
// hideChars: the rows came from a file – never repeat their characters in an error
function pixelMapToPixels({ palette, rows, x = 0, y = 0, hideChars = false }) {
  const pixels = [];
  const unknown = new Set();
  rows.forEach((row, j) => {
    Array.from(row).forEach((ch, i) => {
      if (SKIP_CHARS.has(ch)) return;
      const c = palette[ch];
      if (c === undefined) unknown.add(ch);
      else pixels.push([x + i, y + j, c]);
    });
  });
  if (unknown.size) {
    const which = hideChars ? "some characters in the file" : [...unknown].map((c) => JSON.stringify(c)).join(", ");
    throw new Error(
      `Characters not in palette: ${which}. ` +
        `Palette keys: ${Object.keys(palette).join("") || "(none)"}; use '.' or space for "leave unchanged".`
    );
  }
  if (pixels.length > MAX_PIXELS) throw new Error(`Too many pixels (${pixels.length} > ${MAX_PIXELS}).`);
  return pixels;
}

function flipRows(rows, flip) {
  let out = rows;
  if (flip === "h" || flip === "hv") {
    const w = Math.max(...rows.map((r) => Array.from(r).length));
    out = out.map((r) => Array.from(r.padEnd(w, ".")).reverse().join(""));
  }
  if (flip === "v" || flip === "hv") out = [...out].reverse();
  return out;
}

// rows + placed stamps -> one pixel list; later pixels win, duplicates are dropped
function composePixelMap({ palette = {}, rows = [], x = 0, y = 0, stamps = {}, place = [], hideChars = false }) {
  const byPos = new Map();
  let total = 0;
  const add = (list) => {
    total += list.length;
    if (total > MAX_PIXELS * 4) throw new Error(`Too many pixels before merging (> ${MAX_PIXELS * 4}); place fewer stamps.`);
    for (const p of list) byPos.set(`${p[0]},${p[1]}`, p);
  };
  add(pixelMapToPixels({ palette, rows, x, y, hideChars }));
  for (const [name, sx, sy, flip] of place) {
    const st = Object.hasOwn(stamps, name) ? stamps[name] : undefined;
    if (!st) {
      throw new Error(`Unknown stamp '${name}'. Defined stamps: ${Object.keys(stamps).join(", ") || "(none)"}.`);
    }
    try {
      add(pixelMapToPixels({ palette: { ...palette, ...st.palette }, rows: flipRows(st.rows, flip), x: x + sx, y: y + sy, hideChars }));
    } catch (err) {
      throw new Error(`stamp '${name}': ${err.message}`);
    }
  }
  if (byPos.size > MAX_PIXELS) throw new Error(`Too many pixels (${byPos.size} > ${MAX_PIXELS}).`);
  return [...byPos.values()];
}

const MAX_FILE_BYTES = 16 * 1024 * 1024;

// Formats Aseprite can open/save; anything else (scripts, dotfiles, ...) is refused
const IMAGE_PATH = /\.(aseprite|ase|png|gif|jpe?g|bmp|webp|tga|pcx|pcc|ico|flc|fli|svg|qoi|css)$/i;
function checkImagePath(path) {
  if (!isAbsolute(path)) throw new Error(`path must be absolute: ${path}`);
  if (!IMAGE_PATH.test(path)) {
    throw new Error(`path must end in an image format Aseprite supports (.aseprite, .png, .gif, ...): ${path}`);
  }
}
const FILE_FIELDS = new Set(["rows", "palette", "x", "y", "stamps", "place", "frames", "duration"]);

// Drawing data from a .json file. Errors never echo file contents.
async function insideAllowedDir(real) {
  for (const dir of FILE_DIRS) {
    const root = await realpath(dir).catch(() => null);
    if (root && (real === root || real.startsWith(root.endsWith(sep) ? root : root + sep))) return true;
  }
  return false;
}

async function loadDrawingFile(path, schema, what) {
  if (!isAbsolute(path)) throw new Error(`file must be an absolute path: ${path}`);
  if (!path.toLowerCase().endsWith(".json")) throw new Error(`file must be a .json file: ${path}`);
  let real, info;
  try {
    real = await realpath(path); // resolves symlinks, so they cannot point outside the allowed directories
    info = await stat(real);
  } catch {
    throw new Error(`Cannot read file: ${path}`);
  }
  if (!(await insideAllowedDir(real))) {
    throw new Error(`file must be inside ${FILE_DIRS.join(" or ")} (set ASEPRITE_MCP_FILE_DIRS to allow other directories): ${path}`);
  }
  if (!info.isFile()) throw new Error(`Not a file: ${path}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`file must belong to the current user: ${path}`);
  }
  if (info.size > MAX_FILE_BYTES) throw new Error(`File too large (${info.size} > ${MAX_FILE_BYTES} bytes): ${path}`);
  let data;
  try {
    data = JSON.parse(await readFile(real, "utf8"));
  } catch {
    throw new Error(`File is not valid JSON: ${path}`);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    // Only known field names, indices and error codes: never names or values taken from the file
    const safe = (k) => (typeof k === "number" || FILE_FIELDS.has(k) ? k : "<key>");
    const why = parsed.error.issues
      .map((e) => `${e.path.map(safe).join(".") || "(root)"}: ${e.code}`)
      .slice(0, 5)
      .join("; ");
    throw new Error(`File does not contain valid ${what} data (${path}): ${why}`);
  }
  return parsed.data;
}

// "ab.." -> "ab" (a regex like /\.+$/ is quadratic on long rows)
function trimDots(row) {
  let end = row.length;
  while (end > 0 && row[end - 1] === ".") end--;
  return row.slice(0, end);
}

// Only the arguments that were actually passed
const given = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

// Raw "rrggbbaa…" rows from Aseprite -> pixel_map format (palette + text rows).
// '"' and '\' are left out because they need escaping in JSON (= extra tokens).
const MAP_KEYS = Array.from(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+-/:;<=>?@^_~!|()[]{},'`"
);
function normHex(c) {
  let h = c.replace(/^#/, "").toLowerCase();
  if (h.length <= 4) h = h.replace(/./g, "$&$&");
  return h.length === 6 ? h + "ff" : h;
}
const shortHex = (h) => "#" + (h.endsWith("ff") ? h.slice(0, 6) : h);

// eraseKey: write fully transparent pixels with this key (for diffs) instead of '.';
// "........" always means "unchanged" and becomes '.'.
function hexRowsToPixelMap(rawRows, preferred = {}, { eraseKey } = {}) {
  const keyOf = new Map(); // rrggbbaa -> key
  for (const [k, c] of Object.entries(preferred ?? {})) {
    const h = normHex(c);
    if (!SKIP_CHARS.has(k) && k !== eraseKey && !h.endsWith("00") && !keyOf.has(h)) keyOf.set(h, k);
  }
  const taken = new Set(keyOf.values());
  const free = MAP_KEYS.filter((k) => !taken.has(k) && k !== eraseKey);
  const palette = {};
  const rows = rawRows.map((raw) => {
    let row = "";
    for (let i = 0; i < raw.length; i += 8) {
      const h = raw.slice(i, i + 8);
      if (h === "........") {
        row += ".";
        continue;
      }
      if (h.endsWith("00")) {
        if (eraseKey) {
          palette[eraseKey] = "#00000000";
          row += eraseKey;
        } else row += ".";
        continue;
      }
      let k = keyOf.get(h);
      if (k === undefined) {
        k = free.shift();
        if (k === undefined) {
          throw new Error(`Region has more than ${MAP_KEYS.length} colors; read a smaller rect or use aseprite_view.`);
        }
        keyOf.set(h, k);
      }
      palette[k] ??= shortHex(h);
      row += k;
    }
    return trimDots(row);
  });
  return { palette, rows };
}

// Saved palettes: { name: { key: color } } in PALETTE_FILE
async function loadPalettes() {
  try {
    const all = JSON.parse(await readFile(PALETTE_FILE, "utf8"));
    if (!all || typeof all !== "object" || Array.isArray(all)) throw new Error("not a JSON object");
    return all;
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Could not read ${PALETTE_FILE}: ${err.code ?? "not a valid palette file"}`);
  }
}

async function storePalettes(all) {
  await mkdir(dirname(PALETTE_FILE), { recursive: true });
  // write + rename, so an interrupted write never leaves a broken file behind
  const tmp = `${PALETTE_FILE}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(all, null, 1) + "\n");
  await rename(tmp, PALETTE_FILE);
}

const savedPalette = (all, name) => (Object.hasOwn(all, name) ? all[name] : undefined);

// Saved palette (paletteName) merged with an inline palette; inline keys win.
async function resolvePalette({ palette, paletteName }) {
  if (!paletteName) return palette;
  const saved = savedPalette(await loadPalettes(), paletteName);
  if (!saved) throw new Error(`No saved palette '${paletteName}'. Use aseprite_palette action=list.`);
  return { ...saved, ...palette };
}

// Raw pixels ("rrggbbaa" rows) from Aseprite
async function getPixels(args) {
  try {
    return await call("get_pixels", args);
  } catch (err) {
    if (/unknown command/i.test(err.message)) {
      throw new Error(`${err.message} – the Aseprite extension is outdated; install the current MCP Bridge extension and restart Aseprite.`);
    }
    throw err;
  }
}

const splitHex = (row) => row.match(/.{8}/g) ?? [];

// --- colour helpers --------------------------------------------------------
const hexToRgba = (c) => {
  const h = normHex(c);
  return [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const rgbaToHex = ([r, g, b, a = 255]) =>
  "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") + (a === 255 ? "" : a.toString(16).padStart(2, "0"));

// OKLCH: lightness as the eye sees it, so dark/light variants of pale colours stay natural
const toLinear = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToOklch(r, g, b) {
  [r, g, b] = [r, g, b].map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180) / Math.PI];
}

function oklchToLinear(L, C, h) {
  const A = C * Math.cos((h * Math.PI) / 180), B = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

// out-of-gamut colours keep lightness and hue and lose chroma
function oklchToRgb(L, C, h) {
  L = clamp01(L);
  const inGamut = (c) => oklchToLinear(L, c, h).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  if (!inGamut(C)) {
    let lo = 0, hi = C;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(mid)) lo = mid;
      else hi = mid;
    }
    C = lo;
  }
  return oklchToLinear(L, C, h).map((v) => Math.round(toSrgb(clamp01(v))));
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
// turn hue h towards target by at most deg degrees
function hueToward(h, target, deg) {
  const diff = ((target - h + 540) % 360) - 180;
  return h + Math.sign(diff) * Math.min(Math.abs(diff), deg);
}
const SHADOW_HUE = 290; // OKLCH violet: cool shadows (yellow/orange turn via red, never via green)
const LIGHT_HUE = 100; // OKLCH yellow: warm highlights

// Hue-shifted ramp, dark -> light, with the base colour in the middle
function rampColors(base, n, shift = 20) {
  const [r, g, b] = hexToRgba(base);
  const [L, C, h] = rgbToOklch(r, g, b);
  const mid = Math.floor((n - 1) / 2);
  return Array.from({ length: n }, (_, i) => {
    if (i === mid) return rgbaToHex([r, g, b]);
    if (i < mid) {
      const k = (mid - i) / mid;
      return rgbaToHex(oklchToRgb(L - (L - 0.2) * 0.9 * k, C * (1 + 0.1 * k), hueToward(h, SHADOW_HUE, shift * k)));
    }
    const k = (i - mid) / (n - 1 - mid);
    return rgbaToHex(oklchToRgb(L + (0.98 - L) * 0.8 * k, C * (1 - 0.6 * k), hueToward(h, LIGHT_HUE, shift * k)));
  });
}

// --- PNG (RGBA, no dependencies) --------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// rows of "rrggbbaa" -> [[r,g,b,a], ...] per row
const parseHexGrid = (rows) => rows.map((row) => splitHex(row).map((h) => [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16))));

// --- critique sheet ---------------------------------------------------------
const CRITIQUE_PANELS = ["color", "gray", "silhouette", "deutan", "1x"];
const PANEL_GAP = 4;
const DEUTAN = [
  [0.625, 0.375, 0],
  [0.7, 0.3, 0],
  [0, 0.3, 0.7],
];

// Same look as the extension's snapshot: upscaled, checkerboard behind transparency, optional grid
const MAX_VIEW_PIXELS = 4096 * 4096;
function renderView(grid, { scale, checker = true, gridLines = false }) {
  const h = grid.length, w = grid[0]?.length ?? 0;
  const W = w * scale, H = h * scale;
  if (W * H > MAX_VIEW_PIXELS) throw new Error(`Image would be ${W}x${H} px; use a smaller scale or rect.`);
  const out = Buffer.alloc(W * H * 4);
  const cs = scale >= 4 ? Math.max(2, Math.floor(scale / 2)) : 4;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let [r, g, b, a] = grid[Math.floor(y / scale)][Math.floor(x / scale)];
      if (checker) {
        const bg = (Math.floor(x / cs) + Math.floor(y / cs)) % 2 === 0 ? 204 : 255;
        const t = a / 255;
        [r, g, b, a] = [r * t + bg * (1 - t), g * t + bg * (1 - t), b * t + bg * (1 - t), 255];
      }
      [r, g, b, a] = [r, g, b, a].map(Math.floor);
      if (gridLines && scale >= 4) {
        // like the extension: grid crossings are darkened once per direction
        for (const onLine of [x % scale === 0, y % scale === 0]) {
          if (onLine) [r, g, b, a] = [r, g, b].map((v) => Math.floor(v * 0.7)).concat(255);
        }
      }
      out.set([r, g, b, a], (y * W + x) * 4);
    }
  }
  return { png: encodePng(W, H, out), width: W, height: H };
}

function critiqueSheet(grid, panels, scale) {
  const h = grid.length, w = grid[0]?.length ?? 0;
  const sizes = panels.map((p) => (p === "1x" ? 1 : scale));
  const W = sizes.reduce((sum, s) => sum + w * s, 0) + PANEL_GAP * (panels.length + 1);
  const H = Math.max(...sizes) * h + PANEL_GAP * 2;
  const out = Buffer.alloc(W * H * 4, 0);
  for (let i = 0; i < W * H; i++) out.set([96, 96, 104, 255], i * 4);
  let ox = PANEL_GAP;
  panels.forEach((p, idx) => {
    const s = sizes[idx], cell = Math.max(2, Math.floor(s / 2)) * (s === 1 ? 2 : 1);
    for (let py = 0; py < h * s; py++) {
      for (let px = 0; px < w * s; px++) {
        let [r, g, b, a] = grid[Math.floor(py / s)][Math.floor(px / s)];
        let bg = (Math.floor(px / cell) + Math.floor(py / cell)) % 2 ? [204, 204, 204] : [255, 255, 255];
        if (p === "gray") r = g = b = 0.299 * r + 0.587 * g + 0.114 * b;
        else if (p === "deutan") [r, g, b] = DEUTAN.map(([x, y, z]) => x * r + y * g + z * b);
        else if (p === "silhouette") {
          bg = [255, 255, 255];
          r = g = b = 0;
        }
        const t = a / 255;
        const o = ((PANEL_GAP + py) * W + ox + px) * 4;
        out.set([r * t + bg[0] * (1 - t), g * t + bg[1] * (1 - t), b * t + bg[2] * (1 - t)].map(Math.round), o);
      }
    }
    ox += w * s + PANEL_GAP;
  });
  return { png: encodePng(W, H, out), width: W, height: H };
}

// --- selective outline ------------------------------------------------------
function outlinePixels(grid, { style, color, position, strength, bounds }) {
  const h = grid.length, w = grid[0]?.length ?? 0;
  const alpha = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : grid[y][x][3]);
  const solid = (x, y) => alpha(x, y) >= 128;
  const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const N8 = [...N4, [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const isTarget = (x, y) =>
    position === "outside"
      ? alpha(x, y) === 0 && N4.some(([dx, dy]) => solid(x + dx, y + dy))
      : solid(x, y) && N4.some(([dx, dy]) => !solid(x + dx, y + dy));
  const inBounds = (x, y) => !bounds || (x >= bounds[0] && y >= bounds[1] && x < bounds[0] + bounds[2] && y < bounds[1] + bounds[3]);
  const fixed = color ? rgbaToHex(hexToRgba(color)) : "#1b1b2a";
  const pixels = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inBounds(x, y) || !isTarget(x, y)) continue;
      if (style === "solid") {
        pixels.push([x, y, fixed]);
        continue;
      }
      // the fill this outline pixel belongs to: most common solid neighbour that is not itself an edge
      const counts = new Map();
      let sx = 0, sy = 0;
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy;
        if (!solid(nx, ny) || (position === "inside" && isTarget(nx, ny))) continue;
        const key = grid[ny][nx].slice(0, 3).join(",");
        counts.set(key, (counts.get(key) ?? 0) + 1);
        sx += dx;
        sy += dy;
      }
      if (!counts.size) {
        if (position === "inside") counts.set(grid[y][x].slice(0, 3).join(","), 1);
        else continue;
      }
      const [r, g, b] = [...counts.entries()].sort((p, q) => q[1] - p[1])[0][0].split(",").map(Number);
      const [L, C, h] = rgbToOklch(r, g, b);
      const lit = sx + sy > 0; // the shape lies right/below: this edge faces the light (top-left)
      const light = lit ? L * (1 - strength * 0.25) : L * (1 - strength * 0.8);
      const hue = lit ? h : hueToward(h, SHADOW_HUE, 15);
      pixels.push([x, y, rgbaToHex(oklchToRgb(light, C * 1.05, hue))]);
    }
  }
  return pixels;
}

const pixelMapFile = z.union([
  rowsSchema,
  z
    .object({
      rows: rowsSchema.optional(),
      palette: mapPalette.optional(),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      stamps: stampsSchema.optional(),
      place: placeSchema.optional(),
    })
    .strict(),
]);

const animationFrame = z
  .object({
    rows: rowsSchema.optional().describe("Pixel rows for this frame (may be empty = unchanged)"),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    place: placeSchema.optional(),
    palette: mapPalette.optional().describe("Extra/overriding keys for this frame"),
    duration: z.number().positive().optional().describe("Seconds"),
  })
  .strict();
const animationFrames = z.array(animationFrame).min(1).max(256);

const animationFile = z.union([
  animationFrames,
  z
    .object({
      frames: animationFrames,
      palette: mapPalette.optional(),
      stamps: stampsSchema.optional(),
      duration: z.number().positive().optional(),
    })
    .strict(),
]);

// Operations usable both as individual tools and inside aseprite_batch.
// returnsInfo: the Lua side replies with the full sprite status.
const ops = {
  new_sprite: {
    title: "New sprite",
    description: "Creates a new sprite and makes it active. Returns the sprite status.",
    shape: {
      width: z.number().int().min(1).max(4096),
      height: z.number().int().min(1).max(4096),
      colorMode: z.enum(["rgb", "gray", "indexed"]).default("rgb"),
      background: color.optional().describe("Optional: fill the canvas with this color"),
    },
    returnsInfo: true,
    run: (a) => call("new_sprite", a),
  },
  pixel_map: {
    title: "Draw pixel map",
    description:
      "Most token-efficient way to draw many exact pixels: a palette of single-character keys and one text row per pixel row. " +
      "'.' and space leave the pixel unchanged; map a key to '#00000000' to erase. One undo step. " +
      'Example: palette {"k":"#222034","y":"#fbf236"}, rows ["..kk..", ".kyyk.", "kyyyyk"]. ' +
      "Repeated parts: define stamps once and draw them with place. Generated art: write the data to a .json file and pass file.",
    shape: {
      palette: mapPalette.optional().describe("Single character -> hex color (required unless paletteName is given)"),
      paletteName: paletteName.optional(),
      rows: rowsSchema.optional().describe("One string per pixel row, top to bottom"),
      x: z.number().int().optional().describe("Left edge of the map on the canvas (default 0)"),
      y: z.number().int().optional().describe("Top edge of the map on the canvas (default 0)"),
      stamps: stampsSchema.optional(),
      place: placeSchema.optional(),
      file: fileSchema.optional().describe(
        "Absolute path of a .json file: an array of rows, or an object with rows/palette/x/y/stamps/place; inline arguments override it"
      ),
      ...target,
    },
    run: async ({ palette, paletteName, rows, x, y, stamps, place, file, ...rest }) => {
      let data = given({ rows, x, y, stamps, place });
      let filePalette;
      if (file) {
        const f = await loadDrawingFile(file, pixelMapFile, "pixel map");
        const fromFile = Array.isArray(f) ? { rows: f } : f;
        filePalette = fromFile.palette;
        delete fromFile.palette;
        data = { ...fromFile, ...data };
      }
      palette = await resolvePalette({ palette: { ...filePalette, ...palette }, paletteName });
      if (!palette || !Object.keys(palette).length) throw new Error("Pass palette or paletteName (or a palette in the file).");
      if (!data.rows?.length && !data.place?.length) throw new Error("Nothing to draw: pass rows, place or file.");
      const pixels = composePixelMap({ palette, ...data, hideChars: Boolean(file) });
      if (!pixels.length) return { drawn: 0 };
      return call("set_pixels", { ...rest, pixels });
    },
  },
  set_pixels: {
    title: "Set pixels",
    description:
      "Sets individual pixels exactly, as a single undo step. The color '#00000000' erases a pixel. " +
      "For more than a few pixels prefer aseprite_pixel_map (far fewer tokens).",
    shape: {
      pixels: z
        .array(
          z
            .array(z.union([int, color]))
            .length(3)
            .refine((p) => Number.isInteger(p[0]) && Number.isInteger(p[1]) && typeof p[2] === "string", "each pixel is [x, y, color]")
        )
        .min(1)
        .max(MAX_PIXELS)
        .describe("List of [x, y, color]"),
      ...target,
    },
    run: (a) => call("set_pixels", a),
  },
  draw: {
    title: "Draw with a tool",
    description:
      "Uses an Aseprite tool like a mouse stroke. line/rectangle/filled_rectangle/ellipse/filled_ellipse take 2 points (start, end; inclusive). pencil/eraser/spray take any number of points (freehand path). paint_bucket takes 1 point. curve takes 4 points. polygon/contour take the corner points.",
    shape: {
      tool: z.enum([
        "pencil",
        "eraser",
        "spray",
        "line",
        "curve",
        "rectangle",
        "filled_rectangle",
        "ellipse",
        "filled_ellipse",
        "contour",
        "polygon",
        "paint_bucket",
        "gradient",
      ]),
      points: z.array(point).min(1).describe("List of [x, y]"),
      color: color.default("#000000"),
      size: z.number().int().min(1).max(64).default(1).describe("Brush size"),
      brushType: z.enum(["circle", "square", "line"]).default("circle"),
      opacity: z.number().int().min(0).max(255).default(255),
      tolerance: z.number().int().min(0).max(255).optional().describe("paint_bucket only"),
      contiguous: z.boolean().optional().describe("paint_bucket only"),
      pixelPerfect: z.boolean().default(false).describe("Pixel-perfect freehand for pencil"),
      ...target,
    },
    run: (a) => call("draw", a),
  },
  clear: {
    title: "Clear",
    description: "Clears the whole layer in the frame, or only a rectangle.",
    shape: {
      rect: region.optional().describe('[x, y, width, height] or "selection" (its bounding box)'),
      ...target,
    },
    run: async (a) => call("clear", { ...a, rect: await resolveRect(a.rect) }),
  },
  layer: {
    title: "Manage layers",
    description:
      "Create (new, becomes active), activate (select), delete, rename, or show/hide (visible) a layer. Returns the sprite status.",
    shape: {
      action: z.enum(["new", "select", "delete", "rename", "visible"]),
      name: z.string().describe("Layer name (for new: name of the new layer)"),
      newName: z.string().optional().describe("rename only"),
      visible: z.boolean().optional().describe("visible only"),
    },
    returnsInfo: true,
    run: (a) => call("layer", a),
  },
  frame: {
    title: "Manage frames",
    description:
      "Animation: create a frame after the given/active one (new, copies it by default, becomes active), activate (select), delete, or set its duration (in seconds). " +
      "To draw several frames at once use aseprite_animation. Returns the sprite status.",
    shape: {
      action: z.enum(["new", "select", "delete", "duration"]),
      frame: z.number().int().min(1).optional().describe("Frame number (default: active frame); new inserts after it"),
      copy: z.boolean().default(true).describe("new: copy that frame instead of inserting an empty one"),
      duration: z.number().positive().optional().describe("Seconds, e.g. 0.1"),
    },
    returnsInfo: true,
    run: (a) => call("frame", a),
  },
  copy: {
    title: "Copy / mirror a region",
    description:
      "Copies a rectangle of pixels, optionally flipped, to another position, layer or frame (one undo step). " +
      "Without x/y it writes back in place, so flip='h' mirrors the region where it is. " +
      "Symmetry example on a 16px-wide sprite: rect [0,0,8,16], flip 'h', x 8 mirrors the left half onto the right half.",
    shape: {
      rect: region.describe('Source [x, y, width, height] or "selection"'),
      fromLayer: z.string().optional().describe("Source layer (default: active layer)"),
      fromFrame: z.number().int().min(1).optional().describe("Source frame (default: active frame)"),
      x: z.number().int().optional().describe("Destination left edge (default: source x)"),
      y: z.number().int().optional().describe("Destination top edge (default: source y)"),
      layer: z.string().optional().describe("Destination layer (default: fromLayer, else active layer)"),
      frame: z.number().int().min(1).optional().describe("Destination frame (default: fromFrame, else active frame)"),
      flip: z.enum(["none", "h", "v", "both"]).default("none").describe("h = mirror left/right, v = top/bottom"),
      skipTransparent: z.boolean().default(false).describe("Leave destination pixels alone where the source is transparent"),
    },
    run: async ({ rect: r, fromLayer, fromFrame, x, y, layer, frame, flip, skipTransparent }) => {
      r = await resolveRect(r);
      const src = await getPixels({ rect: r, layer: fromLayer, frame: fromFrame });
      let grid = src.rows.map(splitHex);
      if (flip === "h" || flip === "both") grid = grid.map((row) => row.reverse());
      if (flip === "v" || flip === "both") grid.reverse();
      // src.x/src.y are the clipped source corner; keep the same offset at the destination
      const dx = (x ?? r[0]) + (src.x - r[0]);
      const dy = (y ?? r[1]) + (src.y - r[1]);
      const pixels = [];
      grid.forEach((row, j) =>
        row.forEach((h, i) => {
          if (skipTransparent && h.endsWith("00")) return;
          pixels.push([dx + i, dy + j, "#" + h]);
        })
      );
      if (!pixels.length) return { drawn: 0 };
      return call("set_pixels", {
        pixels,
        layer: layer ?? fromLayer ?? src.layer,
        frame: frame ?? fromFrame ?? src.frame,
      });
    },
  },
  animation: {
    title: "Draw an animation",
    description:
      "Draws several frames in ONE call, each as a pixel map, creating missing frames automatically. " +
      "With copyPrevious (default) a new frame starts as a copy of the previous one, so each entry only needs the changed rows " +
      "(use x/y and '.' to leave pixels unchanged; '.' never erases, map a key to '#00000000' for that). " +
      "Parts that repeat across frames (head, body …) belong in stamps, placed per frame with place: [name, x, y]. " +
      "For generated animations write frames/palette/stamps to a .json file and pass file. Returns the sprite status.",
    shape: {
      frames: animationFrames.optional().describe("One entry per frame (required unless file is given)"),
      stamps: stampsSchema.optional(),
      file: fileSchema.optional().describe(
        "Absolute path of a .json file: an array of frames, or an object with frames/palette/stamps/duration; inline arguments override it"
      ),
      palette: mapPalette.optional().describe("Palette shared by all frames"),
      paletteName: paletteName.optional(),
      start: z.number().int().min(1).default(1).describe("Frame number of the first entry"),
      copyPrevious: z.boolean().default(true).describe("New frames start as a copy of the previous frame"),
      duration: z.number().positive().optional().describe("Default duration of every drawn frame, in seconds"),
      layer: z.string().optional().describe("Layer name (default: active layer)"),
    },
    returnsInfo: true,
    run: async ({ frames, stamps, file, palette, paletteName, start, copyPrevious, duration, layer }) => {
      let filePalette;
      const fromFile = Boolean(file);
      if (file) {
        const f = await loadDrawingFile(file, animationFile, "animation");
        const fromFile = Array.isArray(f) ? { frames: f } : f;
        frames ??= fromFile.frames;
        stamps = { ...fromFile.stamps, ...stamps };
        duration ??= fromFile.duration;
        filePalette = fromFile.palette;
      }
      if (!frames?.length) throw new Error("Pass frames (or a file with frames).");
      const shared = (await resolvePalette({ palette: { ...filePalette, ...palette }, paletteName })) ?? {};
      let count = (await call("info")).frameCount;
      if (!count) throw new Error("No active sprite. Create one with aseprite_new_sprite.");
      if (start > count + 1) throw new Error(`start ${start} is beyond the last frame + 1 (sprite has ${count} frames).`);
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const n = start + i;
        try {
          if (n > count) {
            await call("frame", { action: "new", frame: n - 1, copy: copyPrevious });
            count++;
          }
          const pixels = composePixelMap({ palette: { ...shared, ...f.palette }, rows: f.rows, x: f.x, y: f.y, stamps, place: f.place, hideChars: fromFile });
          if (pixels.length) await call("set_pixels", { pixels, layer, frame: n });
          const d = f.duration ?? duration;
          if (d) await call("frame", { action: "duration", frame: n, duration: d });
        } catch (err) {
          throw new Error(`frame entry #${i + 1} (frame ${n}): ${err.message}`);
        }
      }
      await call("frame", { action: "select", frame: start });
      return call("info");
    },
  },
  outline: {
    title: "Outline",
    description:
      "Adds a 1px outline around (outside) or on the edge of (inside) everything opaque on a layer, in one undo step. " +
      "style 'selout' (default) derives each outline pixel from the colour it borders: darker and cooler on the shadow side, " +
      "lighter on the side facing the top-left light – the classic selective outline. style 'solid' uses one colour. " +
      "Works on sprites up to 128x128 (or pass rect). Semi-transparent pixels (alpha < 128) count as empty.",
    shape: {
      style: z.enum(["selout", "solid"]).default("selout"),
      color: color.optional().describe("solid only (default #1b1b2a)"),
      position: z.enum(["outside", "inside"]).default("outside"),
      strength: z.number().min(0).max(1).default(0.6).describe("selout: how much darker than the fill"),
      rect: region.optional().describe('Only outline inside [x, y, width, height] or "selection"'),
      ...target,
    },
    run: async ({ style, color: c, position, strength, rect: r, layer, frame }) => {
      const bounds = await resolveRect(r);
      const src = await getPixels({ layer, frame });
      const grid = parseHexGrid(src.rows);
      const local = bounds && [bounds[0] - src.x, bounds[1] - src.y, bounds[2], bounds[3]];
      const pixels = outlinePixels(grid, { style, color: c, position, strength, bounds: local }).map(([x, y, col]) => [
        x + src.x,
        y + src.y,
        col,
      ]);
      if (!pixels.length) return { drawn: 0 };
      return call("set_pixels", { pixels, layer: layer ?? src.layer, frame: frame ?? src.frame });
    },
  },
  history: {
    title: "Undo / redo",
    description: "Undoes or redoes steps.",
    shape: {
      action: z.enum(["undo", "redo"]),
      steps: z.number().int().min(1).max(100).default(1),
    },
    run: (a) => call("history", a),
  },
  save: {
    title: "Save",
    description:
      "Saves the active sprite. Without path the existing file is overwritten. With copy=true only a copy is exported (e.g. as .png).",
    shape: {
      path: z.string().optional().describe("Absolute path including extension (.aseprite, .png, .gif, ...)"),
      copy: z.boolean().default(false),
    },
    run: (a) => {
      if (a.path) checkImagePath(a.path);
      return call("save", a);
    },
  },
};

tool(
  "aseprite_status",
  {
    title: "Status / sprite info",
    description:
      "Checks the connection and returns info about the active sprite: size, color mode, layers, frames, active layer/frame. Coordinates start at (0,0) in the top-left corner.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const info = { ...(await call("info")), server: VERSION, minExtension: MIN_EXTENSION };
    const warning = versionWarning();
    if (warning) info.warning = warning;
    return asText(info);
  }
);

tool(
  "aseprite_help",
  {
    title: "Usage guide",
    description:
      "Returns the short usage guide (efficient workflow, pixel_map format, stamps, pixel-art tips). " +
      "Read it once before drawing if your client did not show the server instructions.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => asText(INSTRUCTIONS ?? "No usage guide found (instructions.md is missing).")
);

tool(
  "aseprite_open",
  {
    title: "Open file",
    description: "Opens a file (.aseprite, .png, .gif, ...) as the active sprite.",
    inputSchema: { path: z.string().describe("Absolute path") },
  },
  async (a) => {
    checkImagePath(a.path);
    return asText(await call("open", a));
  }
);

for (const [name, op] of Object.entries(ops)) {
  tool(
    `aseprite_${name}`,
    { title: op.title, description: op.description, inputSchema: op.shape },
    async (a) => asText(await op.run(a))
  );
}

const batchSchemas = Object.fromEntries(
  Object.entries(ops).map(([name, op]) => [name, z.object(op.shape).strict()])
);

tool(
  "aseprite_batch",
  {
    title: "Batch operations",
    description:
      "Runs several operations in ONE call, in order (saves round trips and tokens). Each item is " +
      '{"op": <name>, ...the same arguments as the tool aseprite_<name>}. ' +
      `Allowed ops: ${Object.keys(ops).join(", ")}. ` +
      "Stops at the first error; earlier ops stay applied (each op is its own undo step). " +
      "Returns one short result per op plus the final sprite status if layers/frames changed. " +
      'Example: [{"op":"layer","action":"new","name":"bg"},{"op":"draw","tool":"filled_rectangle","points":[[0,0],[15,15]],"color":"#5fcde4"},' +
      '{"op":"layer","action":"new","name":"fg"},{"op":"pixel_map","palette":{"k":"#000"},"rows":["kk"],"x":4,"y":4}]',
    inputSchema: {
      ops: z
        .array(z.object({ op: z.enum(Object.keys(ops)) }).passthrough())
        .min(1)
        .max(200),
    },
  },
  async ({ ops: items }) => {
    const results = [];
    let needStatus = false;
    for (let i = 0; i < items.length; i++) {
      const { op: name, ...args } = items[i];
      const where = `op #${i + 1} (${name})`;
      const parsed = batchSchemas[name].safeParse(args);
      if (!parsed.success) {
        const why = parsed.error.issues.map((e) => `${e.path.join(".") || "args"}: ${e.message}`).join("; ");
        throw new Error(`${where}: invalid arguments – ${why}. ${i} earlier op(s) were applied: ${JSON.stringify(results)}`);
      }
      try {
        const res = await ops[name].run(parsed.data);
        if (ops[name].returnsInfo) {
          needStatus = true;
          results.push("ok");
        } else {
          results.push(res);
        }
      } catch (err) {
        const why = String(err?.message ?? err).replace(/\.$/, "");
        throw new Error(`${where} failed: ${why}. ${i} earlier op(s) were applied: ${JSON.stringify(results)}`);
      }
    }
    const out = { results };
    if (needStatus) out.status = await call("info");
    return asText(out);
  }
);

tool(
  "aseprite_read_pixels",
  {
    title: "Read pixels as text",
    description:
      "Reads pixels back in the same palette + rows format as aseprite_pixel_map, so you can inspect exact colors " +
      "or copy/modify a region cheaply. '.' = fully transparent; trailing '.' are cut off. " +
      "Without layer the visible, flattened frame is read; with layer only that layer. " +
      "Pass the palette (or paletteName) you drew with to get the same keys back. Max 16384 pixels per call.",
    inputSchema: {
      rect: region.optional().describe('[x, y, width, height] or "selection" (default: whole canvas)'),
      palette: mapPalette.optional().describe("Preferred keys: character -> hex color"),
      paletteName: paletteName.optional(),
      ...target,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ palette, paletteName, ...args }) => {
    const preferred = await resolvePalette({ palette, paletteName });
    const res = await getPixels({ ...args, rect: await resolveRect(args.rect), flatten: !args.layer });
    const out = { x: res.x, y: res.y, w: res.width, h: res.height, frame: res.frame };
    if (res.layer) out.layer = res.layer;
    return asText({ ...out, ...hexRowsToPixelMap(res.rows, preferred) });
  }
);

tool(
  "aseprite_palette",
  {
    title: "Saved palettes",
    description:
      "Stores named palettes (character -> color) on disk so they can be reused across sprites and sessions via " +
      "paletteName in aseprite_pixel_map, aseprite_read_pixels, aseprite_animation. " +
      "Actions: save (name + colors), list (all saved palettes), delete (name), " +
      "from_image (name; collects the colors of the visible frame, or of layer/rect, and saves them with generated keys), " +
      "ramp (builds hue-shifted shading ramps – cool, saturated shadows and warm highlights – from base colours; " +
      'e.g. ramps [{"base":"#d63a3a","keys":"DmrRH"}] gives 5 keys dark->light with the base in the middle; saved when name is given).',
    inputSchema: {
      action: z.enum(["save", "list", "delete", "from_image", "ramp"]),
      name: paletteName.optional().describe("Palette name (not needed for list; optional for ramp)"),
      colors: mapPalette.optional().describe("save only: character -> hex color"),
      ramps: z
        .array(
          z
            .object({
              base: color,
              keys: z.string().min(2).max(9).describe("One key per step, dark -> light"),
              shift: z.number().min(0).max(90).optional().describe("Max hue shift in degrees (default 20)"),
            })
            .strict()
        )
        .min(1)
        .max(16)
        .optional()
        .describe("ramp only"),
      rect: region.optional().describe("from_image only"),
      ...target,
    },
  },
  async ({ action, name, colors, ramps, rect: r, layer, frame }) => {
    if (action === "ramp") {
      if (!ramps?.length) throw new Error("ramps is required for ramp.");
      const palette = {};
      for (const { base, keys, shift } of ramps) {
        const ks = Array.from(keys);
        if (ks.some((k) => SKIP_CHARS.has(k))) throw new Error(`'.' and space cannot be palette keys.`);
        rampColors(base, ks.length, shift).forEach((c, i) => (palette[ks[i]] = c));
      }
      if (!name) return asText(palette);
      const all = await loadPalettes();
      all[name] = palette;
      await storePalettes(all);
      return asText({ saved: name, palette });
    }
    const all = await loadPalettes();
    if (action === "list") return asText(all);
    if (!name) throw new Error(`name is required for ${action}.`);
    if (action === "delete") {
      if (!savedPalette(all, name)) throw new Error(`No saved palette '${name}'.`);
      delete all[name];
      await storePalettes(all);
      return asText({ deleted: name });
    }
    if (action === "save") {
      if (!colors || !Object.keys(colors).length) throw new Error("colors is required for save.");
      const bad = Object.keys(colors).filter((k) => SKIP_CHARS.has(k));
      if (bad.length) throw new Error(`'.' and space cannot be palette keys.`);
      all[name] = colors;
    } else {
      const res = await getPixels({ rect: await resolveRect(r), layer, frame, flatten: !layer });
      all[name] = hexRowsToPixelMap(res.rows).palette;
    }
    await storePalettes(all);
    return asText({ saved: name, palette: all[name] });
  }
);

tool(
  "aseprite_selection",
  {
    title: "Artist's selection",
    description:
      "Returns the region the artist has selected in Aseprite ({empty:true} if nothing is selected), so a request like " +
      "'improve this part' needs no coordinates. Most tools also accept rect \"selection\" directly. " +
      "mask=true adds the exact shape as rows ('#' selected) when it is not a plain rectangle.",
    inputSchema: { mask: z.boolean().default(false) },
    annotations: { readOnlyHint: true },
  },
  async ({ mask }) => {
    requireExtension("0.6.0", "aseprite_selection");
    const s = await call("selection", { mask });
    if (s.empty) return asText({ empty: true });
    const out = { x: s.x, y: s.y, w: s.width, h: s.height };
    if (s.mask) out.mask = s.mask.map(trimDots);
    return asText(out);
  }
);

tool(
  "aseprite_changes",
  {
    title: "What the artist changed",
    description:
      "Watch mode for drawing together. The first call starts watching the active sprite. Later calls return only the " +
      "pixels the ARTIST changed since the previous call (your own tool calls are not reported), as a pixel map of the " +
      "changed region: '.' = unchanged, '-' = erased, other keys = new colours. Feed it to aseprite_pixel_map to build on it. " +
      "peek=true looks without moving the baseline; reset=true starts over.",
    inputSchema: {
      frame: z.number().int().min(1).optional().describe("Frame to compare (default: active frame)"),
      peek: z.boolean().default(false),
      reset: z.boolean().default(false),
      palette: mapPalette.optional().describe("Preferred keys: character -> hex color"),
      paletteName: paletteName.optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ palette, paletteName, ...args }) => {
    requireExtension("0.6.0", "aseprite_changes");
    const res = await call("changes", args);
    if (res.watching) return asText({ watching: true, frames: res.frames });
    const out = { frame: res.frame, changed: res.changed };
    if (res.note) out.note = res.note;
    if (res.changed > 0) Object.assign(out, { x: res.x, y: res.y, w: res.width, h: res.height });
    if (res.rows) {
      const preferred = await resolvePalette({ palette, paletteName });
      Object.assign(out, hexRowsToPixelMap(res.rows, preferred, { eraseKey: "-" }));
    }
    return asText(out);
  }
);

tool(
  "aseprite_view",
  {
    title: "View image",
    description:
      "Renders the visible, flattened frame as an upscaled PNG so you can look at and check the result yourself. Transparency is shown as a checkerboard. " +
      "Use rect to zoom into a detail. Call it once after a drawing pass, not after every step. " +
      "If your client cannot show images, use aseprite_read_pixels instead. " +
      "critique=true instead returns ONE small sheet for self-review: colour, grayscale (value/contrast check), black silhouette " +
      "(readability) and true 1x size; add 'deutan' to panels for a colour-blindness check. Max 128x128 px (or pass rect).",
    inputSchema: {
      frame: z.number().int().min(1).optional(),
      rect: region.optional().describe('Only this [x, y, width, height] region or "selection", zoomed in (default: whole canvas)'),
      critique: z.boolean().default(false),
      panels: z.array(z.enum(CRITIQUE_PANELS)).min(1).max(5).optional().describe('critique only (default ["color","gray","silhouette","1x"])'),
      scale: z.number().int().min(1).max(64).optional().describe("Default: automatic (~512 px)"),
      checker: z.boolean().default(true),
      grid: z.boolean().default(false).describe("Draw a pixel grid (scale 4 or more)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ critique, panels, ...a }) => {
    a.rect = await resolveRect(a.rect);
    if (critique) {
      const res = await getPixels({ rect: a.rect, frame: a.frame, flatten: true });
      const grid = parseHexGrid(res.rows);
      const w = res.width, h = res.height;
      // at most ~1024 px per panel, whatever scale was asked for
      const scale = Math.max(1, Math.min(a.scale ?? Math.floor(192 / Math.max(w, h)), 16, Math.floor(1024 / Math.max(w, h))));
      const list = panels ?? ["color", "gray", "silhouette", "1x"];
      const sheet = critiqueSheet(grid, list, scale);
      const colors = new Set(grid.flat().filter((p) => p[3] > 0).map((p) => p.join(","))).size;
      return {
        content: [
          { type: "image", data: sheet.png.toString("base64"), mimeType: "image/png" },
          { type: "text", text: JSON.stringify({ panels: list, scale, rect: [res.x, res.y, w, h], colors, frame: res.frame }) },
        ],
      };
    }
    // Rendered here from raw pixels, so no file has to be shared with Aseprite (which may run in a
    // sandbox with its own /tmp, e.g. Flatpak). Only very large images still use a temporary file.
    let res = null;
    try {
      res = await getPixels({ rect: a.rect, frame: a.frame, flatten: true });
    } catch (err) {
      if (!/too large/i.test(err.message)) throw err;
    }
    if (res) {
      const scale = a.scale ?? Math.max(1, Math.min(64, Math.floor(512 / Math.max(res.width, res.height))));
      const img = renderView(parseHexGrid(res.rows), { scale, checker: a.checker, gridLines: a.grid });
      const info = { frame: res.frame, scale, rect: [res.x, res.y, res.width, res.height], imageWidth: img.width, imageHeight: img.height };
      return {
        content: [
          { type: "image", data: img.png.toString("base64"), mimeType: "image/png" },
          { type: "text", text: JSON.stringify(info) },
        ],
      };
    }
    const path = join(tmpdir(), `aseprite-mcp-${randomUUID()}.png`);
    try {
      const info = await call("snapshot", { ...a, path });
      const data = await readFile(path)
        .then((b) => b.toString("base64"))
        .catch(() => {
          throw new Error("Aseprite rendered the image, but the server cannot read it (sandboxed Aseprite?). Use a smaller rect.");
        });
      return {
        content: [
          { type: "image", data, mimeType: "image/png" },
          { type: "text", text: JSON.stringify(info) },
        ],
      };
    } finally {
      unlink(path).catch(() => {});
    }
  }
);

if (ALLOW_LUA) {
  tool(
    "aseprite_run_lua",
    {
      title: "Run Lua code",
      description:
        "Runs arbitrary Lua code in Aseprite (full scripting API: app, Sprite, Image, Palette, ...) inside one transaction (a single undo step). Use 'return value' to get a JSON result; print() output is returned too. Only works if 'Allow arbitrary Lua code' is ticked in the MCP Bridge window.",
      inputSchema: { code: z.string().min(1) },
    },
    async (a) => asText(await call("run_lua", a))
  );
}

// ---------------------------------------------------------------------------
await server.connect(new StdioServerTransport());
log(`MCP server ${VERSION} running (run_lua tool ${ALLOW_LUA ? "enabled" : "disabled"}).`);

const shutdown = () => {
  wss.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);
