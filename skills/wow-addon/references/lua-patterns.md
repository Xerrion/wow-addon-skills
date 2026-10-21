# WoW Lua Patterns and Idioms

## 1. Namespace Pattern

Every addon file receives the addon name and a shared private table as varargs:

```lua
local ADDON_NAME, ns = ...
```

Modules attach as sub-tables on `ns` to share state across files without touching `_G`:

```lua
-- Config.lua
local _, ns = ...
ns.Config = { defaults = { scale = 1.0, alpha = 0.8 } }

-- Utils.lua
local _, ns = ...
ns.Utils = {}
function ns.Utils.Round(value, decimals)
    local mult = 10 ^ (decimals or 0)
    return math.floor(value * mult + 0.5) / mult
end
```

LoadOnDemand companion addons sometimes expose a single global bridge of the form `MyAddonNS = ns` to publish their namespace to other addons. Beyond that bridge, addon state in raw globals is rare and would leak across the shared `_G` namespace.

## 2. Global Caching

Lua local lookups are faster than global table lookups, so addons often cache APIs at file scope:

```lua
local CreateFrame, GetTime = CreateFrame, GetTime
local GetSpellInfo = C_Spell.GetSpellInfo
local UnitHealth, UnitName = UnitHealth, UnitName
local pairs, ipairs, type = pairs, ipairs, type
local tinsert, tremove = table.insert, table.remove
local format, match = string.format, string.match
```

Caching at file scope happens once at load time. APIs called from `OnUpdate` or other hot paths are the most common targets.

## 3. SavedVariables

SavedVariables are declared in the `.toc`; the matching global is created before `ADDON_LOADED` fires:

```toc
## SavedVariables: MyAddonDB
## SavedVariablesPerCharacter: MyAddonCharDB
```

A common form is to seed defaults and migrate schema versions on load:

```lua
local defaults = { scale = 1.0, showTooltips = true, version = 1 }

function ns:InitDB()
    if not MyAddonDB then MyAddonDB = {} end
    for key, value in pairs(defaults) do
        if MyAddonDB[key] == nil then MyAddonDB[key] = value end
    end
    if MyAddonDB.version < 1 then
        MyAddonDB.oldKey = nil
        MyAddonDB.version = 1
    end
    ns.db = MyAddonDB
end
```

AceDB-3.0 wraps the same pattern with profile support:

```lua
self.db = LibStub("AceDB-3.0"):New("MyAddonDB", {
    profile = { scale = 1.0, showTooltips = true },
})
```

## 4. Metatables and OOP

A prototype pattern is the typical way addons express class-like objects:

```lua
local MyClass = {}
MyClass.__index = MyClass

function MyClass:New(name, value)
    return setmetatable({ name = name, value = value }, self)
end

function MyClass:GetLabel()
    return format("%s: %d", self.name, self.value)
end
```

Blizzard-style mixins compose behavior into frames:

```lua
local MyMixin = {}
function MyMixin:OnLoad() self.items = {} end
function MyMixin:AddItem(item) tinsert(self.items, item) end

local frame = CreateFrame("Frame")
Mixin(frame, MyMixin)
frame:OnLoad()
```

Composition tends to dominate over deep inheritance chains in addon code.

## 5. String Patterns (Not Regex)

Lua uses patterns rather than regex. Key character classes: `%d` digit, `%a` letter, `%w` alphanumeric, `%s` whitespace, `%p` punctuation. Uppercase forms invert (`%D` = non-digit, etc.).

```lua
local count = tonumber(match("You received 5 gold.", "(%d+)"))
local key, val = match(msg, "^config%s+(%S+)%s+(.+)$")

for word in string.gmatch(text, "%S+") do end

-- Escape user input for pattern-safe use
local function PatternEscape(str)
    return str:gsub("([%(%)%.%%%+%-%*%?%[%]%^%$])", "%%%1")
end
```

Display strings typically go through `string.format` for type safety and easier localization:

```lua
local label = format("%s: %d/%d (%.1f%%)", name, current, total, pct)
```

## 6. Table Management

```lua
wipe(myTable)                    -- clear without new allocation
local copy = CopyTable(original) -- deep copy (Blizzard utility)
local count = #myArray           -- array length (undefined when nil holes exist)
```

Table pooling shows up in code that creates and destroys objects frequently (event payloads, list rows, transient state):

```lua
local pool = {}
local function AcquireTable()
    return tremove(pool) or {}
end
local function ReleaseTable(t)
    wipe(t); tinsert(pool, t)
end
```

## 7. Vararg Handling

`select("#", ...)` returns the correct count even when some varargs are nil. `#{...}` would miscount in that case:

```lua
function ns.Utils.PrintAll(...)
    local n = select("#", ...)
    for i = 1, n do
        print(i, tostring(select(i, ...)))
    end
end
```

Storing varargs while preserving count is commonly done with the `n = select("#", ...)` packed-table form:

```lua
local packed = { n = select("#", ...), ... }
-- packed.n == 3 for ("a", nil, "c"), packed[2] == nil preserved
```

## 8. Secure Hooks

Post-hooks (via `hooksecurefunc`) run after the original. They cannot modify arguments or prevent execution, but they do not introduce taint:

```lua
hooksecurefunc("TargetFrame_Update", function(self)
    if self.healthBar then self.healthBar:SetStatusBarColor(1, 0, 0) end
end)

hooksecurefunc(GameTooltip, "SetUnitBuff", function(self, ...)
    -- post-hook on object method
end)
```

For script handlers, `HookScript` chains a new handler after the existing one without replacing it:

```lua
frame:HookScript("OnEvent", function(self, event)
    -- runs AFTER the original OnEvent handler
end)
```

Replacing a secure function outright (assignment over the global, or `SetScript` on a protected handler) introduces taint and breaks protected actions in combat. The post-hook variants exist to avoid that.

## 9. Slash Commands

```lua
SLASH_MYADDON1 = "/myaddon"
SLASH_MYADDON2 = "/ma"
SlashCmdList["MYADDON"] = function(msg)
    if not msg or msg == "" then ns:ToggleMainWindow(); return end
    local cmd, rest = msg:match("^(%S+)%s*(.*)$")
    if not cmd then return end
    cmd = cmd:lower()
    if cmd == "config" then ns:OpenConfig()
    elseif cmd == "reset" then ns:ResetDefaults()
    else print(format("|cff00ccff%s|r: Unknown command '%s'", ADDON_NAME, cmd))
    end
end
```

The `SLASH_*` globals and the SavedVariables tables are typically the only globals an addon defines; everything else lives on the namespace `ns`. AceConsole-3.0 offers `self:RegisterChatCommand()` as a wrapper over the same mechanism.

## 10. Error Handling

`error()` with level 2 attributes the failure to the caller of a public API rather than the line that raised it:

```lua
function ns.Config.Set(key, value)
    if type(key) ~= "string" then
        error(format("Config.Set: expected string key, got %s", type(key)), 2)
    end
    ns.db[key] = value
end
```

Handling fallible operations splits along whether the API throws or returns nil:

```lua
-- Non-throwing APIs: check return value for nil
local info = C_Item.GetItemInfo(itemID)
if not info then return nil end

-- Throwing APIs: wrap in pcall
local ok, result = pcall(SomeFunctionThatMayError, arg)
if not ok then
    ns:Debug("Error: %s", result)
    return nil
end

local name = UnitName("target") or "Unknown"
```

Silently swallowed errors tend to produce "addon does nothing in combat" reports. Addons in good shape either log, surface, or propagate.

## 11. Coroutines and Deferred Work

A zero-delay timer is the standard way to defer execution out of an event handler or loading frame:

```lua
C_Timer.After(0, function() ns:InitializeUI() end)
```

Heavy work spread across frames typically uses a coroutine driven by a ticker:

```lua
local function ProcessLargeDataset(data)
    local co = coroutine.create(function()
        for i = 1, #data do
            ns:ProcessEntry(data[i])
            if i % 50 == 0 then coroutine.yield() end
        end
    end)
    local ticker
    ticker = C_Timer.NewTicker(0, function()
        if coroutine.status(co) == "dead" then ticker:Cancel(); return end
        local ok, err = coroutine.resume(co)
        if not ok then ticker:Cancel(); error("Coroutine failed: " .. tostring(err)) end
    end)
end
```

`C_Timer.NewTicker` covers periodic updates that do not need frame-level precision:

```lua
local ticker = C_Timer.NewTicker(1.0, function() ns:UpdateStatusDisplay() end)
-- Later: ticker:Cancel()
```
