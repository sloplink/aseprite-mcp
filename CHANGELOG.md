# Changelog

Server and Aseprite extension are released together and always carry the same version.
After updating the extension, restart Aseprite.

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
- Tool results are compact JSON (fewer tokens).
- Protocol: the extension sends its version in `hello` (backwards compatible).

## 0.2.0

- Earlier release (HMAC-authenticated pairing, `aseprite_run_lua` behind two opt-ins).
