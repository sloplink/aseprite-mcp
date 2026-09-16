-- Test harness: runs extension/plugin.lua outside Aseprite with mocked globals.
-- Line protocol on stdin:  OPEN | CLOSE | TEXT <json> | ALLOWLUA <true|false> | TOKEN <tok> | PORT <n> | CONNECT
-- Output on stdout:        CONNECT <url> | SEND <json> | STATUS <text> | CLOSED
local ext = arg[1] or "extension"
package.path = ext .. "/?.lua;/usr/share/lua/5.4/?.lua;/usr/share/lua/5.3/?.lua;" .. package.path
local dkjson = require "dkjson"

local function out(s) io.write(s, "\n"); io.flush() end

json = {
  decode = function(s) local v = dkjson.decode(s); if v == nil then error("bad json") end; return v end,
  encode = function(t) return dkjson.encode(t) end,
}
WebSocketMessageType = { TEXT = 1, BINARY = 2, OPEN = 3, CLOSE = 4, ERROR = 5 }
ColorMode = { RGB = 0, GRAY = 1, INDEXED = 2 }
BrushType = { CIRCLE = 0, SQUARE = 1, LINE = 2 }
BlendMode = { NORMAL = 0, SRC = 1 }
app = { sprite = nil, version = "1.3-mock", refresh = function() end, pixelColor = {} }

local current
function WebSocket(opts)
  local sock = { opts = opts }
  function sock:connect() current = self; out("CONNECT " .. opts.url) end
  function sock:close() out("CLOSED") end
  function sock:sendText(...) out("SEND " .. table.concat({ ... })) end
  return sock
end

function Dialog(opts)
  local d = { data = {} }
  function d:modify(t) if t.id == "status" then out("STATUS " .. t.text) end end
  function d:label() end
  function d:separator() end
  function d:entry() end
  function d:number() end
  function d:check() end
  function d:button() end
  function d:show() end
  function d:close() if opts.onclose then opts.onclose() end end
  return d
end

local prefs = {}
local command
local plugin = {
  preferences = prefs,
  newCommand = function(_, t) command = t end,
}

dofile(ext .. "/plugin.lua")
init(plugin)

for line in io.lines() do
  local cmd, rest = line:match("^(%S+)%s?(.*)$")
  if cmd == "TOKEN" then prefs.token = rest
  elseif cmd == "PORT" then prefs.port = tonumber(rest)
  elseif cmd == "ALLOWLUA" then prefs.allowLua = (rest == "true")
  elseif cmd == "CONNECT" then command.onclick()
  elseif cmd == "OPEN" then current.opts.onreceive(WebSocketMessageType.OPEN, "", "")
  elseif cmd == "CLOSE" then current.opts.onreceive(WebSocketMessageType.CLOSE, "", "")
  elseif cmd == "TEXT" then current.opts.onreceive(WebSocketMessageType.TEXT, rest, "")
  end
end
