# MCP for Aseprite[Extension]

Let an AI assistant draw live in your running **Aseprite** via the
[Model Context Protocol](https://modelcontextprotocol.io).

> Unofficial community project. Not affiliated with or endorsed by Anthropic or **Igara Studio (Aseprite)**.
> **Use at your own risk** – see [DISCLAIMER.md](DISCLAIMER.md).

```
MCP client ⇄ stdio ⇄ aseprite-mcp ⇄ WebSocket 127.0.0.1 ⇄ Aseprite + MCP Bridge extension
```

The assistant can create sprites, set exact pixels, use Aseprite's tools (line, rectangle,
ellipse, bucket, curve, freehand …), manage layers and animation frames, undo/redo, and
**look at its own result** as an upscaled PNG to iterate on it. Every change lands in
Aseprite's undo history.

Drawing is designed to be **cheap in tokens**: whole sprites are sent as a palette plus
text rows, several steps fit into one call, and pixels can be read back in the same
text format.

> Unofficial community project. Not affiliated with or endorsed by Anthropic or Igara Studio.

## Requirements

- Aseprite **v1.3 or later**
- Node.js 18+
- An MCP client that runs local (stdio) servers, e.g. [Claude Code](https://code.claude.com/docs)

## Installation

### 1. Server

```sh
git clone https://github.com/sloplink/aseprite-mcp
cd aseprite-mcp
npm install
``` 

### 2. Aseprite extension

Download `aseprite-mcp-bridge.aseprite-extension` from the
[releases](https://github.com/sloplink/aseprite-mcp/releases) (or build it with `npm run build`),
then in Aseprite: **Edit › Preferences › Extensions › Add Extension**.

Server and extension share one version number – always update both together, then
**restart Aseprite** (otherwise the old extension code keeps running).
`aseprite_status` shows both versions and warns if they differ.

### 3. Pairing token

Server and extension authenticate each other with a shared secret. Print it with:

```sh
node server.mjs token
```

In Aseprite open **File › MCP Bridge…** and paste the token into the *Token* field.
It is remembered between sessions. `node server.mjs token --new` rotates it.

### 4. Register the server with your MCP client

Claude Code:

```sh
claude mcp add --scope user aseprite -- node /absolute/path/to/aseprite-mcp/server.mjs
```

Other clients (JSON config):

```json
{
  "mcpServers": {
    "aseprite": {
      "command": "node",
      "args": ["/absolute/path/to/aseprite-mcp/server.mjs"]
    }
  }
}
```

## Usage

1. Start your MCP client (this starts the server).
2. In Aseprite open **File › MCP Bridge…** and press **Connect**. Keep the window open;
   it shows *Connected ✓* once both sides have verified the token.
3. Ask, for example: *“Create a 32×32 sprite and draw a pixel-art mushroom. Look at the
   result and improve it.”*

The order of steps 1 and 2 does not matter; the bridge reconnects automatically.

## Tools

| Tool | Purpose |
|---|---|
| `aseprite_status` | Connection and sprite info (size, layers, frames) |
| `aseprite_new_sprite`, `aseprite_open`, `aseprite_save` | Create, open, save or export |
| `aseprite_pixel_map` | Draw exact pixels from a palette + text rows – the cheapest way to draw (~10× less input than `set_pixels`) |
| `aseprite_set_pixels` | Set a few exact pixels (one undo step) |
| `aseprite_draw` | Use a tool: pencil, line, rectangle, ellipse, paint_bucket, curve, polygon … |
| `aseprite_clear` | Clear a layer or a rectangle |
| `aseprite_layer`, `aseprite_frame` | Layers and animation frames |
| `aseprite_history` | Undo / redo |
| `aseprite_batch` | Run several operations in one call |
| `aseprite_read_pixels` | Read pixels back as palette + text rows (same format as `pixel_map`) |
| `aseprite_copy` | Copy or mirror a region to another position, layer or frame |
| `aseprite_animation` | Draw several frames in one call (creates missing frames, frames can be deltas) |
| `aseprite_palette` | Save, list and delete named palettes, or collect one from the image; use via `paletteName` |
| `aseprite_view` | Returns an upscaled PNG so the assistant can see the image (optionally only a zoomed-in `rect`) |
| `aseprite_run_lua` | Arbitrary Lua – **off by default**, see below |

The server also sends a short usage guide ([instructions.md](instructions.md)) to the MCP
client, so the assistant knows the efficient workflow (pixel map → batch → view once →
fix rows) up front.

Example pixel map:

```json
{ "palette": { "k": "#1a1c2c", "r": "#b13e53", "w": "#f4f4f4" },
  "rows": ["..kk..", ".krrk.", "krwrrk", ".krrk.", "..kk.."], "x": 4, "y": 4 }
```

`.` and space leave a pixel unchanged; map a key to `#00000000` to erase.

## Security

- The server listens on `127.0.0.1` only.
- Both sides prove knowledge of the token with an HMAC-SHA256 challenge-response on every
  connection. Unauthenticated clients are dropped, and the extension ignores all commands
  from a server that fails the check. The token itself is never sent over the socket.
- The token file is created with mode `600` in `~/.config/aseprite-mcp/token`
  (or `$XDG_CONFIG_HOME`).
- `aseprite_run_lua` needs **two** opt-ins: the server must be started with
  `ASEPRITE_MCP_ALLOW_LUA=1`, **and** *Allow arbitrary Lua code* must be ticked in the
  MCP Bridge window. Only enable it if you trust what your assistant is doing.
- `aseprite_open` / `aseprite_save` can read and write any path your user can access.
- `aseprite_palette` stores palettes in `~/.config/aseprite-mcp/palettes.json`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ASEPRITE_MCP_PORT` | `9123` | WebSocket port (also set it in the MCP Bridge window) |
| `ASEPRITE_MCP_ALLOW_LUA` | unset | `1` registers `aseprite_run_lua` |
| `ASEPRITE_MCP_TIMEOUT` | `15000` | Per-command timeout in ms |
| `ASEPRITE_MCP_TOKEN` | – | Use this token instead of the token file |
| `ASEPRITE_MCP_TOKEN_FILE` | see above | Token file location |
| `ASEPRITE_MCP_PALETTE_FILE` | `~/.config/aseprite-mcp/palettes.json` | Where `aseprite_palette` stores palettes |

Example with Claude Code:

```sh
claude mcp add --scope user --env ASEPRITE_MCP_ALLOW_LUA=1 aseprite -- node /absolute/path/to/aseprite-mcp/server.mjs
```

## Troubleshooting

- **“Aseprite is not connected”** – Is the MCP Bridge window open and showing *Connected ✓*?
- **“Token rejected”** – Run `node server.mjs token` and paste the value again.
- **Stuck on “Waiting for server”** – Is your MCP client running? In Claude Code, `/mcp` shows the server status.
- **Two MCP client sessions at once** – only the first one gets the port.
- **“extension is outdated” / version warning in `aseprite_status`** – install the extension
  from the same release as the server and restart Aseprite.
- **New tools missing in the assistant** – restart the MCP client (Claude Code: `/mcp` → reconnect).
- Aseprite may ask for permission the first time the extension opens a network connection; allow it.

## Development

```sh
npm test         # all tests
npm run build    # creates dist/aseprite-mcp-bridge.aseprite-extension
```

The test suite has three parts:

| File | What it checks | Needs |
|---|---|---|
| `test/e2e.test.mjs` | real server ⇄ real `plugin.lua` in a mocked Aseprite; server tools against a fake Aseprite | `lua5.4` (or 5.3) + `dkjson` (Debian/Ubuntu: `lua-dkjson`, otherwise `luarocks install dkjson`) for the plugin part |
| `test/aseprite.test.mjs` | every extension handler inside a real Aseprite in batch mode (`aseprite -b`) | Aseprite; found automatically (PATH, Steam, /Applications) or via `ASEPRITE=/path/to/aseprite` |
| `test/versions.test.mjs` | server, npm package, extension and CHANGELOG carry the same version | – |

Parts whose requirements are missing are skipped. CI runs everything except the real-Aseprite
test on Node 18–24.

### Releasing

1. Bump the version in `package.json`, `package-lock.json` (`npm install --package-lock-only`),
   `extension/package.json`, `server.mjs` (`VERSION`) and `extension/handlers.lua`
   (`EXTENSION_VERSION`), and add a [CHANGELOG.md](CHANGELOG.md) section – `npm test` fails if
   any of them differ.
2. Run `npm test` locally with Aseprite installed.
3. Push a tag `vX.Y.Z`; the release workflow attaches the built extension to a GitHub release.

## License

MIT – see [LICENSE](LICENSE). Written with the help of Claude.
