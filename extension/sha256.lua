-- Pure-Lua SHA-256 and HMAC-SHA256 (Lua 5.3+ integers and bitwise operators).
-- Used for the challenge-response handshake with the aseprite-mcp server.

local M32 = 0xffffffff

local K = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}

local function rotr(x, n)
  return ((x >> n) | (x << (32 - n))) & M32
end

local function sha256(msg)
  local h0, h1, h2, h3 = 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a
  local h4, h5, h6, h7 = 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19

  local len = #msg
  msg = msg .. "\128" .. string.rep("\0", (55 - len) % 64) .. string.pack(">I8", len * 8)

  local w = {}
  for chunk = 1, #msg, 64 do
    for j = 1, 16 do
      w[j] = string.unpack(">I4", msg, chunk + (j - 1) * 4)
    end
    for j = 17, 64 do
      local a, b = w[j - 15], w[j - 2]
      w[j] = (w[j - 16] + (rotr(a, 7) ~ rotr(a, 18) ~ (a >> 3))
              + w[j - 7] + (rotr(b, 17) ~ rotr(b, 19) ~ (b >> 10))) & M32
    end

    local a, b, c, d, e, f, g, h = h0, h1, h2, h3, h4, h5, h6, h7
    for j = 1, 64 do
      local t1 = (h + (rotr(e, 6) ~ rotr(e, 11) ~ rotr(e, 25))
                  + ((e & f) ~ (~e & g)) + K[j] + w[j]) & M32
      local t2 = ((rotr(a, 2) ~ rotr(a, 13) ~ rotr(a, 22))
                  + ((a & b) ~ (a & c) ~ (b & c))) & M32
      h, g, f, e = g, f, e, (d + t1) & M32
      d, c, b, a = c, b, a, (t1 + t2) & M32
    end

    h0 = (h0 + a) & M32; h1 = (h1 + b) & M32; h2 = (h2 + c) & M32; h3 = (h3 + d) & M32
    h4 = (h4 + e) & M32; h5 = (h5 + f) & M32; h6 = (h6 + g) & M32; h7 = (h7 + h) & M32
  end

  return string.pack(">I4I4I4I4I4I4I4I4", h0, h1, h2, h3, h4, h5, h6, h7)
end

local function toHex(s)
  return (s:gsub(".", function(ch) return string.format("%02x", ch:byte()) end))
end

local function xorPad(key, byte)
  return (key:gsub(".", function(ch) return string.char(ch:byte() ~ byte) end))
end

local function hmacHex(key, msg)
  if #key > 64 then key = sha256(key) end
  key = key .. string.rep("\0", 64 - #key)
  return toHex(sha256(xorPad(key, 0x5c) .. sha256(xorPad(key, 0x36) .. msg)))
end

-- Constant-time-ish comparison of two hex strings
local function equals(a, b)
  if type(a) ~= "string" or type(b) ~= "string" or #a ~= #b then return false end
  local diff = 0
  for i = 1, #a do diff = diff | (a:byte(i) ~ b:byte(i)) end
  return diff == 0
end

return {
  sha256Hex = function(s) return toHex(sha256(s)) end,
  hmacHex = hmacHex,
  equals = equals,
}
