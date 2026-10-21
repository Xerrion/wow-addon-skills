# WoW Event Handling Patterns

A catalog of the event-handling shapes addons rely on. Event names and payload shapes are best confirmed via `wow-event-info`; the snippets below illustrate the dispatch and lifecycle patterns those events sit inside.

## 1. Raw Event Registration

Every event handler is bound to a frame. Without a frame there is no handler:

```lua
local frame = CreateFrame("Frame")
frame:RegisterEvent("PLAYER_LOGIN")
frame:RegisterEvent("LOOT_OPENED")
frame:SetScript("OnEvent", function(self, event, ...)
    if event == "PLAYER_LOGIN" then
        self:OnPlayerLogin()
    elseif event == "LOOT_OPENED" then
        self:OnLootOpened(...)
    end
end)
```

- `RegisterEvent(name)` starts listening
- `UnregisterEvent(name)` stops listening for one event
- `UnregisterAllEvents()` stops every event on that frame
- `IsEventRegistered(name)` distinguishes a fresh registration from a re-registration

## 2. Dispatch Patterns

### Method dispatch

A common form is to look up a method on `self` named exactly after the event:

```lua
frame:SetScript("OnEvent", function(self, event, ...)
    local handler = self[event]
    if handler then handler(self, ...) end
end)

function frame:PLAYER_LOGIN()
    -- handle login
end

function frame:LOOT_OPENED(autoLoot)
    -- handle loot
end
```

Adding a handler is then "define a method, register the event". No central if/elseif chain.

### Table dispatch

A nearby variant uses a separate handler table:

```lua
local handlers = {}
handlers.PLAYER_LOGIN = function() --[[ ... ]] end
handlers.LOOT_OPENED = function(autoLoot) --[[ ... ]] end

frame:SetScript("OnEvent", function(self, event, ...)
    local fn = handlers[event]
    if fn then fn(...) end
end)
```

## 3. AceEvent-3.0

```lua
local MyAddon = LibStub("AceAddon-3.0"):NewAddon("MyAddon", "AceEvent-3.0")

function MyAddon:OnEnable()
    self:RegisterEvent("PLAYER_LOGIN")
    self:RegisterEvent("LOOT_OPENED", "HandleLoot")
    self:RegisterMessage("MyAddon_CustomEvent")
end

function MyAddon:PLAYER_LOGIN()
    -- default: method name = event name
end

function MyAddon:HandleLoot(event, autoLoot)
    -- custom method name via second argument
end

function MyAddon:OnDisable()
    self:UnregisterAllEvents()
    self:UnregisterAllMessages()
end
```

- AceEvent owns the underlying frame; addon code does not create one
- The second argument to `RegisterEvent` routes the event to a custom method name
- `RegisterMessage` / `SendMessage` provide an inter-addon (or intra-addon) message bus
- `UnregisterEvent` / `UnregisterAllEvents` mirror the raw API for cleanup

## 4. ADDON_LOADED Bootstrap

```lua
local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:SetScript("OnEvent", function(self, event, addonName)
    if addonName ~= ADDON_NAME then return end
    self:UnregisterEvent("ADDON_LOADED")
    -- SavedVariables are available here
    -- Initialization runs from this point
end)
```

`ADDON_LOADED` fires once per addon when its files finish loading. The first payload argument is the addon name, so a typical handler early-returns on a name mismatch and unregisters itself once the matching event arrives. SavedVariables are populated by this point. Ace3 addons usually use `OnInitialize()`, which runs at the same moment.

## 5. Login Event Sequence

The order at login is fixed:

1. `ADDON_LOADED`. Per-addon, SavedVariables available
2. `PLAYER_LOGIN`. Character data available, UI visible
3. `PLAYER_ENTERING_WORLD` (with `isInitialLogin=true`). World fully loaded
4. `LOADING_SCREEN_DISABLED`. Loading screen gone

`PLAYER_LOGIN` fires once per session. `PLAYER_ENTERING_WORLD` fires on every loading screen (instance changes, portals, hearths). One-time setup typically sits on `PLAYER_LOGIN`; state that needs refresh on zone changes sits on `PLAYER_ENTERING_WORLD`.

## 6. Combat Lockdown

Protected actions fail silently in combat. A typical guard pattern defers the action until combat ends:

```lua
function MyAddon:DoSecureAction()
    if InCombatLockdown() then
        self:RegisterEvent("PLAYER_REGEN_ENABLED")
        self.pendingAction = true
        return
    end
    self:UpdateSecureFrames()
end

function MyAddon:PLAYER_REGEN_ENABLED()
    self:UnregisterEvent("PLAYER_REGEN_ENABLED")
    if self.pendingAction then
        self.pendingAction = false
        self:UpdateSecureFrames()
    end
end
```

- `InCombatLockdown()` returns true during combat
- `PLAYER_REGEN_DISABLED` marks combat entry; `PLAYER_REGEN_ENABLED` marks combat exit
- Secure frame modifications (Show, Hide, SetPoint, SetParent on protected frames) are rejected during combat. The typical pattern is to detect and defer

## 7. Event Throttling and Batching

Some events fire in rapid bursts; addons commonly batch them with a debounced timer:

```lua
local pending = false
function MyAddon:BAG_UPDATE()
    if pending then return end
    pending = true
    C_Timer.After(0.1, function()
        pending = false
        MyAddon:ProcessBagUpdate()
    end)
end
```

AceBucket-3.0 wraps the same idea:

```lua
-- Collects all BAG_UPDATE firings within 0.2s, then calls handler once
self:RegisterBucketEvent("BAG_UPDATE", 0.2, "ProcessBagUpdate")
```

## 8. Unit Events

```lua
frame:RegisterUnitEvent("UNIT_HEALTH", "player", "target")
```

- Fires only for the listed unit tokens. Cheaper than `RegisterEvent` for unit events
- Up to two unit tokens are supported
- Works for `UNIT_HEALTH`, `UNIT_POWER_UPDATE`, `UNIT_AURA`, etc.
- The unit argument is still delivered as the first payload value

## 9. EventRegistry (Modern Retail)

```lua
EventRegistry:RegisterFrameEventAndCallback("UNIT_AURA", function(_, unit, info)
    if unit ~= "player" then return end
    -- handle player aura changes
end)
```

`EventRegistry` is the modern Retail event hub, exposing `RegisterFrameEventAndCallback` / `UnregisterFrameEventAndCallback`. Classic flavors continue to use the traditional frame-based registration; cross-version addons accordingly tend to stick with `RegisterEvent`.

## 10. Common Event Gotchas

- `UNIT_AURA` fires very frequently. Handlers typically filter on the unit token early and return fast
- `COMBAT_LOG_EVENT_UNFILTERED` carries no payload arguments; `CombatLogGetCurrentEventInfo()` returns the actual event data
- `GET_ITEM_INFO_RECEIVED` is the async signal that an item cache entry is now populated
- `PLAYER_LOGOUT` is unreliable for saving data; addons typically save on important state changes instead
- Some events fire before the frame is fully rendered; `C_Timer.After(0, fn)` defers to the next frame
- `VARIABLES_LOADED` is deprecated; `ADDON_LOADED` covers the same ground

## 11. Cleanup and Unregistering

When a module is disabled or torn down, its events are typically unregistered explicitly.

Ace3 cleanup:

```lua
function MyAddon:OnDisable()
    self:UnregisterAllEvents()
    self:UnregisterAllMessages()
    self:CancelAllTimers()
end
```

Raw frame cleanup:

```lua
function MyFrame:Destroy()
    self:UnregisterAllEvents()
    self:SetScript("OnEvent", nil)
    self:SetScript("OnUpdate", nil)
    self:Hide()
end
```

Cancelling timers (AceTimer, `C_Timer` tickers), removing `OnUpdate` scripts, and nilling out script handlers are the three pieces typically present in a clean teardown. Hiding a frame stops `OnUpdate` automatically, but disabled-module teardown usually clears the handler explicitly to keep the lifecycle observable.
