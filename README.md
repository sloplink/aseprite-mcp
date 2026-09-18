
# MCP for Aseprite[Extension]

Let an AI assistant draw live in your running **Aseprite** via the
[Model Context Protocol](https://modelcontextprotocol.io).

> Unofficial community project. Not affiliated with or endorsed by Anthropic or **Igara Studio (Aseprite)**.
> **Use at your own risk** – see [DISCLAIMER.md](DISCLAIMER.md).

A few samples:
<img width="128" height="64" alt="fisch2" src="https://github.com/user-attachments/assets/98fd7591-6159-40c5-ada5-1b538365576f" />
<img width="32" height="64" alt="anime_run" src="https://github.com/user-attachments/assets/d5768ae0-2b19-4942-83ac-dc6e8ee40098" />
<img width="32" height="32" alt="apfelbiss" src="https://github.com/user-attachments/assets/3de9ed38-3c33-475b-a33f-0855eb85b070" />

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

- Aseprite **v1.3 or later** (Windows, macOS or Linux; the Steam version works too)
- Node.js 20+ (some Linux distributions ship older versions – use [nodejs.org](https://nodejs.org) or a version manager)
- An MCP client that runs local (stdio) servers, e.g. Claude Code, Claude Desktop, Cursor,
  VS Code (GitHub Copilot), Windsurf, Gemini CLI or Codex CLI. Clients that only support remote
  (HTTP) servers, such as ChatGPT, cannot use it.

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

The extension only needs an update when a release says so – many releases change just the
server. `aseprite_status` shows both versions and warns if the installed extension is too old.
After updating the extension, **restart Aseprite** (otherwise the old extension code keeps running).

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

Claude Desktop, Cursor, Windsurf, Gemini CLI, Cline and most other clients use this JSON
(`claude_desktop_config.json`, `~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`,
`~/.gemini/settings.json`, …):

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

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "aseprite": { "type": "stdio", "command": "node", "args": ["/absolute/path/to/aseprite-mcp/server.mjs"] }
  }
}
```

Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.aseprite]
command = "node"
args = ["/absolute/path/to/aseprite-mcp/server.mjs"]
```

On Windows write the path as `C:/Users/you/aseprite-mcp/server.mjs` (or with `\\` in JSON).

**Notes for other assistants:** the server sends a usage guide as MCP instructions; if your client
ignores them, ask the assistant to call `aseprite_help` first. If your client cannot show images
from tools, the assistant can still check its work with `aseprite_read_pixels`.

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
| `aseprite_help` | The usage guide, for clients that ignore server instructions |
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
| `aseprite_palette` | Save, list and delete named palettes, collect one from the image, or build hue-shifted shading ramps; use via `paletteName` |
| `aseprite_outline` | Selective outline ("sel-out") or solid outline around/inside the shapes |
| `aseprite_sprites` | Lists the open sprites and switches between them |
| `aseprite_backups` | Lists the automatic backup copies (open one with `aseprite_open` to restore it) |
| `aseprite_selection` | The region the artist selected; most tools also take `rect: "selection"` |
| `aseprite_changes` | Watch mode: only the pixels the artist changed since the last call |
| `aseprite_view` | Returns an upscaled PNG so the assistant can see the image (optionally only a zoomed-in `rect`); `critique: true` gives one small review sheet (colour, grayscale, silhouette, 1x, colour-blindness) |
| `aseprite_run_lua` | Arbitrary Lua – **off by default**, see below |

Most tools work with the MCP Bridge extension 0.4.0 or newer; `aseprite_selection`,
`aseprite_changes` and `rect: "selection"` need 0.6.0, `aseprite_sprites` and the sprite guard need
0.7.0. The server tells you when an update is needed.

**Sprite guard:** the tools remember which sprite they work on (the one the assistant created or
opened, or the active one after `aseprite_status`). If you switch to another tab while the
assistant works, its next call stops with a message instead of drawing into the wrong sprite.

**Automatic backups:** a few seconds after the assistant changes a sprite, a copy is saved as
`.aseprite` (all layers and frames) to `~/.config/aseprite-mcp/autosave`, the newest 5 per sprite.
Your own files are never overwritten, and the sprite keeps its file name and unsaved state – so
unsaved work survives closing Aseprite by mistake. Needs extension 0.7.0.

The server also sends a short usage guide ([instructions.md](instructions.md)) to the MCP
client, so the assistant knows the efficient workflow (pixel map → batch → view once →
fix rows) up front.

Example pixel map:

```json
{ "palette": { "k": "#1a1c2c", "r": "#b13e53", "w": "#f4f4f4" },
  "rows": ["..kk..", ".krrk.", "krwrrk", ".krrk.", "..kk.."], "x": 4, "y": 4 }
```

`.` and space leave a pixel unchanged; map a key to `#00000000` to erase.

Parts that repeat can be defined once as **stamps** and drawn several times with `place`
(optionally flipped) – in one image or across the frames of `aseprite_animation`:

```json
{ "palette": { "k": "#1a1c2c", "w": "#f4f4f4" },
  "stamps": { "eye": { "rows": ["kw", "kk"] } },
  "place": [["eye", 5, 4], ["eye", 9, 4, "h"]] }
```

For art generated by a script, `pixel_map` and `animation` also accept `file`: the absolute
path of a `.json` file with the same data. The rows then don't have to go through the
conversation at all. The server only reads `.json` files and never includes their contents
in error messages.

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
- `aseprite_open` / `aseprite_save` can read and write any path your user can access, but only
  files with an image format Aseprite supports (`.aseprite`, `.png`, `.gif`, …) and absolute paths.
- The `file` option of `aseprite_pixel_map` / `aseprite_animation` only reads `.json` files that
  belong to you and lie in the system temp directory or `/tmp` (or in `ASEPRITE_MCP_FILE_DIRS`); symlinks
  are resolved first, and error messages never contain the file's contents.
- Aseprite stores the token in the extension's preferences
  (`~/.config/aseprite/extensions/aseprite-mcp-bridge/__pref.lua`), which is readable by other
  users of the computer by default. On a shared computer run `chmod 700 ~/.config/aseprite`.
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
| `ASEPRITE_MCP_AUTOSAVE` | `~/.config/aseprite-mcp/autosave` | Folder for automatic backup copies, or `off` |
| `ASEPRITE_MCP_AUTOSAVE_KEEP` | `5` | Backup copies kept per sprite |
| `ASEPRITE_MCP_FILE_DIRS` | system temp directory (+ `/tmp` on macOS/Linux) | Directories the `file` option may read from (separated by `:`, on Windows `;`) |

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
- **Aseprite in a sandbox (e.g. Flatpak Steam)** – it has its own `/tmp`. Images up to 128×128 px are
  sent directly and work anyway; for larger `aseprite_view` calls pass a smaller `rect`. `open`/`save`
  paths must be visible inside the sandbox.
- **The assistant draws badly or wastes tokens** – make sure it read the usage guide (`aseprite_help`).

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
| `test/versions.test.mjs` | server, npm package and CHANGELOG carry the same version; the extension's version fits the server (`MIN_EXTENSION`) | – |

Parts whose requirements are missing are skipped. CI runs everything except the real-Aseprite
test on Node 20–24 (Linux) and on macOS and Windows.

### Releasing

1. Bump the version in `package.json`, `package-lock.json` (`npm install --package-lock-only`)
   and `server.mjs` (`VERSION`), and add a [CHANGELOG.md](CHANGELOG.md) section.
2. Only if the extension changed: set its new version in `extension/package.json` and
   `EXTENSION_VERSION` (`extension/handlers.lua`). If the server now relies on a new or changed
   extension command, also raise `MIN_EXTENSION` (`server.mjs`) to that version – older
   installed extensions then get a warning. Say in the CHANGELOG whether users need to update
   the extension.
3. Run `npm test` locally with Aseprite installed – it fails if these numbers don't fit together.
4. Push a tag `vX.Y.Z`; the release workflow attaches the built extension to a GitHub release.

## License

MIT – see [LICENSE](LICENSE). Written with the help of Claude.
