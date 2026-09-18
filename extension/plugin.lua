-- MCP Bridge for Aseprite (unofficial, not affiliated with Anthropic)
-- Connects Aseprite to the aseprite-mcp server so an AI assistant such as Claude
-- can draw in the open editor. Menu: File > MCP Bridge...

-- Never reuse modules cached by a previously loaded version of this extension
-- (an update still needs an Aseprite restart to take effect reliably)
package.loaded.sha256 = nil
package.loaded.handlers = nil
local S = require "sha256"
local H = require "handlers"

local PROTOCOL = 2
local DEFAULT_PORT = 9123

local prefs          -- plugin.preferences (persisted between sessions)
local dlg            -- bridge window
local ws             -- current WebSocket
local authed = false -- true once the server has proven it knows the token
local serverNonce, clientNonce
local backupDir      -- where the server keeps backup copies (sent with "welcome")
local statusText = "Not connected"
local expanded = false   -- settings shown although connected
local shownCompact = nil -- layout the window currently has
local rebuilding = false
local buildDialog        -- defined below

if _VERSION == "Lua 5.3" then
  -- Lua 5.4 seeds randomly on its own; 5.3 needs help
  math.randomseed(os.time() ~ math.floor(os.clock() * 1000000))
end

local function randomHex(bytes)
  local t = {}
  for i = 1, bytes do t[i] = string.format("%02x", math.random(0, 255)) end
  return table.concat(t)
end

local function trim(s)
  return (tostring(s or ""):gsub("^%s+", ""):gsub("%s+$", ""))
end

local function setStatus(text)
  statusText = text
  if dlg then pcall(function() dlg:modify{ id = "status", text = text } end) end
end

-- Connected: a small window (status + buttons). Otherwise: token, port and options as well.
local function refreshLayout()
  if dlg and shownCompact ~= (authed and not expanded) then buildDialog() end
end

local function send(sock, tbl)
  sock:sendText(json.encode(tbl))
end

local function disconnect()
  authed = false
  if ws then
    local old = ws
    ws = nil
    pcall(function() old:close() end)
  end
end

-- "…/handlers.lua:112: message" -> "message"
local function cleanError(e)
  return (tostring(e):gsub("^[^\n]-%.lua:%d+: ", ""))
end

local function handleCommand(sock, msg)
  local name = msg.cmd
  local handler = (type(name) == "string" and name:sub(1, 1) ~= "_") and H[name] or nil
  local reply
  if type(handler) ~= "function" then
    reply = { id = msg.id, ok = false, error = "Unknown command: " .. tostring(name) }
  else
    local ok, res = pcall(function()
      local args = H._fromJson(msg.args or {})
      H._guard(name, args)
      return handler(args)
    end)
    if ok then
      reply = { id = msg.id, ok = true, result = res or {} }
    else
      reply = { id = msg.id, ok = false, error = cleanError(res) }
    end
    pcall(H._afterCommand, name)
    app.refresh()
  end
  local okSend, err = pcall(send, sock, reply)
  if not okSend then
    pcall(send, sock, { id = msg.id, ok = false, error = "Could not encode reply: " .. tostring(err) })
  end
end

local function handleAuth(sock, msg, token)
  if msg.type == "challenge" then
    if msg.v ~= PROTOCOL then
      setStatus("Protocol mismatch - update the extension or the server")
      disconnect()
      return
    end
    if type(msg.nonce) ~= "string" or #msg.nonce < 16 or #msg.nonce > 128 then return end
    serverNonce = msg.nonce
    clientNonce = randomHex(16)
    send(sock, {
      type = "hello",
      v = PROTOCOL,
      nonce = clientNonce,
      mac = S.hmacHex(token, "client|" .. serverNonce .. "|" .. clientNonce),
      version = tostring(app.version),
      extension = H.VERSION,
    })
    setStatus("Authenticating ...")

  elseif msg.type == "welcome" then
    if not (serverNonce and clientNonce) then return end
    local expected = S.hmacHex(token, "server|" .. clientNonce .. "|" .. serverNonce)
    if S.equals(msg.mac, expected) then
      authed = true
      backupDir = type(msg.autosave) == "string" and msg.autosave or nil
      setStatus("Connected ✓")
      refreshLayout()
    else
      setStatus("Server failed authentication - disconnected")
      disconnect()
      refreshLayout()
    end

  elseif msg.type == "denied" then
    setStatus("Token rejected - check the token and press Connect")
    disconnect()
    refreshLayout()
  end
  -- Anything else before authentication is ignored.
end

local function connect()
  disconnect()
  local token = trim(prefs.token)
  if #token < 16 then
    setStatus("Paste the token first (run: aseprite-mcp token)")
    return
  end
  local port = math.floor(tonumber(prefs.port) or DEFAULT_PORT)

  local sock
  local function onReceive(mt, data, err)
    if sock == nil or sock ~= ws then return end -- stale socket

    if mt == WebSocketMessageType.OPEN then
      authed = false
      serverNonce, clientNonce = nil, nil
      setStatus("Connected, waiting for challenge ...")

    elseif mt == WebSocketMessageType.CLOSE then
      authed = false
      setStatus("Waiting for server on port " .. port .. " ...")

    elseif mt == WebSocketMessageType.ERROR then
      setStatus("Error: " .. tostring(err))

    elseif mt == WebSocketMessageType.TEXT then
      local ok, msg = pcall(json.decode, data)
      if not ok or (type(msg) ~= "table" and type(msg) ~= "userdata") then return end
      if authed then
        if msg.cmd then handleCommand(sock, msg) end
      else
        handleAuth(sock, msg, token)
      end
    end
  end

  sock = WebSocket{
    url = "http://127.0.0.1:" .. port,
    onreceive = onReceive,
    deflate = false,
    minreconnectwait = 1,
    maxreconnectwait = 5,
  }
  ws = sock
  setStatus("Connecting to port " .. port .. " ...")
  sock:connect()
end

-- Backup copies made by the server, newest first; picking one opens it
local function showBackups()
  if not backupDir then
    app.alert("No backup folder yet: connect to the aseprite-mcp server first (or autosave is off).")
    return
  end
  local entries = {}
  for _, d in ipairs(app.fs.listFiles(backupDir)) do
    local dp = app.fs.joinPath(backupDir, d)
    if app.fs.isDirectory(dp) then
      for _, f in ipairs(app.fs.listFiles(dp)) do
        if f:match("%.aseprite$") then
          local stamp = f:gsub("%.aseprite$", "")
          entries[#entries + 1] = { label = d .. "  -  " .. stamp, path = app.fs.joinPath(dp, f), key = stamp }
        end
      end
    end
  end
  if #entries == 0 then
    app.alert("No backup copies in " .. backupDir)
    return
  end
  table.sort(entries, function(a, b) return a.key > b.key end)
  local options = {}
  for i = 1, math.min(#entries, 40) do options[i] = entries[i].label end
  local bd = Dialog{ title = "Backups (newest first)" }
  bd:combobox{ id = "pick", options = options, option = options[1] }
  bd:label{ text = backupDir }
  bd:button{ text = "Open", focus = true, onclick = function()
    for _, e in ipairs(entries) do
      if e.label == bd.data.pick then app.open(e.path); break end
    end
    bd:close()
  end }
  bd:button{ text = "Cancel", onclick = function() bd:close() end }
  bd:show{ wait = false }
end

buildDialog = function()
  local old = dlg and dlg.bounds
  if dlg then
    rebuilding = true
    pcall(function() dlg:close() end)
    rebuilding = false
  end
  local compact = authed and not expanded
  shownCompact = compact
  dlg = Dialog{
    title = "MCP Bridge",
    onclose = function()
      if rebuilding then return end
      disconnect()
      dlg = nil
    end,
  }
  dlg:label{ id = "status", label = "Status:", text = statusText }
  if not compact then
    dlg:separator{ text = "Settings" }
    dlg:entry{
      id = "token", label = "Token:", text = prefs.token or "",
      onchange = function() prefs.token = trim(dlg.data.token) end,
    }
    dlg:number{
      id = "port", label = "Port:", text = tostring(prefs.port or DEFAULT_PORT), decimals = 0,
      onchange = function() prefs.port = math.floor(tonumber(dlg.data.port) or DEFAULT_PORT) end,
    }
    dlg:check{
      id = "allowLua", text = "Allow arbitrary Lua code (aseprite_run_lua)",
      selected = prefs.allowLua == true,
      onclick = function() prefs.allowLua = dlg.data.allowLua == true end,
    }
    dlg:separator{}
    dlg:button{ text = "Connect", onclick = connect }
  end
  dlg:button{ text = "Backups...", onclick = showBackups }
  if authed then
    dlg:button{ text = compact and "Settings..." or "Hide settings", onclick = function()
      expanded = not expanded
      buildDialog()
    end }
  end
  dlg:button{ text = "Disconnect", onclick = function()
    disconnect()
    setStatus("Not connected")
    refreshLayout()
  end }
  dlg:button{ text = "Close", onclick = function() dlg:close() end }
  dlg:show{ wait = false }
  if old then  -- keep the window where the user put it
    pcall(function() dlg.bounds = Rectangle(old.x, old.y, dlg.bounds.width, dlg.bounds.height) end)
  end
end

local function showDialog()
  if dlg then return end
  buildDialog()
  if #trim(prefs.token) >= 16 then connect() end
end

function init(plugin)
  prefs = plugin.preferences
  if prefs.port == nil then prefs.port = DEFAULT_PORT end
  if prefs.allowLua == nil then prefs.allowLua = false end
  H._allowLua = function() return prefs.allowLua == true end

  plugin:newCommand{
    id = "McpBridge",
    title = "MCP Bridge...",
    group = "file_scripts",
    onclick = showDialog,
  }
end

function exit(plugin)
  disconnect()
  -- An open window would keep running the old code after an update
  if dlg then
    local d = dlg
    dlg = nil
    pcall(function() d:close() end)
  end
end
