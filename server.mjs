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
import { readFile, writeFile, mkdir, unlink, chmod } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from "node:crypto";

const VERSION = "0.2.0";
const PROTOCOL = 2;
const PORT = Number(process.env.ASEPRITE_MCP_PORT ?? 9123);
const HOST = "127.0.0.1"; // local only, on purpose
const TIMEOUT_MS = Number(process.env.ASEPRITE_MCP_TIMEOUT ?? 15000);
const AUTH_TIMEOUT_MS = 5000;
const ALLOW_LUA = process.env.ASEPRITE_MCP_ALLOW_LUA === "1";
const TOKEN_FILE =
  process.env.ASEPRITE_MCP_TOKEN_FILE ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "aseprite-mcp", "token");

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
  ASEPRITE_MCP_TOKEN_FILE    token file location (default ${TOKEN_FILE})`);
  process.exit(0);
}

const TOKEN = await loadToken();

// ---------------------------------------------------------------------------
// WebSocket bridge
// ---------------------------------------------------------------------------
let client = null; // authenticated Aseprite connection
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
      log(`Aseprite ${msg.version ?? "?"} connected and authenticated.`);
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
const server = new McpServer({ name: "aseprite", version: VERSION });

const asText = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
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
const point = z.tuple([z.number().int(), z.number().int()]);
const target = {
  layer: z.string().optional().describe("Layer name (default: active layer)"),
  frame: z.number().int().min(1).optional().describe("Frame number, 1-based (default: active frame)"),
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
  async () => asText(await call("info"))
);

tool(
  "aseprite_new_sprite",
  {
    title: "New sprite",
    description: "Creates a new sprite and makes it active.",
    inputSchema: {
      width: z.number().int().min(1).max(4096),
      height: z.number().int().min(1).max(4096),
      colorMode: z.enum(["rgb", "gray", "indexed"]).default("rgb"),
      background: color.optional().describe("Optional: fill the canvas with this color"),
    },
  },
  async (a) => asText(await call("new_sprite", a))
);

tool(
  "aseprite_open",
  {
    title: "Open file",
    description: "Opens a file (.aseprite, .png, .gif, ...) as the active sprite.",
    inputSchema: { path: z.string().describe("Absolute path") },
  },
  async (a) => asText(await call("open", a))
);

tool(
  "aseprite_save",
  {
    title: "Save",
    description:
      "Saves the active sprite. Without path the existing file is overwritten. With copy=true only a copy is exported (e.g. as .png).",
    inputSchema: {
      path: z.string().optional().describe("Absolute path including extension (.aseprite, .png, .gif, ...)"),
      copy: z.boolean().default(false),
    },
  },
  async (a) => asText(await call("save", a))
);

tool(
  "aseprite_set_pixels",
  {
    title: "Set pixels",
    description:
      "Sets individual pixels exactly (ideal for pixel art), as a single undo step. The color '#00000000' erases a pixel.",
    inputSchema: {
      pixels: z
        .array(z.tuple([z.number().int(), z.number().int(), color]))
        .min(1)
        .max(65536)
        .describe("List of [x, y, color]"),
      ...target,
    },
  },
  async (a) => asText(await call("set_pixels", a))
);

tool(
  "aseprite_draw",
  {
    title: "Draw with a tool",
    description:
      "Uses an Aseprite tool like a mouse stroke. line/rectangle/filled_rectangle/ellipse/filled_ellipse take 2 points (start, end). pencil/eraser/spray take any number of points (freehand path). paint_bucket takes 1 point. curve takes 4 points. polygon/contour take the corner points.",
    inputSchema: {
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
  },
  async (a) => asText(await call("draw", a))
);

tool(
  "aseprite_clear",
  {
    title: "Clear",
    description: "Clears the whole layer in the frame, or only a rectangle.",
    inputSchema: {
      rect: z
        .tuple([z.number().int(), z.number().int(), z.number().int().min(1), z.number().int().min(1)])
        .optional()
        .describe("[x, y, width, height]"),
      ...target,
    },
  },
  async (a) => asText(await call("clear", a))
);

tool(
  "aseprite_layer",
  {
    title: "Manage layers",
    description: "Create (new), activate (select), delete, rename, or show/hide (visible) a layer.",
    inputSchema: {
      action: z.enum(["new", "select", "delete", "rename", "visible"]),
      name: z.string().describe("Layer name (for new: name of the new layer)"),
      newName: z.string().optional().describe("rename only"),
      visible: z.boolean().optional().describe("visible only"),
    },
  },
  async (a) => asText(await call("layer", a))
);

tool(
  "aseprite_frame",
  {
    title: "Manage frames",
    description:
      "Animation: create a frame (new, optionally copying the active one), activate (select), delete, or set its duration (in seconds).",
    inputSchema: {
      action: z.enum(["new", "select", "delete", "duration"]),
      frame: z.number().int().min(1).optional().describe("Frame number (select/delete/duration)"),
      copy: z.boolean().default(true).describe("new: copy the active frame instead of an empty one"),
      duration: z.number().positive().optional().describe("Seconds, e.g. 0.1"),
    },
  },
  async (a) => asText(await call("frame", a))
);

tool(
  "aseprite_history",
  {
    title: "Undo / redo",
    description: "Undoes or redoes steps.",
    inputSchema: {
      action: z.enum(["undo", "redo"]),
      steps: z.number().int().min(1).max(100).default(1),
    },
  },
  async (a) => asText(await call("history", a))
);

tool(
  "aseprite_view",
  {
    title: "View image",
    description:
      "Renders the visible, flattened frame as an upscaled PNG so you can look at and check the result yourself. Transparency is shown as a checkerboard.",
    inputSchema: {
      frame: z.number().int().min(1).optional(),
      scale: z.number().int().min(1).max(64).optional().describe("Default: automatic (~512 px)"),
      checker: z.boolean().default(true),
      grid: z.boolean().default(false).describe("Draw a pixel grid (scale 4 or more)"),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) => {
    const path = join(tmpdir(), `aseprite-mcp-${randomUUID()}.png`);
    try {
      const info = await call("snapshot", { ...a, path });
      const data = (await readFile(path)).toString("base64");
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
