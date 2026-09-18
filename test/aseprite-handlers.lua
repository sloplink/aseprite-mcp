-- Integration test for extension/handlers.lua inside a real Aseprite (no UI):
--   aseprite -b --script-param ext=<extension dir> --script test/aseprite-handlers.lua
-- Prints "PASS <name>" / "FAIL <name>: <reason>" per case and "DONE <failures>" at the end.
local ext = app.params.ext or "extension"
local H = dofile(app.fs.joinPath(ext, "handlers.lua"))
local tmp = app.fs.joinPath(app.fs.tempPath, "aseprite-mcp-test-" .. os.time() .. "-" .. math.random(1e6))
app.fs.makeAllDirectories(tmp)

local failures = 0
local function case(name, fn)
  -- close everything so each case starts clean
  while app.sprite do app.sprite:close() end
  local ok, err = pcall(fn)
  if ok then
    print("PASS " .. name)
  else
    failures = failures + 1
    print("FAIL " .. name .. ": " .. tostring(err))
  end
end

local function eq(actual, expected, what)
  if actual ~= expected then
    error((what or "value") .. ": expected " .. tostring(expected) .. ", got " .. tostring(actual), 2)
  end
end

local function fails(fn, pattern)
  local ok, err = pcall(fn)
  if ok then error("expected an error matching '" .. pattern .. "'", 2) end
  if not tostring(err):find(pattern) then error("unexpected error: " .. tostring(err), 2) end
end

-- rows of "rrggbbaa" -> table of rows of 8-char strings
local function px(res, x, y)
  local row = res.rows[y - res.y + 1]
  local i = (x - res.x) * 8
  return row:sub(i + 1, i + 8)
end

case("_fromJson turns Aseprite JSON into plain tables with integers", function()
  local a = H._fromJson(json.decode('{"frame":5,"x":1.5,"ok":true,"rect":[1,2,3,4],"pixels":[[0,1,"#fff"]],"e":[],"o":{}}'))
  eq(type(a), "table"); eq(math.type(a.frame), "integer"); eq(a.x, 1.5); eq(a.ok, true)
  eq(#a.rect, 4); eq(math.type(a.rect[4]), "integer")
  eq(a.pixels[1][3], "#fff"); eq(math.type(a.pixels[1][2]), "integer")
  eq(type(a.e), "table"); eq(next(a.e), nil); eq(next(a.o), nil)
  H.new_sprite{ width = 1, height = 1 }
  fails(function() H.frame(H._fromJson(json.decode('{"action":"delete","frame":5}'))) end, "Frame 5 does not exist")
  local i = H.frame(H._fromJson(json.decode('{"action":"duration","frame":1,"duration":0.1}')))
  eq(i.frameDurations[1], 0.1, "fractional duration survives")
end)

case("info without sprite", function()
  local i = H.info()
  eq(i.sprite, false, "sprite")
  eq(type(i.extension), "string", "extension version")
end)

case("new_sprite rgb with background", function()
  local i = H.new_sprite{ width = 5, height = 3, colorMode = "rgb", background = "#102030" }
  eq(i.width, 5); eq(i.height, 3); eq(i.colorMode, "rgb"); eq(i.frameCount, 1)
  local r = H.get_pixels{}
  eq(px(r, 4, 2), "102030ff", "background pixel")
end)

case("new_sprite indexed gets a usable palette", function()
  local i = H.new_sprite{ width = 4, height = 2, colorMode = "indexed" }
  eq(i.colorMode, "indexed")
  local pal = app.sprite.palettes[1]
  local distinct = {}
  for k = 0, #pal - 1 do distinct[pal:getColor(k).rgbaPixel] = true end
  local n = 0
  for _ in pairs(distinct) do n = n + 1 end
  if n < 8 then error("palette has only " .. n .. " distinct colors") end
end)

case("set_pixels + get_pixels rgb", function()
  H.new_sprite{ width = 4, height = 4 }
  local r = H.set_pixels{ pixels = { { 0, 0, "#ff0000" }, { 3, 3, "#00ff0080" }, { 9, 9, "#fff" }, { -1, 0, "#fff" } } }
  eq(r.drawn, 2, "drawn"); eq(r.skippedOutside, 2, "skipped")
  local g = H.get_pixels{ rect = { -2, -2, 8, 8 } }
  eq(g.x, 0); eq(g.y, 0); eq(g.width, 4); eq(g.height, 4)
  eq(g.layer, "Layer 1", "layer name")
  eq(px(g, 0, 0), "ff0000ff"); eq(px(g, 3, 3), "00ff0080"); eq(px(g, 1, 1), "00000000")
  H.set_pixels{ pixels = { { 0, 0, "#00000000" } } }
  eq(px(H.get_pixels{}, 0, 0), "00000000", "erased")
end)

case("set_pixels in a new frame without cel", function()
  H.new_sprite{ width = 3, height = 3 }
  H.frame{ action = "new", copy = false }
  H.set_pixels{ frame = 2, pixels = { { 2, 2, "#abcdef" } } }
  eq(px(H.get_pixels{ frame = 2 }, 2, 2), "abcdefff")
  eq(px(H.get_pixels{ frame = 1 }, 2, 2), "00000000")
end)

case("indexed drawing maps to palette, never to the transparent index", function()
  H.new_sprite{ width = 3, height = 1, colorMode = "indexed" }
  H.set_pixels{ pixels = { { 0, 0, "#ffffff" }, { 1, 0, "#000000" }, { 2, 0, "#00000000" } } }
  local g = H.get_pixels{}
  eq(px(g, 0, 0), "ffffffff", "white")
  if px(g, 1, 0):sub(7, 8) ~= "ff" then error("black became transparent") end
  eq(px(g, 2, 0), "00000000", "transparent")
end)

case("gray", function()
  H.new_sprite{ width = 2, height = 1, colorMode = "gray" }
  H.set_pixels{ pixels = { { 0, 0, "#808080" } } }
  local g = H.get_pixels{}
  eq(px(g, 0, 0), "808080ff"); eq(px(g, 1, 0), "00000000")
end)

case("get_pixels flatten respects hidden layers and opacity", function()
  H.new_sprite{ width = 2, height = 1 }
  H.set_pixels{ pixels = { { 0, 0, "#ff0000" } } }
  H.layer{ action = "new", name = "top" }
  H.set_pixels{ pixels = { { 1, 0, "#0000ff" } } }
  local g = H.get_pixels{ flatten = true }
  eq(g.layer, nil, "no layer when flattened")
  eq(px(g, 0, 0), "ff0000ff"); eq(px(g, 1, 0), "0000ffff")
  H.layer{ action = "visible", name = "top", visible = false }
  eq(px(H.get_pixels{ flatten = true }, 1, 0), "00000000", "hidden layer")
  eq(px(H.get_pixels{ layer = "top" }, 1, 0), "0000ffff", "hidden layer read directly")
end)

case("get_pixels errors", function()
  H.new_sprite{ width = 200, height = 200 }
  fails(function() H.get_pixels{} end, "too large")
  fails(function() H.get_pixels{ rect = { 300, 0, 5, 5 } } end, "outside the canvas")
  fails(function() H.get_pixels{ frame = 5 } end, "does not exist")
  fails(function() H.get_pixels{ layer = "nope", rect = { 0, 0, 2, 2 } } end, "Layer not found")
end)

case("draw tools", function()
  H.new_sprite{ width = 8, height = 8 }
  H.draw{ tool = "filled_rectangle", points = { { 1, 1 }, { 3, 3 } }, color = "#00ff00" }
  local g = H.get_pixels{}
  eq(px(g, 1, 1), "00ff00ff"); eq(px(g, 3, 3), "00ff00ff"); eq(px(g, 4, 4), "00000000")
  H.draw{ tool = "line", points = { { 0, 7 }, { 7, 7 } }, color = "#ff0000" }
  eq(px(H.get_pixels{}, 5, 7), "ff0000ff", "line")
  H.draw{ tool = "paint_bucket", points = { { 6, 0 } }, color = "#0000ff" }
  g = H.get_pixels{}
  eq(px(g, 6, 0), "0000ffff", "bucket"); eq(px(g, 2, 2), "00ff00ff", "bucket kept rectangle")
end)

case("indexed background and clear", function()
  H.new_sprite{ width = 2, height = 1, colorMode = "indexed", background = "#ffffff" }
  eq(px(H.get_pixels{}, 1, 0), "ffffffff", "background")
  H.clear{ rect = { 0, 0, 1, 1 } }
  local g = H.get_pixels{}
  eq(px(g, 0, 0), "00000000"); eq(px(g, 1, 0), "ffffffff")
end)

case("clear", function()
  H.new_sprite{ width = 4, height = 4, background = "#ffffff" }
  local r = H.clear{ rect = { 0, 0, 2, 2 } }
  eq(r.cleared, true)
  local g = H.get_pixels{}
  eq(px(g, 1, 1), "00000000"); eq(px(g, 2, 2), "ffffffff")
  H.clear{}
  eq(px(H.get_pixels{}, 3, 3), "00000000", "whole layer")
  eq(H.clear{}.cleared, false, "already empty")
end)

case("layers", function()
  H.new_sprite{ width = 2, height = 2 }
  local i = H.layer{ action = "new", name = "a" }
  eq(#i.layers, 2); eq(i.activeLayer, "a")
  i = H.layer{ action = "rename", name = "a", newName = "b" }
  eq(i.layers[2].name, "b")
  i = H.layer{ action = "select", name = "Layer 1" }
  eq(i.activeLayer, "Layer 1")
  i = H.layer{ action = "delete", name = "b" }
  eq(#i.layers, 1)
  fails(function() H.layer{ action = "select", name = "b" } end, "Layer not found")
  fails(function() H.layer{ action = "rename", name = "Layer 1" } end, "newName")
end)

case("frames", function()
  H.new_sprite{ width = 2, height = 2 }
  H.set_pixels{ pixels = { { 0, 0, "#123456" } } }
  local i = H.frame{ action = "new", frame = 1 }
  eq(i.frameCount, 2)
  -- without UI there is no editor, so the active frame cannot change
  if app.isUIAvailable then eq(i.activeFrame, 2) end
  eq(px(H.get_pixels{ frame = 2 }, 0, 0), "123456ff", "copied frame")
  i = H.frame{ action = "duration", frame = 2, duration = 0.25 }
  eq(i.frameDurations[2], 0.25)
  H.frame{ action = "select", frame = 1 }
  fails(function() H.frame{ action = "select", frame = 7 } end, "does not exist")
  fails(function() H.frame{ action = "duration", frame = 2 } end, "duration is missing")
  i = H.frame{ action = "new", frame = 2, copy = false }
  eq(i.frameCount, 3)
  eq(px(H.get_pixels{ frame = 3 }, 0, 0), "00000000", "empty frame")
  i = H.frame{ action = "delete", frame = 3 }
  i = H.frame{ action = "delete", frame = 2 }
  eq(i.frameCount, 1)
  fails(function() H.frame{ action = "delete", frame = 1 } end, "last frame")
end)

case("undo / redo", function()
  H.new_sprite{ width = 2, height = 2 }
  H.set_pixels{ pixels = { { 0, 0, "#ff0000" } } }
  H.set_pixels{ pixels = { { 1, 0, "#ff0000" } } }
  H.history{ action = "undo", steps = 1 }
  local g = H.get_pixels{}
  eq(px(g, 0, 0), "ff0000ff"); eq(px(g, 1, 0), "00000000", "undone")
  H.history{ action = "redo" }
  eq(px(H.get_pixels{}, 1, 0), "ff0000ff", "redone")
end)

case("snapshot", function()
  H.new_sprite{ width = 8, height = 4 }
  H.set_pixels{ pixels = { { 2, 1, "#ff0000" } } }
  local path = app.fs.joinPath(tmp, "view.png")
  local r = H.snapshot{ path = path }
  eq(r.scale, 64); eq(r.imageWidth, 512); eq(r.imageHeight, 256)
  local img = Image{ fromFile = path }
  eq(img.width, 512)
  r = H.snapshot{ path = path, rect = { 2, 1, 2, 2 }, checker = false, scale = 10 }
  eq(r.imageWidth, 20); eq(r.imageHeight, 20); eq(r.rect[1], 2)
  img = Image{ fromFile = path }
  eq(img:getPixel(5, 5), app.pixelColor.rgba(255, 0, 0, 255), "zoomed pixel")
  H.snapshot{ path = path, grid = true, scale = 4 }
  H.new_sprite{ width = 4096, height = 4096 }
  fails(function() H.snapshot{ path = path, scale = 2 } end, "smaller scale")
  fails(function() H.snapshot{ path = path, scale = 64, rect = { 0, 0, 8, 4 }, frame = 3 } end, "does not exist")
end)

case("save, export and open", function()
  H.new_sprite{ width = 3, height = 3 }
  H.set_pixels{ pixels = { { 1, 1, "#00ff00" } } }
  fails(function() H.save{} end, "no file name")
  local file = app.fs.joinPath(tmp, "t.aseprite")
  local png = app.fs.joinPath(tmp, "t.png")
  eq(H.save{ path = file }.saved, file)
  H.save{ path = png, copy = true }
  local gif = app.fs.joinPath(tmp, "t.gif")
  local before = app.preferences.gif.show_alert
  H.save{ path = gif, copy = true }
  eq(app.fs.isFile(gif), true, "gif exported")
  eq(app.preferences.gif.show_alert, before, "gif alert preference restored")
  eq(app.sprite.filename, file, "copy keeps file name")
  H.save{}
  app.sprite:close()
  local i = H.open{ path = png }
  eq(i.width, 3)
  eq(px(H.get_pixels{}, 1, 1), "00ff00ff", "reopened pixel")
  fails(function() H.open{ path = app.fs.joinPath(tmp, "missing.png") } end, "File not found")
end)

case("selection", function()
  H.new_sprite{ width = 8, height = 8 }
  eq(H.selection{}.empty, true, "no selection")
  app.sprite.selection = Selection(Rectangle(1, 2, 3, 2))
  local r = H.selection{}
  eq(r.empty, false); eq(r.x, 1); eq(r.y, 2); eq(r.width, 3); eq(r.height, 2); eq(r.mask, nil)
  eq(H.selection{ mask = true }.rectangular, true, "rectangle needs no mask")
  local sel = Selection(Rectangle(0, 0, 2, 1))
  sel:add(Rectangle(1, 1, 1, 1))
  app.sprite.selection = sel
  r = H.selection{ mask = true }
  eq(r.rectangular, false); eq(r.mask[1], "##"); eq(r.mask[2], ".#")
end)

case("watch mode reports only the artist's edits", function()
  H.new_sprite{ width = 6, height = 4 }
  eq(H.changes{}.watching, true, "first call starts watching")
  eq(H.changes{}.changed, 0, "nothing changed yet")
  -- the assistant's own commands refresh the baseline
  H.set_pixels{ pixels = { { 0, 0, "#ff0000" } } }
  H._afterCommand("set_pixels")
  eq(H.changes{}.changed, 0, "assistant edits are not reported")
  -- an edit that did not come through a command (the artist)
  local cel = app.sprite.cels[1]
  local img = cel.image:clone()
  img:drawPixel(4 - cel.position.x, 2 - cel.position.y, app.pixelColor.rgba(0, 255, 0, 255))
  img:drawPixel(0 - cel.position.x, 0 - cel.position.y, app.pixelColor.rgba(0, 0, 0, 0))
  cel.image = img
  local c = H.changes{ peek = true }
  eq(c.changed, 2); eq(c.x, 0); eq(c.y, 0); eq(c.width, 5); eq(c.height, 3)
  eq(c.rows[1], "00000000" .. string.rep("........", 4), "erased pixel")
  eq(c.rows[3]:sub(33, 40), "00ff00ff", "new pixel")
  eq(H.changes{}.changed, 2, "peek keeps the baseline")
  eq(H.changes{}.changed, 0, "a normal call moves the baseline on")
  H.frame{ action = "new", frame = 1 }
  H._afterCommand("frame")
  eq(H.changes{ frame = 2 }.changed, 0, "new frame is part of the baseline")
  eq(H.changes{ reset = true }.watching, true)
end)

case("sprite ids, listing, selecting and the guard", function()
  local i1 = H.new_sprite{ width = 4, height = 4 }
  local s1 = app.sprite
  local id1 = i1.spriteId
  eq(type(id1), "string"); eq(i1.name, "Sprite")
  eq(H.info().spriteId, id1, "id is stable")
  local i2 = H.new_sprite{ width = 8, height = 2 }
  local id2 = i2.spriteId
  if id1 == id2 then error("two sprites share an id") end
  -- expecting sprite 1 while sprite 2 is active fails; the right one passes
  fails(function() H._guard("set_pixels", { expect = id1 }) end, "ACTIVE_SPRITE_CHANGED")
  H._guard("set_pixels", { expect = id2 })
  H._guard("new_sprite", { expect = id1 })              -- unguarded commands ignore expect
  H._guard("set_pixels", {})                            -- no expectation, no check
  local l = H.sprites{}
  eq(#l.sprites >= 2, true, "both listed"); eq(l.active, id2)
  if app.isUIAvailable then
    local sel = H.sprites{ select = id1 }
    eq(sel.active, id1); eq(app.sprite, s1)
  end
  fails(function() H.sprites{ select = "nope" } end, "No open sprite")
  fails(function() H.sprites{ select = "Sprite" } end, "More than one")
end)

case("run_lua permission", function()
  H._allowLua = function() return false end
  fails(function() H.run_lua{ code = "return 1" } end, "disabled")
  H._allowLua = function() return true end
  local r = H.run_lua{ code = "print('x', 2) return { n = 42 }" }
  eq(r.value.n, 42); eq(r.printed[1], "x\t2")
  fails(function() H.run_lua{ code = "return (" } end, "Syntax error")
  fails(function() H.run_lua{ code = "error('boom')" } end, "boom")
  H._allowLua = function() return false end
end)

case("errors without sprite", function()
  fails(function() H.set_pixels{ pixels = { { 0, 0, "#fff" } } } end, "No active sprite")
  fails(function() H.get_pixels{} end, "No active sprite")
end)

case("invalid color", function()
  H.new_sprite{ width = 1, height = 1 }
  fails(function() H.set_pixels{ pixels = { { 0, 0, "#12" } } } end, "Invalid color")
end)

while app.sprite do app.sprite:close() end
for _, f in ipairs(app.fs.listFiles(tmp)) do os.remove(app.fs.joinPath(tmp, f)) end
app.fs.removeDirectory(tmp)
print("DONE " .. failures)
