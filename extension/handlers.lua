-- Command handlers executed on behalf of the aseprite-mcp server.
-- Each handler receives the decoded "args" table and returns a result table
-- (or raises an error with a readable message).

local pc = app.pixelColor

local H = {}

-- Keep in sync with extension/package.json
local EXTENSION_VERSION = "0.4.0"
-- Raise when the server starts to rely on a new or changed command here
-- (and raise REQUIRED_API in server.mjs along with it).
local API_LEVEL = 1

H.VERSION = EXTENSION_VERSION
H.API = API_LEVEL

-- Aseprite's json.decode returns userdata objects whose numbers are all floats
-- (5 -> 5.0, even after assignment). Convert to plain Lua tables with integers.
-- Arrays only iterate by index; objects only via pairs.
function H._fromJson(v, depth)
  depth = depth or 0
  local t = type(v)
  if t == "number" then
    -- only whole numbers: Aseprite's math.tointeger(1.5) returns 1
    if v == math.floor(v) and v >= math.mininteger and v <= math.maxinteger then return math.floor(v) end
    return v
  end
  if (t == "table" or t == "userdata") and depth < 8 then
    local o = {}
    if v[1] ~= nil then
      for i = 1, #v do o[i] = H._fromJson(v[i], depth + 1) end
    else
      for k, val in pairs(v) do o[k] = H._fromJson(val, depth + 1) end
    end
    return o
  end
  return v
end

-- Set by plugin.lua: function() -> boolean
H._allowLua = function() return false end

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
local colorCache, cachedColors = {}, 0
local function parseColor(s)
  if colorCache[s] then return colorCache[s] end
  if cachedColors >= 4096 then colorCache, cachedColors = {}, 0 end
  local h = tostring(s):gsub("^#", "")
  if #h == 3 or #h == 4 then h = h:gsub(".", "%0%0") end
  if not (#h == 6 or #h == 8) or h:find("[^%x]") then
    error("Invalid color: " .. tostring(s))
  end
  local c = Color{
    r = tonumber(h:sub(1, 2), 16),
    g = tonumber(h:sub(3, 4), 16),
    b = tonumber(h:sub(5, 6), 16),
    a = (#h == 8) and tonumber(h:sub(7, 8), 16) or 255,
  }
  colorCache[s] = c
  cachedColors = cachedColors + 1
  return c
end

-- Nearest entry of the sprite palette, never the transparent index
local function paletteIndex(sprite, c)
  local pal, skip = sprite.palettes[1], sprite.transparentColor
  local best, bestD = nil, math.huge
  for i = 0, #pal - 1 do
    if i ~= skip then
      local p = pal:getColor(i)
      local dr, dg, db = p.red - c.red, p.green - c.green, p.blue - c.blue
      local d = dr * dr + dg * dg + db * db
      if d < bestD then best, bestD = i, d end
      if d == 0 then break end
    end
  end
  return best or skip
end

local function pixelValue(sprite, c, cache)
  local mode = sprite.colorMode
  if mode == ColorMode.RGB then
    return pc.rgba(c.red, c.green, c.blue, c.alpha)
  elseif mode == ColorMode.GRAY then
    return pc.graya(c.gray, c.alpha)
  else -- INDEXED
    if c.alpha == 0 then return sprite.transparentColor end
    local v = cache[c]
    if not v then
      v = paletteIndex(sprite, c)
      cache[c] = v
    end
    return v
  end
end

local function modeName(m)
  if m == ColorMode.RGB then return "rgb"
  elseif m == ColorMode.GRAY then return "gray"
  elseif m == ColorMode.INDEXED then return "indexed"
  else return tostring(m) end
end

local function findLayer(layers, name)
  for _, l in ipairs(layers) do
    if l.name == name then return l end
    if l.isGroup then
      local f = findLayer(l.layers, name)
      if f then return f end
    end
  end
  return nil
end

local function needSprite()
  local s = app.sprite
  if not s then error("No active sprite. Open one or create one with aseprite_new_sprite.") end
  return s
end

local function getLayer(sprite, name)
  local l
  if name then
    l = findLayer(sprite.layers, name)
    if not l then error("Layer not found: " .. name) end
  else
    l = app.layer
    if not l then error("No active layer.") end
  end
  return l
end

local function frameNumber(sprite, n)
  n = n or (app.frame and app.frame.frameNumber) or 1
  if n < 1 or n > #sprite.frames then
    error("Frame " .. n .. " does not exist (sprite has " .. #sprite.frames .. ").")
  end
  return n
end

local function target(args)
  local sprite = needSprite()
  local layer = getLayer(sprite, args.layer)
  if layer.isGroup then error("'" .. layer.name .. "' is a group, not an image layer.") end
  if layer.isTilemap then error("Tilemap layers are not supported.") end
  return sprite, layer, frameNumber(sprite, args.frame)
end

local function layerList(layers, out, prefix)
  for _, l in ipairs(layers) do
    out[#out + 1] = {
      name = l.name,
      path = prefix .. l.name,
      group = l.isGroup,
      visible = l.isVisible,
      background = l.isBackground,
      opacity = l.opacity,
    }
    if l.isGroup then layerList(l.layers, out, prefix .. l.name .. "/") end
  end
  return out
end

-- rect {x, y, w, h} (or nil = whole canvas) clipped to the canvas -> x, y, w, h
local function clampRect(r, w, h)
  if not r then return 0, 0, w, h end
  local x0, y0 = math.max(0, r[1]), math.max(0, r[2])
  local x1, y1 = math.min(w, r[1] + r[3]), math.min(h, r[2] + r[4])
  if x1 <= x0 or y1 <= y0 then error("Rectangle lies outside the canvas (" .. w .. "x" .. h .. ").") end
  return x0, y0, x1 - x0, y1 - y0
end

local function toPlain(v, depth)
  depth = depth or 0
  local t = type(v)
  if t == "nil" or t == "boolean" or t == "number" or t == "string" then return v end
  if t == "table" and depth < 6 then
    local o = {}
    for k, val in pairs(v) do o[tostring(k)] = toPlain(val, depth + 1) end
    return o
  end
  return tostring(v)
end

-- ---------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------
function H.info()
  local s = app.sprite
  local base = { version = tostring(app.version), extension = EXTENSION_VERSION, api = API_LEVEL, luaAllowed = H._allowLua() }
  if not s then base.sprite = false; return base end
  local frames = {}
  for i, f in ipairs(s.frames) do frames[i] = f.duration end
  base.sprite = true
  base.filename = s.filename
  base.width = s.width
  base.height = s.height
  base.colorMode = modeName(s.colorMode)
  base.frameCount = #s.frames
  base.frameDurations = frames
  base.activeFrame = app.frame and app.frame.frameNumber or 1
  base.activeLayer = app.layer and app.layer.name or nil
  base.layers = layerList(s.layers, {}, "")
  base.paletteSize = #s.palettes[1]
  return base
end

function H.new_sprite(a)
  local mode = ColorMode.RGB
  if a.colorMode == "gray" then mode = ColorMode.GRAY
  elseif a.colorMode == "indexed" then mode = ColorMode.INDEXED end
  local s = Sprite(a.width, a.height, mode)
  -- Scripted sprites start with an all-black palette; use Aseprite's default one
  -- (otherwise every color drawn on an indexed sprite ends up black)
  local ok = pcall(function() app.command.LoadPalette{ preset = "default" } end)
  if not ok or (#s.palettes[1] > 1 and s.palettes[1]:getColor(1).rgbaPixel == s.palettes[1]:getColor(2).rgbaPixel) then
    pcall(function() s:setPalette(Palette{ fromResource = "DB32" }) end)
  end
  if a.background then
    local cel = s.cels[1]
    local img = cel.image:clone()
    img:clear(pixelValue(s, parseColor(a.background), {}))
    cel.image = img
  end
  return H.info()
end

function H.open(a)
  -- app.open would show a modal error in the UI for a missing file
  if not app.fs.isFile(tostring(a.path)) then error("File not found: " .. tostring(a.path)) end
  local s = app.open(a.path)
  if not s then error("Could not open file: " .. tostring(a.path)) end
  return H.info()
end

-- Formats whose export options dialog Aseprite shows before saving
-- ("GIF Options" etc.). It would block the editor until someone closes it.
local OPTION_DIALOG_FORMATS = { "gif", "jpeg", "webp", "tga", "svg", "css" }

local function withoutOptionDialogs(fn)
  local saved = {}
  for _, f in ipairs(OPTION_DIALOG_FORMATS) do
    pcall(function()
      saved[f] = app.preferences[f].show_alert
      app.preferences[f].show_alert = false
    end)
  end
  local ok, err = pcall(fn)
  for f, v in pairs(saved) do
    pcall(function() app.preferences[f].show_alert = v end)
  end
  if not ok then error(err, 0) end
end

function H.save(a)
  local s = needSprite()
  local path = a.path
  if not path or path == "" then
    if not s.filename or s.filename == "" or not app.fs.isFile(s.filename) then
      error("Sprite has no file name yet - please pass a path.")
    end
    path = s.filename
  end
  -- ui=false skips the file chooser; the format option dialogs need the preferences switched off
  withoutOptionDialogs(function()
    if a.copy then
      app.command.SaveFileCopyAs{ ui = false, filename = path }
    elseif path == s.filename then
      app.command.SaveFile{ ui = false }
    else
      app.command.SaveFileAs{ ui = false, filename = path }
    end
  end)
  return { saved = path, copy = a.copy and true or false }
end

function H.set_pixels(a)
  local sprite, layer, fn = target(a)
  local px = a.pixels
  local n, skipped = #px, 0
  local w, h = sprite.width, sprite.height
  local indexCache = {}
  app.transaction("MCP: set pixels", function()
    local cel = layer:cel(fn)
    if not cel then cel = sprite:newCel(layer, fn) end
    -- Expand to full canvas so pixels outside the current cel bounds work too
    local full = Image(sprite.spec)
    full:drawImage(cel.image, cel.position, 255, BlendMode.SRC)
    for i = 1, n do
      local p = px[i]
      local x, y = p[1], p[2]
      if x >= 0 and y >= 0 and x < w and y < h then
        full:drawPixel(x, y, pixelValue(sprite, parseColor(p[3]), indexCache))
      else
        skipped = skipped + 1
      end
    end
    cel.image = full
    cel.position = Point(0, 0)
  end)
  return { drawn = n - skipped, skippedOutside = skipped, layer = layer.name, frame = fn }
end

local brushTypes = { circle = BrushType.CIRCLE, square = BrushType.SQUARE, line = BrushType.LINE }

function H.draw(a)
  local sprite, layer, fn = target(a)
  local pts = {}
  for i = 1, #a.points do pts[i] = Point(a.points[i][1], a.points[i][2]) end
  local col = parseColor(a.color or "#000000")
  app.transaction("MCP: " .. tostring(a.tool), function()
    app.useTool{
      tool = a.tool,
      color = col,
      bgColor = col,
      brush = Brush{ type = brushTypes[a.brushType or "circle"], size = a.size or 1 },
      points = pts,
      layer = layer,
      frame = sprite.frames[fn],
      opacity = a.opacity or 255,
      tolerance = a.tolerance,
      contiguous = a.contiguous,
      freehandAlgorithm = a.pixelPerfect and 1 or 0,
    }
  end)
  return { tool = a.tool, points = #pts, layer = layer.name, frame = fn }
end

function H.clear(a)
  local sprite, layer, fn = target(a)
  local cel = layer:cel(fn)
  if not cel then return { cleared = false, reason = "cel is already empty" } end
  app.transaction("MCP: clear", function()
    if not a.rect and not layer.isBackground then
      sprite:deleteCel(cel)
      return
    end
    local img = cel.image:clone()
    local fill = pixelValue(sprite, layer.isBackground and app.bgColor or Color{ r = 0, g = 0, b = 0, a = 0 }, {})
    if a.rect then
      local r = a.rect
      img:clear(Rectangle(r[1] - cel.position.x, r[2] - cel.position.y, r[3], r[4]), fill)
    else
      img:clear(fill)
    end
    cel.image = img
  end)
  return { cleared = true, layer = layer.name, frame = fn }
end

function H.layer(a)
  local sprite = needSprite()
  if a.action == "new" then
    local l
    app.transaction("MCP: new layer", function()
      l = sprite:newLayer()
      l.name = a.name
    end)
    app.layer = l
  else
    local l = getLayer(sprite, a.name)
    if a.action == "select" then
      app.layer = l
    elseif a.action == "delete" then
      sprite:deleteLayer(l)
    elseif a.action == "rename" then
      if not a.newName then error("newName is missing") end
      l.name = a.newName
    elseif a.action == "visible" then
      l.isVisible = (a.visible ~= false)
    else
      error("Unknown layer action: " .. tostring(a.action))
    end
  end
  return H.info()
end

function H.frame(a)
  local sprite = needSprite()
  local n = frameNumber(sprite, a.frame)
  if a.action == "new" then
    local f
    if a.copy == false then
      f = sprite:newEmptyFrame(n + 1)
    else
      f = sprite:newFrame(n)
    end
    app.frame = f
  elseif a.action == "select" then
    app.frame = n
  elseif a.action == "delete" then
    if #sprite.frames <= 1 then error("Cannot delete the last frame.") end
    sprite:deleteFrame(sprite.frames[n])
  elseif a.action == "duration" then
    if not a.duration then error("duration is missing") end
    sprite.frames[n].duration = a.duration
  else
    error("Unknown frame action: " .. tostring(a.action))
  end
  return H.info()
end

function H.history(a)
  needSprite()
  for _ = 1, (a.steps or 1) do
    if a.action == "undo" then app.undo() else app.redo() end
  end
  return { done = a.action, steps = a.steps or 1 }
end

local MAX_VIEW = 4096 * 4096

function H.snapshot(a)
  local sprite = needSprite()
  local fn = frameNumber(sprite, a.frame)
  local sw, sh = sprite.width, sprite.height
  local rx, ry, w, h = clampRect(a.rect, sw, sh)
  local scale = a.scale or math.max(1, math.min(64, math.floor(512 / math.max(w, h))))
  local W, HH = w * scale, h * scale
  if W * HH > MAX_VIEW then
    error("Image would be " .. W .. "x" .. HH .. " px; use a smaller scale or rect.")
  end

  local flat = Image(sw, sh, ColorMode.RGB)
  flat:drawSprite(sprite, fn)
  if a.rect then
    local crop = Image(w, h, ColorMode.RGB)
    crop:drawImage(flat, Point(-rx, -ry), 255, BlendMode.SRC)
    flat = crop
  end
  if scale > 1 then flat:resize(W, HH) end

  local out = flat
  if a.checker ~= false then
    out = Image(W, HH, ColorMode.RGB)
    out:clear(Color{ r = 255, g = 255, b = 255 })
    local cs = scale >= 4 and math.max(2, scale // 2) or 4
    local grey = Color{ r = 204, g = 204, b = 204 }
    for cy = 0, HH - 1, cs do
      for cx = 0, W - 1, cs do
        if ((cx // cs) + (cy // cs)) % 2 == 0 then
          out:clear(Rectangle(cx, cy, cs, cs), grey)
        end
      end
    end
    out:drawImage(flat)
  end

  if a.grid and scale >= 4 then
    local function darken(x, y)
      local v = out:getPixel(x, y)
      out:drawPixel(x, y, pc.rgba(
        math.floor(pc.rgbaR(v) * 0.7),
        math.floor(pc.rgbaG(v) * 0.7),
        math.floor(pc.rgbaB(v) * 0.7),
        255))
    end
    for x = 0, W - 1, scale do for y = 0, HH - 1 do darken(x, y) end end
    for y = 0, HH - 1, scale do for x = 0, W - 1 do darken(x, y) end end
  end

  out:saveAs(a.path)
  return { frame = fn, scale = scale, rect = { rx, ry, w, h }, imageWidth = W, imageHeight = HH,
           spriteWidth = sw, spriteHeight = sh }
end

local MAX_READ = 16384

-- Reads a rectangle of pixels as rows of "rrggbbaa" hex strings.
-- With a.flatten: the visible, flattened frame; otherwise one layer (a.layer or the active one).
function H.get_pixels(a)
  local sprite = needSprite()
  local fn = frameNumber(sprite, a.frame)
  local w, h = sprite.width, sprite.height
  local x0, y0, rw, rh = clampRect(a.rect, w, h)
  local x1, y1 = x0 + rw, y0 + rh
  if rw * rh > MAX_READ then
    error("Region too large (" .. rw * rh .. " > " .. MAX_READ .. " pixels); pass a smaller rect.")
  end

  local img, mode, layerName
  if not a.flatten then
    local _, layer = target(a)
    layerName = layer.name
    mode = sprite.colorMode
    img = Image(sprite.spec)
    img:clear(mode == ColorMode.INDEXED and sprite.transparentColor or 0)
    local cel = layer:cel(fn)
    if cel then img:drawImage(cel.image, cel.position, 255, BlendMode.SRC) end
  else
    mode = ColorMode.RGB
    img = Image(w, h, ColorMode.RGB)
    img:drawSprite(sprite, fn)
  end

  local pal = sprite.palettes[1]
  local transparent = sprite.transparentColor
  local fmt = string.format
  local cache = {}
  local function hex(v)
    local s = cache[v]
    if s then return s end
    if mode == ColorMode.RGB then
      s = fmt("%02x%02x%02x%02x", pc.rgbaR(v), pc.rgbaG(v), pc.rgbaB(v), pc.rgbaA(v))
    elseif mode == ColorMode.GRAY then
      local g = pc.grayaV(v)
      s = fmt("%02x%02x%02x%02x", g, g, g, pc.grayaA(v))
    else
      if v == transparent or v >= #pal then
        s = "00000000"
      else
        local c = pal:getColor(v)
        s = fmt("%02x%02x%02x%02x", c.red, c.green, c.blue, c.alpha)
      end
    end
    cache[v] = s
    return s
  end

  local rows = {}
  for y = y0, y1 - 1 do
    local parts = {}
    for x = x0, x1 - 1 do parts[#parts + 1] = hex(img:getPixel(x, y)) end
    rows[#rows + 1] = table.concat(parts)
  end
  return { x = x0, y = y0, width = rw, height = rh, frame = fn, layer = layerName, rows = rows }
end

function H.run_lua(a)
  if not H._allowLua() then
    error("run_lua is disabled. Enable 'Allow arbitrary Lua code' in the MCP Bridge window in Aseprite.")
  end
  local chunk, err = load(a.code, "=claude", "t")
  if not chunk then error("Syntax error: " .. tostring(err)) end
  local printed = {}
  local oldPrint = print
  print = function(...)
    local parts = {}
    for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
    printed[#printed + 1] = table.concat(parts, "\t")
  end
  local result
  local ok, e = pcall(function()
    if app.sprite then
      app.transaction("MCP: Lua", function() result = chunk() end)
    else
      result = chunk()
    end
  end)
  print = oldPrint
  if not ok then error(e, 0) end
  return { value = toPlain(result), printed = printed }
end

return H
