Aseprite MCP: draw pixel art live in the user's Aseprite. Coordinates are 0-based, (0,0) = top-left, x → right, y → down.

## Efficient workflow (few calls, few tokens)
1. `aseprite_status` once (skip if you just created the sprite; every layer/frame/new_sprite call already returns the status).
2. `aseprite_new_sprite` — keep it small: 16×16, 24×24 or 32×32 is typical pixel art. Bigger = more tokens.
3. Draw the image with **`aseprite_pixel_map`**: a palette of one-character keys plus one string per row. This is by far the cheapest way to place many exact pixels (about 1 token per 2–4 pixels instead of ~10 per pixel with `aseprite_set_pixels`). Draw a whole sprite, or a region with `x`/`y` offset.
4. Parts that repeat (in one image or across animation frames): define them once as `stamps` and draw them with `place`.
5. Generated art (you computed the rows with a script): write the data to a `.json` file and pass `file` to `aseprite_pixel_map` / `aseprite_animation` instead of pasting it – the rows then cost no tokens at all.
6. Use `aseprite_batch` to combine several steps (layer changes, shapes, maps, fills) into ONE call.
7. Check once: `aseprite_view` with `critique: true` shows colour, grayscale (values), silhouette (readability) and true size in ONE small image – better for judging than a big view. Then fix only the rows that are wrong (pixel_map with `x`/`y` offset). Don't re-view after every small change.
8. Need exact colors or want to edit an existing image? `aseprite_read_pixels` (optionally with `rect` and your palette) returns the same palette + rows format — edit the rows and send them back with `aseprite_pixel_map`.

## When to use what
- Many exact pixels / whole sprite → `aseprite_pixel_map`
- A handful of scattered pixels → `aseprite_set_pixels`
- Large geometric shapes, outlines, fills → `aseprite_draw` (line, filled_rectangle, filled_ellipse, paint_bucket …); 2 points for line/rectangle/ellipse (start, end corner, inclusive)
- Repeat a step for several frames/layers → `aseprite_batch`
- Exact colors of a region, copying/modifying existing art → `aseprite_read_pixels` (text; for a quick visual check use `aseprite_view`)
- Symmetric sprites, repeated parts, mirroring → `aseprite_copy` (draw one half, then rect=that half, flip='h', x=other half)
- Animation → `aseprite_animation`: all frames in one call; new frames copy the previous one, so give only the changed rows (x/y offset)
- Check a small detail → `aseprite_view` with `rect` (zoomed in) instead of the whole image
- Same colors again (other sprite/session) → save once with `aseprite_palette`, then pass `paletteName` instead of the palette (`list` shows saved ones)
- Shading colours → `aseprite_palette` action `ramp` (hue-shifted, dark→light keys) instead of guessing hex values
- Outline → draw flat shapes, then `aseprite_outline` (selective outline by default) instead of drawing outline pixels
- "this part", "here" → `rect: "selection"` or `aseprite_selection`; drawing together → `aseprite_changes` (first call starts watching, later calls return only the artist's edits)
- Mistake → `aseprite_history` undo (each tool call and each batch op is its own undo step)

## pixel_map format
```
palette: {"k":"#1a1c2c","r":"#b13e53","w":"#f4f4f4"}
rows: ["..kk..",
       ".krrk.",
       "krwrrk"]
```
`.` and space = leave pixel unchanged. To erase, map a key to `#00000000`. Rows may differ in length; missing chars are left unchanged.

## Stamps and files
```
stamps: {"eye": {"rows": ["kw", "kk"]}, "leaf": {"rows": [".g", "gg"], "palette": {"g": "#38b764"}}}
place:  [["eye", 5, 4], ["eye", 9, 4, "h"], ["leaf", 0, 10, "v"]]
```
- `place` entries are `[name, x, y]` or `[name, x, y, flip]` with flip `h`, `v` or `hv`; x/y are relative to the map's x/y. Stamps are drawn after `rows`, in order; later pixels win.
- A stamp's own palette is added to (and overrides) the shared palette.
- `aseprite_animation`: define `stamps` once, give each frame its own `place` (e.g. the head with a different y for a bobbing run cycle) plus the rows that really differ.
- `file`: absolute path of a `.json` file. For `pixel_map` an array of rows or `{rows, palette, x, y, stamps, place}`; for `animation` an array of frames or `{frames, palette, stamps, duration}`. Arguments passed directly override the file.

## Pixel-art tips
- Pick a limited palette first (4–16 colors): dark outline, 2–3 shades per material, 1 highlight.
- Plan the silhouette, then shading (light from top-left), then highlights. Avoid pure black outlines on colored areas — use a dark shade of the fill color.
- Use layers for separable parts (e.g. "outline", "color", "background") only when useful; one layer is fine for small sprites.
- Animation: `aseprite_animation` with frame 1 as the full image and later entries as small deltas, or with stamps for the parts that only move; set `duration` (seconds) once for all frames.
- Save with `aseprite_save` (path ending .aseprite, or copy=true with .png/.gif to export).
