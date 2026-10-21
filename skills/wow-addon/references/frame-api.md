# WoW Frame and UI API Patterns

A catalog of how addons construct and manipulate the WoW UI. Signatures and exact widget methods are best confirmed via `wow-api-lookup`; this reference explains the shapes of code seen in real addons.

---

## 1. CreateFrame Basics

```lua
local frame = CreateFrame("Frame", nil, UIParent, "BackdropTemplate")
```

- Parameters: `frameType`, `name`, `parent`, `template`, `id`
- Anonymous frames (`name = nil`) are common; named frames register as globals on `_G`, so a name is typically only set when other addons need to reference the frame
- Common types: `Frame`, `Button`, `StatusBar`, `ScrollFrame`, `EditBox`, `Slider`, `CheckButton`, `GameTooltip`
- Multiple templates are passed as a comma-separated string: `"BackdropTemplate,SecureActionButtonTemplate"`

## 2. Frame Hierarchy and Strata

- A child inherits its parent's visibility, scale, and alpha; hiding a parent hides every descendant
- `frame:SetParent(newParent)` reparents
- Strata, bottom to top: `BACKGROUND`, `LOW`, `MEDIUM` (default), `HIGH`, `DIALOG`, `FULLSCREEN`, `FULLSCREEN_DIALOG`, `TOOLTIP`
- `frame:SetFrameStrata("HIGH")` assigns strata; `frame:SetFrameLevel(10)` controls z-order within a strata

## 3. Anchor System

```lua
frame:SetPoint("CENTER", UIParent, "CENTER", 0, 0)
frame:SetPoint("TOPLEFT", parent, "BOTTOMLEFT", 5, -5)
```

- `SetPoint(point, relativeTo, relativePoint, offsetX, offsetY)`. Additional `SetPoint` calls add anchors rather than replacing them, so repositioning an already-anchored frame typically pairs `ClearAllPoints()` with new `SetPoint` calls
- Passing a frame reference as `relativeTo` avoids the global lookup that a name string would force
- `SetAllPoints(parent)` is the shortcut for filling the parent

```lua
-- Fill parent with padding
frame:SetPoint("TOPLEFT", parent, "TOPLEFT", 8, -8)
frame:SetPoint("BOTTOMRIGHT", parent, "BOTTOMRIGHT", -8, 8)

-- Stack below a sibling
frame:SetPoint("TOPLEFT", sibling, "BOTTOMLEFT", 0, -4)
frame:SetPoint("TOPRIGHT", sibling, "BOTTOMRIGHT", 0, -4)
```

## 4. Backdrop Setup

Backdrops require the `BackdropTemplate` template, which was removed in 9.0 and re-added as an explicit opt-in:

```lua
local frame = CreateFrame("Frame", nil, UIParent, "BackdropTemplate")
frame:SetBackdrop({
    bgFile = "Interface/Tooltips/UI-Tooltip-Background",
    edgeFile = "Interface/Tooltips/UI-Tooltip-Border",
    edgeSize = 16,
    insets = { left = 4, right = 4, top = 4, bottom = 4 },
})
frame:SetBackdropColor(0, 0, 0, 0.8)
frame:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
```

`tile = true` and `tileSize = 16` produce repeating backgrounds.

## 5. Textures and Layers

```lua
local tex = frame:CreateTexture(nil, "BACKGROUND")
tex:SetTexture("Interface/AddOns/MyAddon/Textures/bg")
tex:SetAllPoints()
tex:SetVertexColor(1, 1, 1, 0.5)
```

- Draw layers, back to front: `BACKGROUND`, `BORDER`, `ARTWORK`, `OVERLAY`, `HIGHLIGHT`
- Sub-layer offset (integer -8 to 7) orders textures within a layer
- `HIGHLIGHT` layer auto-shows on mouse enter and hides on leave
- Atlas: `tex:SetAtlas("Tooltip-Background")`
- Sprite regions: `tex:SetTexCoord(left, right, top, bottom)`

```lua
local bg = frame:CreateTexture(nil, "BACKGROUND", nil, -1) -- behind default
local fg = frame:CreateTexture(nil, "BACKGROUND", nil, 1)  -- in front of default
```

## 6. Font Strings

```lua
local text = frame:CreateFontString(nil, "OVERLAY", "GameFontNormal")
text:SetPoint("CENTER")
text:SetText("Hello World")
```

- Built-in templates: `GameFontNormal`, `GameFontHighlight`, `GameFontNormalLarge`, `GameFontNormalSmall`
- Custom fonts: `text:SetFont("Interface/AddOns/MyAddon/Fonts/Custom.ttf", 14, "OUTLINE")`
- Flags: `"OUTLINE"`, `"THICKOUTLINE"`, `"MONOCHROME"`
- Overflow: `text:SetWordWrap(true)`, `text:SetMaxLines(3)`
- Inline color escape: `"|cFFFF0000Red text|r normal text"`

## 7. StatusBar Patterns

```lua
local bar = CreateFrame("StatusBar", nil, parent)
bar:SetStatusBarTexture("Interface/TargetingFrame/UI-StatusBar")
bar:SetMinMaxValues(0, 100)
bar:SetValue(75)
bar:SetStatusBarColor(0, 1, 0)

local bg = bar:CreateTexture(nil, "BACKGROUND")
bg:SetAllPoints()
bg:SetTexture("Interface/TargetingFrame/UI-StatusBar")
bg:SetVertexColor(0.2, 0.2, 0.2, 0.8)
```

Smooth-transition bars typically interpolate via `OnUpdate` rather than jumping. `bar:SetFillStyle("STANDARD" | "REVERSE" | "CENTER")` controls fill direction.

## 8. Animation System

```lua
local ag = frame:CreateAnimationGroup()
local fade = ag:CreateAnimation("Alpha")
fade:SetFromAlpha(0)
fade:SetToAlpha(1)
fade:SetDuration(0.3)
fade:SetSmoothing("OUT")
ag:Play()
```

- Types: `Alpha`, `Scale`, `Translation`, `Rotation`, `Path`
- Smoothing: `IN`, `OUT`, `IN_OUT`, `NONE`
- Sequencing: `SetStartDelay` or `SetOrder` (groups play order 1, then 2, etc.)
- Looping: `ag:SetLooping("REPEAT" | "BOUNCE")`
- Completion: `ag:SetScript("OnFinished", function(self) self:GetParent():Hide() end)`

```lua
local slide = ag:CreateAnimation("Translation")
slide:SetOffset(0, -50)
slide:SetDuration(0.25)
slide:SetSmoothing("OUT")
```

## 9. Secure Templates

Secure frames carry the protected attribute set that allows combat-time clicks (casting spells, targeting, and so on):

```lua
local btn = CreateFrame("Button", "MySecureBtn", UIParent, "SecureActionButtonTemplate")
btn:SetAttribute("type", "spell")
btn:SetAttribute("spell", "Rejuvenation")
btn:RegisterForClicks("AnyUp", "AnyDown")
```

- `SecureActionButtonTemplate` covers spell / item / macro action buttons
- `SecureHandlerBaseTemplate` exposes the restricted-Lua state environment for custom secure logic
- Modifying secure frame attributes during combat raises a taint error and the change is rejected; `InCombatLockdown()` is the runtime guard, and `PLAYER_REGEN_ENABLED` is the typical signal to flush deferred secure updates

## 10. ScrollFrame Patterns

```lua
local scroll = CreateFrame("ScrollFrame", nil, parent, "UIPanelScrollFrameTemplate")
scroll:SetSize(300, 400)

local content = CreateFrame("Frame", nil, scroll)
content:SetSize(300, 800) -- scroll frame reads this explicitly
scroll:SetScrollChild(content)
```

The scroll child needs an explicit size; the scroll frame uses it to compute scroll range. Resizing the content (`content:SetHeight(totalHeight)`) is what updates the scroll bar after children change.

```lua
scroll:SetScript("OnMouseWheel", function(self, delta)
    local current = self:GetVerticalScroll()
    local maxScroll = self:GetVerticalScrollRange()
    local newScroll = math.max(0, math.min(current - (delta * 40), maxScroll))
    self:SetVerticalScroll(newScroll)
end)
```

## 11. Custom Widget Factories

A common form for reusable UI components (options panels, config rows) is a factory that returns a positioned-on-demand root frame:

```lua
local LAYOUT = { WIDGET_HEIGHT = 26, PADDING = 8, INDENT = 16 }

local function CreateToggle(parent, config)
    local check = CreateFrame("CheckButton", nil, parent, "UICheckButtonTemplate")
    check:SetSize(LAYOUT.WIDGET_HEIGHT, LAYOUT.WIDGET_HEIGHT)
    check:SetChecked(config.get())
    check:SetScript("OnClick", function(self) config.set(self:GetChecked()) end)

    local label = check:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    label:SetPoint("LEFT", check, "RIGHT", 4, 0)
    label:SetText(config.label)
    return check
end
```

The factory returns the root frame; the caller anchors it. Config tables typically carry `label`, `get`, `set`, and an optional `tooltip`. A shared layout-constants table keeps spacing consistent across widgets.

## 12. Frame Pooling

```lua
local pool = CreateFramePool("Frame", parent, "BackdropTemplate")
local frame = pool:Acquire()
frame:Show()
pool:Release(frame)
pool:ReleaseAll()
```

- Used for dynamic lists, grids, rows. Anywhere item count varies
- `Acquire()` returns a recycled frame or creates a new one
- `Release()` hides the frame and runs its reset handler

```lua
local pool = CreateFramePool("Frame", parent, "BackdropTemplate", function(_, frame)
    frame:ClearAllPoints()
    frame:SetAlpha(1)
    frame:Hide()
end)
```

## 13. Taint Avoidance

Taint is the protection system for secure code paths. Once a value or frame is touched by addon code, the engine marks it as tainted; subsequent use of that value inside a protected execution path raises an "action blocked" error and the operation is rejected. Symptoms include silent UI failures in combat, spell casts that do not fire, and `ADDON_ACTION_BLOCKED` messages.

Common observations:

- Direct mutation of Blizzard secure frames (e.g. `PlayerFrame:SetAlpha(...)`) taints those frames; the typical workaround is to react to Blizzard behavior via `hooksecurefunc` rather than replace it.
- Setting a global that Blizzard code later reads taints the value chain through that global.
- Modifying secure frame attributes during combat fails. `InCombatLockdown()` returns `true` and the protected attribute write is rejected.
- `hooksecurefunc()` is the non-tainting hook variant; replacement assignments are not.
- `C_Timer.After(0, fn)` defers work to the next frame, which is enough to escape some taint propagation chains.

```lua
-- Direct mutation of a secure Blizzard frame: taints PlayerFrame
PlayerFrame:SetAlpha(0.5)

-- Hook variant: reacts without tainting the original
hooksecurefunc(PlayerFrame, "Show", function(self)
    -- react safely
end)
```

A common queue pattern flushes deferred secure work when combat ends:

```lua
local pending = {}
local processor = CreateFrame("Frame")
processor:RegisterEvent("PLAYER_REGEN_ENABLED")
processor:SetScript("OnEvent", function()
    for _, fn in ipairs(pending) do fn() end
    wipe(pending)
end)

local function DeferSecure(fn)
    if InCombatLockdown() then
        table.insert(pending, fn)
    else
        fn()
    end
end
```

## 14. Tooltip Integration

```lua
frame:SetScript("OnEnter", function(self)
    GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
    GameTooltip:SetText("Title", 1, 1, 1)
    GameTooltip:AddLine("Description text.", 0.8, 0.8, 0.8, true)
    GameTooltip:Show()
end)
frame:SetScript("OnLeave", GameTooltip_Hide)
```

- `SetOwner()` clears the previous tooltip. Content added before it is discarded
- Anchors: `ANCHOR_RIGHT`, `ANCHOR_LEFT`, `ANCHOR_CURSOR`, `ANCHOR_NONE`, `ANCHOR_TOPLEFT`
- `GameTooltip_Hide` is a global function, not a method, so it is passed directly as a handler
- Item tooltip: `GameTooltip:SetHyperlink(itemLink)`
- Spell tooltip: `GameTooltip:SetSpellByID(spellID)`
- Two-column row: `AddDoubleLine(leftText, rightText, lR, lG, lB, rR, rG, rB)`
