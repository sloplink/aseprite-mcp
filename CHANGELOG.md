# Changelog

Releases are versioned by the server. The Aseprite extension has its own version and only
changes when its code changes; `aseprite_status` warns when the installed extension is too
old for the server. After updating the extension, restart Aseprite.

## 0.6.0

Needs the MCP Bridge extension **0.6.0** for `aseprite_selection`, `aseprite_changes` and
`rect: "selection"`; everything else still works with extension 0.4.0.

### Added
- `aseprite_view` with `critique: true`: one small sheet with colour, grayscale, silhouette,
  true 1x size and optionally a colour-blindness (deutan) panel, for self-review.
- `aseprite_selection` and `rect: "selection"` (read_pixels, view, clear, copy, outline,
  palette from_image): work on whatever the artist has selected.
- `aseprite_changes`: watch mode – returns only the pixels the artist changed since the last
  call, as a pixel map (`.` unchanged, `-` erased).
- `aseprite_palette` action `ramp`: hue-shifted shading ramps from base colours.
- `aseprite_outline` (also in `aseprite_batch`): selective outline ("sel-out") or a solid
  outline, outside or inside the shapes.
- Smaller tool list (~2,700 characters less per session): integer and colour checks are done by
  the server instead of being repeated in every schema.
- Compatibility: tool schemas no longer use tuples, `const` or `propertyNames` (rejected by
  some MCP clients such as Gemini); new `aseprite_help` returns the usage guide for clients that
  ignore server instructions; `aseprite_view` is rendered by the server for images up to
  128×128 px, so it also works when Aseprite runs in a sandbox with its own `/tmp`.
- Security: `file` only reads your own `.json` files from the temp directory or
  `ASEPRITE_MCP_FILE_DIRS` and never repeats their characters in errors; `aseprite_open` /
  `aseprite_save` only accept absolute paths with image formats; rows are limited to 4096
  characters; the critique sheet is capped in size; GitHub Actions are pinned to commits.
- Ramps and selective outlines are computed in OKLCH (perceptual lightness), so pale colours
  get muted shadows instead of saturated orange, and yellow shadows turn warm, not green.

## 0.5.0

Server-only release: the MCP Bridge extension stays at **0.4.0** – no need to reinstall it.

### Changed
- Server and extension are versioned separately. The server only warns when the installed
  extension is older than the version it needs (currently 0.4.0), so server-only releases
  work with the installed extension.

### Added
- Stamps: `aseprite_pixel_map` and `aseprite_animation` accept `stamps` (reusable pixel maps)
  and `place` (`[name, x, y, flip?]`), so repeated parts are sent only once.
- `file`: `aseprite_pixel_map` and `aseprite_animation` can read their drawing data from a
  `.json` file, so generated art does not have to be pasted into the conversation.

## 0.4.0

Includes everything since 0.2.0 (0.3.0 was never released).

### Added
- `aseprite_read_pixels`: read pixels back in the `pixel_map` format (palette + text rows),
  from one layer or the visible frame, optionally only a rectangle.
- `aseprite_copy`: copy or mirror (`flip`) a region to another position, layer or frame.
- `aseprite_animation`: draw several frames in one call; missing frames are created,
  later frames can be deltas of the previous one.
- `aseprite_palette`: save, list and delete named palettes, or collect one from the image.
  `paletteName` works in `pixel_map`, `read_pixels` and `animation`.
- `aseprite_view` takes a `rect` to zoom into a detail.
- `aseprite_pixel_map` and `aseprite_batch` (all drawing operations in one call).
- The server sends usage instructions (`instructions.md`) to the MCP client.
- `aseprite_status` reports the server and extension version and warns when they differ.
- `aseprite_frame` action `new` accepts `frame` (insert after that frame).
- Integration tests that run the extension handlers inside a real Aseprite (`aseprite -b`).

### Fixed
- Indexed sprites: new sprites got an all-black palette, so every drawn color became black;
  colors are now matched against the sprite palette and never map to the transparent index.
- Indexed sprites: `new_sprite` background and `clear` used the wrong pixel value.
- `aseprite_view` and `aseprite_frame` report a clear error for frames that do not exist.
- `aseprite_open` no longer opens a modal error dialog in Aseprite for missing files.
- `aseprite_save` no longer blocks on export option dialogs (e.g. "GIF Options");
  the user's "don't show again" settings are left unchanged.
- Numbers from the server are passed to the handlers as integers where they are whole
  (error messages said "Frame 5.0"); fractional values such as durations stay intact.
- Error messages no longer start with the Lua source location.

### Changed
- Requires Node.js 20 or newer (Node.js 18 is end-of-life).
- Tool results are compact JSON (fewer tokens).
- Protocol: the extension sends its version in `hello` (backwards compatible).

## 0.2.0

- Earlier release (HMAC-authenticated pairing, `aseprite_run_lua` behind two opt-ins).
