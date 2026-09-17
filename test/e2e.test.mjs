// End-to-end tests: real server.mjs <-> real extension/plugin.lua (in a mocked Aseprite).
// Requires lua5.4 (or lua5.3) and dkjson (Debian/Ubuntu: lua-dkjson). Skips otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
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
    assert.equal(st.warning, undefined, "the extension in this repository is new enough");

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
    assert.doesNotMatch(r.content[0].text, /\.lua:\d+/, "no Lua source location in errors");

    r = await mcp.callTool({ name: "aseprite_run_lua", arguments: { code: "local n = 5.0 error('frame ' .. n)" } });
    assert.match(r.content[0].text, /frame 5\.0/, "plain Lua floats are left alone");
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
    if (msg.cmd === "draw" && msg.args.tool === "curve") throw new Error("boom.");
    if (msg.cmd === "set_pixels") return { drawn: msg.args.pixels.length };
    if (["info", "layer", "frame"].includes(msg.cmd)) return { width: 8, layers: [{ name: "a" }] };
    return {};
  });
  try {
    assert.match(mcp.getInstructions() ?? "", /pixel_map/);
    const st = JSON.parse((await mcp.callTool({ name: "aseprite_status", arguments: {} })).content[0].text);
    assert.match(st.warning, /extension in Aseprite \(version < 0\.4\.0\) is too old/);
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
    assert.doesNotMatch(r.content[0].text, /\.\./);
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

test("stamps and drawing data from files", async () => {
  const token = randomBytes(24).toString("hex");
  const port = portCounter++;
  const dir = mkdtempSync(join(tmpdir(), "aseprite-mcp-test-"));
  const mcp = await startServer(token, port);
  let frameCount = 1;
  const fake = await fakeAseprite(token, port, (msg) => {
    if (msg.cmd === "frame" && msg.args.action === "new") frameCount++;
    if (msg.cmd === "set_pixels") return { drawn: msg.args.pixels.length };
    if (["info", "frame"].includes(msg.cmd)) return { frameCount };
    return {};
  });
  const ok = async (name, args) => {
    const r = await mcp.callTool({ name, arguments: args });
    assert.ok(!r.isError, r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  const fails = async (name, args, re) => {
    const r = await mcp.callTool({ name, arguments: args });
    assert.ok(r.isError, `${name} should fail`);
    assert.match(r.content[0].text, re);
    return r.content[0].text;
  };
  const write = (name, data) => {
    const p = join(dir, name);
    writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data));
    return p;
  };
  const lastPixels = () => fake.cmds.at(-1).args.pixels;
  try {
    // stamps: placed after rows, relative to x/y, flipped, later pixels win, no duplicates
    await ok("aseprite_pixel_map", {
      palette: { a: "#111", b: "#222" },
      rows: ["aaa"],
      x: 10,
      y: 20,
      stamps: { s: { rows: ["b.", "bc"], palette: { c: "#333" } } },
      place: [["s", 1, 0], ["s", 0, 2, "h"], ["s", 4, 0, "v"]],
    });
    assert.deepEqual(lastPixels(), [
      [10, 20, "#111"], [11, 20, "#222"], [12, 20, "#111"], [11, 21, "#222"], [12, 21, "#333"],
      [11, 22, "#222"], [10, 23, "#333"], [11, 23, "#222"],
      [14, 20, "#222"], [15, 20, "#333"], [14, 21, "#222"],
    ]);

    // place only, no rows
    await ok("aseprite_pixel_map", { palette: { a: "#111" }, stamps: { dot: { rows: ["a"] } }, place: [["dot", 3, 4]] });
    assert.deepEqual(lastPixels(), [[3, 4, "#111"]]);

    // file: plain array of rows; inline palette
    await ok("aseprite_pixel_map", { file: write("rows.json", ["a.a"]), palette: { a: "#abc" }, y: 5 });
    assert.deepEqual(lastPixels(), [[0, 5, "#abc"], [2, 5, "#abc"]]);

    // file: object; inline x and palette keys override the file
    const obj = write("map.json", { rows: ["ab"], palette: { a: "#111", b: "#222" }, x: 7, stamps: { t: { rows: ["b"] } }, place: [["t", 0, 1]] });
    await ok("aseprite_pixel_map", { file: obj, palette: { b: "#999" }, x: 1, layer: "L" });
    assert.deepEqual(fake.cmds.at(-1).args, { layer: "L", pixels: [[1, 0, "#111"], [2, 0, "#999"], [1, 1, "#999"]] });

    // errors
    await fails("aseprite_pixel_map", { palette: { a: "#111" }, place: [["nope", 0, 0]] }, /Unknown stamp 'nope'\. Defined stamps: \(none\)/);
    await fails("aseprite_pixel_map", { palette: { a: "#111" }, stamps: { s: { rows: ["z"] } }, place: [["s", 0, 0]] }, /stamp 's': Characters not in palette: "z"/);
    await fails("aseprite_pixel_map", { palette: { a: "#111" } }, /Nothing to draw/);
    await fails("aseprite_pixel_map", { file: "rows.json" }, /absolute path/);
    await fails("aseprite_pixel_map", { file: join(dir, "x.txt") }, /\.json file/);
    await fails("aseprite_pixel_map", { file: join(dir, "missing.json") }, /Cannot read file/);
    const secret = await fails("aseprite_pixel_map", { file: write("bad.json", "SECRET-CONTENT {") }, /not valid JSON/);
    assert.doesNotMatch(secret, /SECRET/, "file contents are never echoed");
    const leak = await fails("aseprite_pixel_map", { file: write("wrong.json", { rows: ["a"], apiKeyName: "hunter2", palette: { a: "not-a-color" } }) }, /does not contain valid pixel map data/);
    assert.doesNotMatch(leak, /apiKeyName|hunter2|not-a-color/, "no keys or values from the file");

    // animation from a file with stamps; inline duration wins
    const anim = write("anim.json", {
      palette: { h: "#f00", l: "#0f0" },
      stamps: { head: { rows: ["hh"] } },
      duration: 0.3,
      frames: [
        { rows: [".", "l"], place: [["head", 0, 0]] },
        { rows: [".", ".l"], place: [["head", 0, -1]], duration: 0.05 },
      ],
    });
    const before = fake.cmds.length;
    const st = await ok("aseprite_animation", { file: anim, duration: 0.1, copyPrevious: false });
    assert.equal(st.frameCount, 2);
    const sent = fake.cmds.slice(before);
    const sets = sent.filter((m) => m.cmd === "set_pixels");
    assert.deepEqual(sets[0].args.pixels, [[0, 1, "#0f0"], [0, 0, "#f00"], [1, 0, "#f00"]]);
    assert.deepEqual(sets[1].args.pixels, [[1, 1, "#0f0"], [0, -1, "#f00"], [1, -1, "#f00"]]);
    const durs = sent.filter((m) => m.args.action === "duration").map((m) => m.args.duration);
    assert.deepEqual(durs, [0.1, 0.05]);
    assert.equal(sent.find((m) => m.args.action === "new").args.copy, false);

    // animation: inline frames and stamps, no file; errors name the frame
    await ok("aseprite_animation", { palette: { a: "#111" }, stamps: { s: { rows: ["a"] } }, frames: [{ place: [["s", 2, 2]] }] });
    await fails("aseprite_animation", { palette: { a: "#111" }, frames: [{ place: [["gone", 0, 0]] }] }, /frame entry #1 \(frame 1\): Unknown stamp 'gone'/);
    await fails("aseprite_animation", { palette: { a: "#111" } }, /Pass frames/);
    await fails("aseprite_animation", { file: write("anim-bad.json", { frames: [] }) }, /valid animation data/);

    // both work inside batch
    const b = await ok("aseprite_batch", { ops: [
      { op: "pixel_map", file: obj },
      { op: "animation", file: anim },
    ] });
    assert.equal(b.results.length, 2);
  } finally {
    fake.close();
    await mcp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extension compatibility is judged by a minimum version", async () => {
  const cases = [
    { extension: undefined, warn: true }, // older than 0.4.0 (sends no version)
    { extension: "0.3.9", warn: true },
    { extension: "garbage", warn: true },
    { extension: "0.4.0", warn: false },
    { extension: "0.10.0", warn: false }, // numeric, not string comparison
  ];
  for (const c of cases) {
    const token = randomBytes(24).toString("hex");
    const port = portCounter++;
    const mcp = await startServer(token, port);
    const fake = await fakeAseprite(token, port, () => ({ sprite: false }), c.extension);
    try {
      const st = JSON.parse((await mcp.callTool({ name: "aseprite_status", arguments: {} })).content[0].text);
      assert.equal(st.warning !== undefined, c.warn, JSON.stringify(c) + " -> " + st.warning);
      assert.equal(st.minExtension, "0.4.0");
    } finally {
      fake.close();
      await mcp.close();
    }
  }
});

test("critique sheet, selection, watch mode, ramps and outline", async () => {
  const token = randomBytes(24).toString("hex");
  const port = portCounter++;
  const mcp = await startServer(token, port);
  // 3x2 layer: red, empty, blue / empty, green, empty
  const layerRows = ["ff0000ff" + "00000000" + "0000ffff", "00000000" + "00ff00ff" + "00000000"];
  const fake = await fakeAseprite(token, port, (msg) => {
    const a = msg.args;
    if (msg.cmd === "get_pixels") {
      if (a.rect) return { x: a.rect[0], y: a.rect[1], width: 1, height: 1, frame: 1, rows: ["ff0000ff"] };
      return { x: 0, y: 0, width: 3, height: 2, frame: 1, layer: a.flatten ? undefined : "L", rows: layerRows };
    }
    if (msg.cmd === "selection") return a.mask ? { empty: false, x: 1, y: 0, width: 2, height: 2, mask: ["##", ".#."] } : { empty: false, x: 1, y: 0, width: 2, height: 2 };
    if (msg.cmd === "changes") {
      if (a.reset) return { watching: true, frames: 1 };
      return { frame: 1, changed: 3, x: 4, y: 5, width: 3, height: 1, rows: ["ff0000ff" + "........" + "00000000"] };
    }
    if (msg.cmd === "set_pixels") return { drawn: a.pixels.length };
    return {};
  }, "0.6.0");
  const ok = async (name, args) => {
    const r = await mcp.callTool({ name, arguments: args });
    assert.ok(!r.isError, r.content[0].text);
    return r;
  };
  const json = async (name, args) => JSON.parse((await ok(name, args)).content.at(-1).text);
  try {
    // critique: one PNG, panels side by side
    const r = await ok("aseprite_view", { critique: true, scale: 4 });
    assert.equal(r.content.length, 2);
    const png = Buffer.from(r.content[0].data, "base64");
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    const W = png.readUInt32BE(16), H = png.readUInt32BE(20);
    // 3 panels of 12x8 + one 1x panel of 3x2 + 5 gaps of 4px; height 8 + 2 gaps
    assert.deepEqual([W, H], [12 * 3 + 3 + 4 * 5, 8 + 8]);
    const meta = JSON.parse(r.content[1].text);
    assert.deepEqual(meta, { panels: ["color", "gray", "silhouette", "1x"], scale: 4, rect: [0, 0, 3, 2], colors: 3, frame: 1 });
    assert.equal(fake.cmds.at(-1).args.flatten, true);

    // "selection" as rect
    await ok("aseprite_read_pixels", { rect: "selection" });
    assert.deepEqual(fake.cmds.at(-1).args.rect, [1, 0, 2, 2]);
    await ok("aseprite_clear", { rect: "selection" });
    assert.deepEqual(fake.cmds.at(-1).args, { rect: [1, 0, 2, 2] });
    assert.deepEqual(await json("aseprite_selection", {}), { x: 1, y: 0, w: 2, h: 2 });
    assert.deepEqual((await json("aseprite_selection", { mask: true })).mask, ["##", ".#"]);

    // watch mode: '.' unchanged, '-' erased
    assert.deepEqual(await json("aseprite_changes", { reset: true }), { watching: true, frames: 1 });
    const ch = await json("aseprite_changes", { palette: { R: "#f00", "-": "#123" } });
    assert.deepEqual(ch, { frame: 1, changed: 3, x: 4, y: 5, w: 3, h: 1, palette: { R: "#ff0000", "-": "#00000000" }, rows: ["R.-"] });

    // ramps: dark -> light, base in the middle, saved on request
    const ramp = await json("aseprite_palette", { action: "ramp", ramps: [{ base: "#d63a3a", keys: "abcde" }] });
    assert.deepEqual(Object.keys(ramp), ["a", "b", "c", "d", "e"]);
    assert.equal(ramp.c, "#d63a3a");
    const lum = (h) => { const n = parseInt(h.slice(1, 7), 16); return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255); };
    const ls = Object.values(ramp).map(lum);
    assert.ok(ls.every((v, i) => i === 0 || v > ls[i - 1]), "gets lighter: " + ls);
    const rb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(5, 7), 16)];
    assert.ok(rb(ramp.a)[1] / (rb(ramp.a)[0] + 1) > 58 / 214, "shadows turn cooler");
    // pale colours: the dark steps stay muted instead of turning into saturated orange
    const cream = await json("aseprite_palette", { action: "ramp", ramps: [{ base: "#efe3c2", keys: "abcde" }] });
    for (const k of ["a", "b"]) {
      const n = parseInt(cream[k].slice(1), 16), ch = [n >> 16, (n >> 8) & 255, n & 255];
      assert.ok(Math.max(...ch) - Math.min(...ch) < 70, `cream ${k} ${cream[k]} is too saturated`);
    }

    // outline: selout around the shapes, one set_pixels call
    await ok("aseprite_outline", {});
    let px = fake.cmds.at(-1).args.pixels;
    assert.equal(fake.cmds.at(-1).args.layer, "L");
    assert.deepEqual(px.map(([x, y]) => `${x},${y}`).sort(), ["0,1", "1,0", "2,1"].sort());
    const green = px.find(([x, y]) => x === 2 && y === 1)[2];
    assert.notEqual(green, "#00ff00");
    await ok("aseprite_outline", { style: "solid", color: "#000", position: "inside", rect: [0, 0, 1, 2] });
    px = fake.cmds.at(-1).args.pixels;
    assert.deepEqual(px, [[0, 0, "#000000"]]);
  } finally {
    fake.close();
    await mcp.close();
  }
});

test("new tools explain when the extension is too old", async () => {
  const token = randomBytes(24).toString("hex");
  const port = portCounter++;
  const mcp = await startServer(token, port);
  const fake = await fakeAseprite(token, port, () => ({}), "0.4.0");
  try {
    for (const [name, args] of [["aseprite_selection", {}], ["aseprite_changes", {}], ["aseprite_read_pixels", { rect: "selection" }]]) {
      const r = await mcp.callTool({ name, arguments: args });
      assert.ok(r.isError, name);
      assert.match(r.content[0].text, /needs the MCP Bridge extension 0\.6\.0 or newer \(installed: 0\.4\.0\)/);
    }
    assert.equal(fake.cmds.length, 0, "nothing is sent to an old extension");
  } finally {
    fake.close();
    await mcp.close();
  }
});

test("security limits", async () => {
  const token = randomBytes(24).toString("hex");
  const port = portCounter++;
  const allowed = mkdtempSync(join(tmpdir(), "aseprite-mcp-allowed-"));
  const other = mkdtempSync(join(tmpdir(), "aseprite-mcp-other-"));
  const mcp = await startServer(token, port, { ASEPRITE_MCP_FILE_DIRS: allowed });
  const fake = await fakeAseprite(token, port, (msg) => {
    if (msg.cmd === "set_pixels") return { drawn: msg.args.pixels.length };
    if (msg.cmd === "get_pixels") return { x: 0, y: 0, width: 3, height: 2, frame: 1, rows: ["ff0000ff".repeat(3), "00000000".repeat(3)] };
    if (msg.cmd === "selection") return { empty: false, x: 0, y: 0, width: 200000, height: 1, mask: [".".repeat(199999) + "#"] };
    return {};
  }, "0.6.0");
  const err = async (name, args) => {
    const r = await mcp.callTool({ name, arguments: args });
    assert.ok(r.isError, `${name} ${JSON.stringify(args).slice(0, 80)} should fail`);
    return r.content[0].text;
  };
  try {
    // file: only inside ASEPRITE_MCP_FILE_DIRS, symlinks resolved
    const outside = join(other, "secret.json");
    writeFileSync(outside, JSON.stringify(["SECRETROW"]));
    assert.match(await err("aseprite_pixel_map", { file: outside, palette: { a: "#000" } }), /must be inside/);
    let linked = true;
    try {
      symlinkSync(outside, join(allowed, "link.json"));
    } catch {
      linked = false; // Windows without developer mode cannot create symlinks
    }
    if (linked) {
      assert.match(await err("aseprite_pixel_map", { file: join(allowed, "link.json"), palette: { a: "#000" } }), /must be inside/);
    }
    // characters from a file never show up in errors
    writeFileSync(join(allowed, "rows.json"), JSON.stringify(["SECRETROW"]));
    const msg = await err("aseprite_pixel_map", { file: join(allowed, "rows.json"), palette: { a: "#000" } });
    assert.match(msg, /Characters not in palette: some characters in the file\./);
    assert.doesNotMatch(msg, /"S"|"E"|"C"|"R"|"T"|"O"|"W"/);
    writeFileSync(join(allowed, "anim.json"), JSON.stringify([{ rows: ["XYZ"] }]));
    assert.doesNotMatch(await err("aseprite_animation", { file: join(allowed, "anim.json"), palette: { a: "#000" } }), /"X"/);

    // open/save only image formats with absolute paths
    for (const path of ["/home/user/.bashrc", "/tmp/evil.sh", "relative.png", "/tmp/x.png.json"]) {
      assert.match(await err("aseprite_save", { path, copy: true }), /path must/);
      assert.match(await err("aseprite_open", { path }), /path must/);
    }
    assert.equal(fake.cmds.filter((m) => m.cmd === "save" || m.cmd === "open").length, 0);

    // overly long rows and too many placed pixels are refused
    assert.match(await err("aseprite_pixel_map", { palette: { a: "#000" }, rows: ["a".repeat(5000)] }), /4096|too_big|Too big/i);
    const big = Array.from({ length: 64 }, () => "a".repeat(64));
    const place = Array.from({ length: 70 }, (_, i) => ["s", i, 0]);
    assert.match(await err("aseprite_pixel_map", { palette: { a: "#000" }, stamps: { s: { rows: big } }, place }), /Too many pixels before merging/);

    // critique never builds a huge image
    const r = await mcp.callTool({ name: "aseprite_view", arguments: { critique: true, scale: 64, panels: ["color", "gray", "silhouette", "deutan", "1x"] } });
    assert.ok(!r.isError, r.content[0].text);
    assert.equal(JSON.parse(r.content[1].text).scale, 16);

    // long selection masks are trimmed quickly
    const t0 = Date.now();
    const sel = await mcp.callTool({ name: "aseprite_selection", arguments: { mask: true } });
    assert.ok(!sel.isError);
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  } finally {
    fake.close();
    await mcp.close();
    rmSync(allowed, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
