// End-to-end tests: real server.mjs <-> real extension/plugin.lua (in a mocked Aseprite).
// Requires lua5.4 (or lua5.3) and dkjson (Debian/Ubuntu: lua-dkjson). Skips otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import WebSocket, { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LUA = [process.env.LUA, "lua5.4", "lua5.3", "lua"]
  .filter(Boolean)
  .find((l) => spawnSync(l, ["-e", "require 'dkjson'"]).status === 0);
const skip = LUA ? false : "lua + dkjson not installed";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let portCounter = 19500 + Math.floor(Math.random() * 400);

// Lua plugin process whose WebSocket is relayed through Node
function startLua(port) {
  const p = spawn(LUA, [join(root, "test/harness.lua"), join(root, "extension")], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = [];
  let ws = null;
  createInterface({ input: p.stdout }).on("line", (line) => {
    lines.push(line);
    if (line.startsWith("CONNECT ")) {
      const url = line.slice(8).replace(/^http/, "ws");
      ws = new WebSocket(url);
      ws.on("open", () => p.stdin.write("OPEN\n"));
      ws.on("message", (m) => p.stdin.write("TEXT " + m.toString() + "\n"));
      ws.on("close", () => p.stdin.write("CLOSE\n"));
      ws.on("error", () => {});
    } else if (line.startsWith("SEND ") && ws?.readyState === WebSocket.OPEN) {
      ws.send(line.slice(5));
    } else if (line === "CLOSED") {
      ws?.close();
    }
  });
  p.stdin.write(`PORT ${port}\n`);
  return {
    lines,
    send: (s) => p.stdin.write(s + "\n"),
    status: () => lines.filter((l) => l.startsWith("STATUS ")).at(-1),
    kill: () => { ws?.close(); p.kill(); },
  };
}

async function startServer(token, port, env = {}) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(root, "server.mjs")],
    env: { ...process.env, ASEPRITE_MCP_TOKEN: token, ASEPRITE_MCP_PORT: String(port), ASEPRITE_MCP_ALLOW_LUA: "1", ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  return client;
}

async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(50); }
  return false;
}

test("handshake, commands and Lua permission", { skip }, async () => {
  const token = randomBytes(24).toString("hex");
  const port = portCounter++;
  const mcp = await startServer(token, port);
  const lua = startLua(port);
  try {
    lua.send("TOKEN " + token);
    lua.send("CONNECT");
    assert.ok(await waitFor(() => lua.status() === "STATUS Connected ✓"), "should authenticate: " + lua.status());

    let r = await mcp.callTool({ name: "aseprite_status", arguments: {} });
    assert.ok(!r.isError, r.content[0].text);
    const st = JSON.parse(r.content[0].text);
    assert.equal(st.version, "1.3-mock");
    assert.equal(st.server, st.extension, "plugin reports its version");
    assert.equal(st.warning, undefined);

    r = await mcp.callTool({ name: "aseprite_run_lua", arguments: { code: "return 1+1" } });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /disabled/);

    lua.send("ALLOWLUA true");
    await sleep(100);
    r = await mcp.callTool({ name: "aseprite_run_lua", arguments: { code: "print('hi', 3) return {x = 6*7}" } });
    assert.ok(!r.isError, r.content[0].text);
    const v = JSON.parse(r.content[0].text);
    assert.equal(v.value.x, 42);
    assert.deepEqual(v.printed, ["hi\t3"]);

    r = await mcp.callTool({ name: "aseprite_draw", arguments: { tool: "line", points: [[0, 0], [1, 1]] } });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /No active sprite/);
  } finally {
    lua.kill();
    await mcp.close();
  }
});

test("wrong token is rejected by the server", { skip }, async () => {
  const port = portCounter++;
  const mcp = await startServer(randomBytes(24).toString("hex"), port);
  const lua = startLua(port);
  try {
    lua.send("TOKEN " + randomBytes(24).toString("hex"));
    lua.send("CONNECT");
    assert.ok(await waitFor(() => lua.status()?.includes("Token rejected")), lua.status());
    const r = await mcp.callTool({ name: "aseprite_status", arguments: {} });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /not connected/);
  } finally {
    lua.kill();
    await mcp.close();
  }
});

test("plugin refuses a fake server that does not know the token", { skip }, async () => {
  const port = portCounter++;
  const fake = new WebSocketServer({ host: "127.0.0.1", port });
  const received = [];
  fake.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "challenge", v: 2, nonce: randomBytes(16).toString("hex") }));
    ws.on("message", (m) => {
      const msg = JSON.parse(m.toString());
      received.push(msg);
      if (msg.type === "hello") {
        // Commands before auth must be ignored
        ws.send(JSON.stringify({ id: 1, cmd: "info", args: {} }));
        ws.send(JSON.stringify({ type: "welcome", mac: "00".repeat(32) }));
        ws.send(JSON.stringify({ id: 2, cmd: "run_lua", args: { code: "return 1" } }));
      }
    });
  });
  const lua = startLua(port);
  try {
    lua.send("TOKEN " + randomBytes(24).toString("hex"));
    lua.send("ALLOWLUA true");
    lua.send("CONNECT");
    assert.ok(await waitFor(() => lua.status()?.includes("Server failed authentication")), lua.status());
    await sleep(300);
    assert.equal(received.filter((m) => m.id !== undefined).length, 0, "no command must be answered");
  } finally {
    lua.kill();
    fake.close();
  }
});

test("server ignores and closes unauthenticated clients", { skip: false }, async () => {
  const token = randomBytes(24).toString("hex");
  const port = portCounter++;
  const mcp = await startServer(token, port);
  try {
    await sleep(300);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const msgs = [];
    ws.on("message", (m) => msgs.push(JSON.parse(m.toString())));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ id: 1, ok: true, result: {} }));
    ws.send(JSON.stringify({ type: "hello", v: 2, nonce: "a".repeat(32), mac: "b".repeat(64) }));
    const code = await new Promise((r) => ws.on("close", (c) => r(c)));
    assert.equal(code, 4003);
    assert.equal(msgs[0].type, "challenge");
    assert.equal(msgs[1].type, "denied");
    const r = await mcp.callTool({ name: "aseprite_status", arguments: {} });
    assert.ok(r.isError);

    // correct HMAC from a Node client is accepted
    const ok = new WebSocket(`ws://127.0.0.1:${port}`);
    const got = [];
    ok.on("message", (m) => {
      const msg = JSON.parse(m.toString());
      got.push(msg);
      if (msg.type === "challenge") {
        const cn = randomBytes(16).toString("hex");
        ok.cn = cn;
        ok.sn = msg.nonce;
        ok.send(JSON.stringify({ type: "hello", v: 2, nonce: cn,
          mac: createHmac("sha256", token).update(`client|${msg.nonce}|${cn}`).digest("hex") }));
      }
    });
    assert.ok(await waitFor(() => got.some((m) => m.type === "welcome")));
    const welcome = got.find((m) => m.type === "welcome");
    assert.equal(welcome.mac, createHmac("sha256", token).update(`server|${ok.cn}|${ok.sn}`).digest("hex"));
    ok.close();
  } finally {
    await mcp.close();
  }
});

// Authenticated Node client that plays Aseprite and records the commands it receives
async function fakeAseprite(token, port, reply = () => ({}), extension) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const cmds = [];
  let ready = false;
  ws.on("message", (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.type === "challenge") {
      const cn = randomBytes(16).toString("hex");
      ws.send(JSON.stringify({ type: "hello", v: 2, nonce: cn, extension,
        mac: createHmac("sha256", token).update(`client|${msg.nonce}|${cn}`).digest("hex") }));
    } else if (msg.type === "welcome") {
      ready = true;
    } else if (msg.id !== undefined) {
      cmds.push(msg);
      try {
        ws.send(JSON.stringify({ id: msg.id, ok: true, result: reply(msg) }));
      } catch (e) {
        ws.send(JSON.stringify({ id: msg.id, ok: false, error: e.message }));
      }
    }
  });
  await sleep(300);
  assert.ok(await waitFor(() => ready), "fake Aseprite should authenticate");
  return { cmds, close: () => ws.close() };
}

test("pixel_map, batch and server instructions", async () => {
  const token = randomBytes(24).toString("hex");
  const port = portCounter++;
  const mcp = await startServer(token, port);
  const fake = await fakeAseprite(token, port, (msg) => {
    if (msg.cmd === "draw" && msg.args.tool === "curve") throw new Error("boom");
    if (msg.cmd === "set_pixels") return { drawn: msg.args.pixels.length };
    if (["info", "layer", "frame"].includes(msg.cmd)) return { width: 8, layers: [{ name: "a" }] };
    return {};
  });
  try {
    assert.match(mcp.getInstructions() ?? "", /pixel_map/);
    const st = JSON.parse((await mcp.callTool({ name: "aseprite_status", arguments: {} })).content[0].text);
    assert.match(st.warning, /extension in Aseprite is version < 0\.4\.0/);
    const { tools } = await mcp.listTools();
    for (const n of ["aseprite_pixel_map", "aseprite_batch", "aseprite_set_pixels", "aseprite_view"]) {
      assert.ok(tools.some((t) => t.name === n), n);
    }

    let r = await mcp.callTool({
      name: "aseprite_pixel_map",
      arguments: { palette: { k: "#000", r: "#ff0000" }, rows: [".k", "rk r"], x: 2, y: 3, layer: "L" },
    });
    assert.ok(!r.isError, r.content[0].text);
    assert.equal(r.content[0].text, '{"drawn":4}');
    assert.deepEqual(fake.cmds.at(-1).args, {
      layer: "L",
      pixels: [[3, 3, "#000"], [2, 4, "#ff0000"], [3, 4, "#000"], [5, 4, "#ff0000"]],
    });

    r = await mcp.callTool({ name: "aseprite_pixel_map", arguments: { palette: { k: "#000" }, rows: ["kx"] } });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /not in palette: "x"/);

    const before = fake.cmds.length;
    r = await mcp.callTool({
      name: "aseprite_batch",
      arguments: {
        ops: [
          { op: "layer", action: "new", name: "bg" },
          { op: "draw", tool: "line", points: [[0, 0], [3, 3]] },
          { op: "pixel_map", palette: { a: "#abc" }, rows: ["a"] },
        ],
      },
    });
    assert.ok(!r.isError, r.content[0].text);
    const out = JSON.parse(r.content[0].text);
    assert.deepEqual(out.results, ["ok", {}, { drawn: 1 }]);
    assert.equal(out.status.width, 8);
    const sent = fake.cmds.slice(before).map((c) => c.cmd);
    assert.deepEqual(sent, ["layer", "draw", "set_pixels", "info"]);
    assert.equal(fake.cmds[before + 1].args.color, "#000000", "defaults are applied inside batch");

    r = await mcp.callTool({
      name: "aseprite_batch",
      arguments: { ops: [{ op: "draw", tool: "line", points: [[0, 0]], colour: "#fff" }] },
    });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /op #1 \(draw\): invalid arguments/);

    r = await mcp.callTool({
      name: "aseprite_batch",
      arguments: { ops: [
        { op: "history", action: "undo" },
        { op: "draw", tool: "curve", points: [[0, 0]] },
        { op: "history", action: "redo" },
      ] },
    });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /op #2 \(draw\) failed: boom\. 1 earlier op/);
    assert.notEqual(fake.cmds.at(-1).args.action, "redo", "must stop at the first error");
  } finally {
    fake.close();
    await mcp.close();
  }
});

test("read_pixels returns the pixel_map format", async () => {
  const token = randomBytes(24).toString("hex");
  const port = portCounter++;
  const mcp = await startServer(token, port);
  const fake = await fakeAseprite(token, port, (msg) => {
    if (msg.cmd !== "get_pixels") return {};
    if (msg.args.frame === 9) throw new Error("Unknown command: get_pixels"); // old extension
    return {
      x: 1, y: 2, width: 3, height: 3, frame: 1, layer: msg.args.layer,
      rows: [
        "000000ff" + "ff000080" + "00000000",
        "00000000" + "00000000" + "00000000",
        "123456ff" + "000000ff" + "ffffff00",
      ],
    };
  });
  try {
    let r = await mcp.callTool({ name: "aseprite_read_pixels", arguments: { rect: [1, 2, 3, 3], layer: "L" } });
    assert.ok(!r.isError, r.content[0].text);
    assert.deepEqual(fake.cmds.at(-1).args, { rect: [1, 2, 3, 3], layer: "L", flatten: false });
    assert.deepEqual(JSON.parse(r.content[0].text), {
      x: 1, y: 2, w: 3, h: 3, frame: 1, layer: "L",
      palette: { a: "#000000", b: "#ff000080", c: "#123456" },
      rows: ["ab", "", "ca"],
    });

    r = await mcp.callTool({
      name: "aseprite_read_pixels",
      arguments: { palette: { k: "#000", a: "#123456", z: "#00000000" } },
    });
    assert.ok(!r.isError, r.content[0].text);
    const m = JSON.parse(r.content[0].text);
    assert.deepEqual(m.palette, { k: "#000000", b: "#ff000080", a: "#123456" });
    assert.deepEqual(m.rows, ["kb", "", "ak"]);
    assert.equal(m.layer, undefined);

    r = await mcp.callTool({ name: "aseprite_read_pixels", arguments: { frame: 9 } });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /extension is outdated/);
  } finally {
    fake.close();
    await mcp.close();
  }
});

test("copy, animation and saved palettes", async () => {
  const token = randomBytes(24).toString("hex");
  const port = portCounter++;
  const dir = mkdtempSync(join(tmpdir(), "aseprite-mcp-test-"));
  const mcp = await startServer(token, port, { ASEPRITE_MCP_PALETTE_FILE: join(dir, "p.json") });
  let frameCount = 1;
  const fake = await fakeAseprite(token, port, (msg) => {
    const a = msg.args;
    if (msg.cmd === "get_pixels") {
      // 3x2 region, clipped on the left by one column
      return { x: 1, y: 0, width: 2, height: 2, frame: 1, layer: a.flatten ? undefined : "L1",
        rows: ["ff0000ff00000000", "00ff00ff0000ffff"] };
    }
    if (msg.cmd === "frame" && a.action === "new") frameCount++;
    if (msg.cmd === "set_pixels") return { drawn: a.pixels.length };
    if (["info", "frame"].includes(msg.cmd)) return { frameCount };
    return {};
  });
  const callTool = async (name, args) => {
    const r = await mcp.callTool({ name, arguments: args });
    assert.ok(!r.isError, r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  try {
    // copy with horizontal flip to another spot
    await callTool("aseprite_copy", { rect: [0, 0, 3, 2], flip: "h", x: 10, y: 5, frame: 2 });
    let c = fake.cmds.at(-1);
    assert.equal(fake.cmds.at(-2).args.flatten, undefined, "copy reads a layer, not the flattened image");
    assert.deepEqual(c.args, {
      layer: "L1", frame: 2,
      pixels: [[11, 5, "#00000000"], [12, 5, "#ff0000ff"], [11, 6, "#0000ffff"], [12, 6, "#00ff00ff"]],
    });
    // mirror in place, vertically, skipping transparent pixels
    await callTool("aseprite_copy", { rect: [1, 0, 2, 2], flip: "v", skipTransparent: true, fromLayer: "X" });
    c = fake.cmds.at(-1);
    assert.equal(c.args.layer, "X");
    assert.deepEqual(c.args.pixels, [[1, 0, "#00ff00ff"], [2, 0, "#0000ffff"], [1, 1, "#ff0000ff"]]);

    // saved palettes
    await callTool("aseprite_palette", { action: "save", name: "pico", colors: { k: "#000", w: "#fff" } });
    await callTool("aseprite_palette", { action: "from_image", name: "img" });
    const all = await callTool("aseprite_palette", { action: "list" });
    assert.deepEqual(all, { pico: { k: "#000", w: "#fff" }, img: { a: "#ff0000", b: "#00ff00", c: "#0000ff" } });
    let r = await callTool("aseprite_pixel_map", { paletteName: "pico", palette: { r: "#f00" }, rows: ["kwr"] });
    assert.deepEqual(fake.cmds.at(-1).args.pixels, [[0, 0, "#000"], [1, 0, "#fff"], [2, 0, "#f00"]]);
    r = await callTool("aseprite_read_pixels", { paletteName: "img", layer: "L1" });
    assert.deepEqual(r.rows, ["a", "bc"]);
    assert.equal(fake.cmds.at(-1).args.flatten, false);
    let e = await mcp.callTool({ name: "aseprite_pixel_map", arguments: { paletteName: "nope", rows: ["k"] } });
    assert.match(e.content[0].text, /No saved palette 'nope'/);
    e = await mcp.callTool({ name: "aseprite_pixel_map", arguments: { rows: ["k"] } });
    assert.match(e.content[0].text, /Pass palette or paletteName/);
    for (const bad of ["__proto__", "../x", "", "a/b"]) {
      e = await mcp.callTool({ name: "aseprite_palette", arguments: { action: "save", name: bad, colors: { k: "#000" } } });
      assert.ok(e.isError, bad);
    }
    e = await mcp.callTool({ name: "aseprite_palette", arguments: { action: "delete", name: "toString" } });
    assert.match(e.content[0].text, /No saved palette 'toString'/);
    e = await mcp.callTool({ name: "aseprite_pixel_map", arguments: { paletteName: "constructor", rows: ["k"] } });
    assert.match(e.content[0].text, /No saved palette/);
    await callTool("aseprite_palette", { action: "delete", name: "img" });
    assert.deepEqual(Object.keys(await callTool("aseprite_palette", { action: "list" })), ["pico"]);

    // animation: frame 1 exists, frames 2 and 3 are created
    const before = fake.cmds.length;
    const st = await callTool("aseprite_animation", {
      paletteName: "pico",
      duration: 0.2,
      frames: [
        { rows: ["kk"] },
        { rows: ["w"], x: 1, duration: 0.1 },
        { rows: [] },
      ],
    });
    assert.equal(st.frameCount, 3);
    const seq = fake.cmds.slice(before).map((m) => [m.cmd, m.args.action ?? "", m.args.frame ?? ""].join(":"));
    assert.deepEqual(seq, [
      "info::",
      "set_pixels::1", "frame:duration:1",
      "frame:new:1", "set_pixels::2", "frame:duration:2",
      "frame:new:2", "frame:duration:3",
      "frame:select:1", "info::",
    ]);
    assert.equal(fake.cmds[before + 5].args.duration, 0.1);
    assert.deepEqual(fake.cmds[before + 4].args.pixels, [[1, 0, "#fff"]]);

    // animation inside batch
    const b = await callTool("aseprite_batch", { ops: [{ op: "animation", start: 4, copyPrevious: false, frames: [{ rows: ["k"], palette: { k: "#123" } }] }] });
    assert.deepEqual(b.results, ["ok"]);
    assert.equal(fake.cmds.find((m) => m.cmd === "frame" && m.args.action === "new" && m.args.copy === false) !== undefined, true);
    e = await mcp.callTool({ name: "aseprite_animation", arguments: { start: 9, frames: [{ rows: [] }] } });
    assert.match(e.content[0].text, /beyond the last frame/);
  } finally {
    fake.close();
    await mcp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
