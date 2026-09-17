# Disclaimer – Use at Your Own Risk

aseprite-mcp and the MCP Bridge extension are provided **"as is", without warranty of any kind**,
as stated in the [MIT License](LICENSE). By using this software you accept the following.

## No affiliation

This is an unofficial community project. It is not affiliated with, endorsed by, or supported by
Anthropic, Igara Studio (the makers of Aseprite), or any other company whose products are mentioned.
All trademarks belong to their respective owners.

## Your files and your work

- The AI assistant acts on your open sprites **without asking for confirmation** on each step. It can
  draw over, clear, or delete layers, frames, and pixels.
- `aseprite_save` and `aseprite_open` can read and **overwrite any file your user account can access**.
- `aseprite_palette` writes saved palettes to `~/.config/aseprite-mcp/palettes.json`.
- The `file` option of `aseprite_pixel_map` / `aseprite_animation` reads any `.json` file your user
  account can access. Only drawing data is used, and error messages never include the file's contents.
- Changes made in Aseprite appear in the undo history, but saved files cannot be undone that way.

**Save your work and keep backups before connecting an assistant.** The authors are not responsible
for lost, damaged, or overwritten files.

## Arbitrary code

When `aseprite_run_lua` is enabled, the assistant can run any Lua code inside Aseprite, with the same
permissions as Aseprite itself. Only enable it if you understand and accept that risk, and turn it off
when you don't need it.

## Security

- The pairing token protects the connection between server and extension. Keep it private. If you
  think it has leaked, run `node server.mjs token --new` and enter the new token in Aseprite.
- The connection is limited to `127.0.0.1`, but other software running under your user account may
  still be able to read the token file or interfere with the process.
- This project has not been independently audited.

## Data sent to your AI provider

Everything the tools return – sprite information, file paths, the rendered images from
`aseprite_view` and the pixel data from `aseprite_read_pixels` and `aseprite_changes` (what you drew
yourself) – is passed to your MCP client
and, from there, to your AI provider. Their terms and
privacy policy apply. Do not use this with artwork or files you are not allowed to share.

## Generated content

You are responsible for how you use anything created with the help of an AI assistant, including
checking that it does not infringe on anyone else's rights.

## AI-assisted development

Large parts of this project were written with the help of an AI assistant. The code has automated
tests, but it may still contain bugs. Please report problems in the
[issue tracker](https://github.com/sloplink/aseprite-mcp/issues).

---

If you do not agree with these terms, do not use this software.
