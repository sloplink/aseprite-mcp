// End-to-end tests: real server.mjs <-> real extension/plugin.lua (in a mocked Aseprite).
// Requires lua5.4 (or lua5.3) and dkjson (Debian/Ubuntu: lua-dkjson). Skips otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

async function startServer(token, port) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(root, "server.mjs")],
    env: { ...process.env, ASEPRITE_MCP_TOKEN: token, ASEPRITE_MCP_PORT: String(port), ASEPRITE_MCP_ALLOW_LUA: "1" },
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
    assert.equal(JSON.parse(r.content[0].text).version, "1.3-mock");

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
