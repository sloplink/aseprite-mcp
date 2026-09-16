# MCP for Aseprite[Extension]

Let an AI assistant such as **Claude** draw live in your running **Aseprite** via the
[Model Context Protocol](https://modelcontextprotocol.io).

> Unofficial community project. Not affiliated with or endorsed by Anthropic or Igara Studio.
> **Use at your own risk** – see [DISCLAIMER.md](DISCLAIMER.md).

```
MCP client (e.g. Claude Code) ⇄ stdio ⇄ aseprite-mcp ⇄ WebSocket 127.0.0.1 ⇄ Aseprite + MCP Bridge extension
```

The assistant can create sprites, set exact pixels, use Aseprite's tools (line, rectangle,
ellipse, bucket, curve, freehand …), manage layers and animation frames, undo/redo, and
**look at its own result** as an upscaled PNG to iterate on it. Every change lands in
Aseprite's undo history.

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
| `aseprite_set_pixels` | Set exact pixels (one undo step) |
| `aseprite_draw` | Use a tool: pencil, line, rectangle, ellipse, paint_bucket, curve, polygon … |
| `aseprite_clear` | Clear a layer or a rectangle |
| `aseprite_layer`, `aseprite_frame` | Layers and animation frames |
| `aseprite_history` | Undo / redo |
| `aseprite_view` | Returns an upscaled PNG so the assistant can see the image |
| `aseprite_run_lua` | Arbitrary Lua – **off by default**, see below |

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

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ASEPRITE_MCP_PORT` | `9123` | WebSocket port (also set it in the MCP Bridge window) |
| `ASEPRITE_MCP_ALLOW_LUA` | unset | `1` registers `aseprite_run_lua` |
| `ASEPRITE_MCP_TIMEOUT` | `15000` | Per-command timeout in ms |
| `ASEPRITE_MCP_TOKEN` | – | Use this token instead of the token file |
| `ASEPRITE_MCP_TOKEN_FILE` | see above | Token file location |

Example with Claude Code:

```sh
claude mcp add --scope user --env ASEPRITE_MCP_ALLOW_LUA=1 aseprite -- node /absolute/path/to/aseprite-mcp/server.mjs
```

## Troubleshooting

- **“Aseprite is not connected”** – Is the MCP Bridge window open and showing *Connected ✓*?
- **“Token rejected”** – Run `node server.mjs token` and paste the value again.
- **Stuck on “Waiting for server”** – Is your MCP client running? In Claude Code, `/mcp` shows the server status.
- **Two MCP client sessions at once** – only the first one gets the port.
- Aseprite may ask for permission the first time the extension opens a network connection; allow it.

## Development

```sh
npm test         # end-to-end tests: real server ⇄ real plugin.lua in a mocked Aseprite
npm run build    # creates dist/aseprite-mcp-bridge.aseprite-extension
```

The tests need `lua5.4` (or 5.3) and the `dkjson` Lua module
(Debian/Ubuntu: `lua-dkjson`, otherwise `luarocks install dkjson`); they are skipped otherwise.

## License

MIT – see [LICENSE](LICENSE). Written with the help of Claude.
