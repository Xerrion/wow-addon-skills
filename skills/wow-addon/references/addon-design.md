# WoW Addon Design

Guidance for addon structure, event architecture, SavedVariables, and client flavors.
Read the [research toolkit](research-toolkit.md) for tool selection and LuaLS annotations.
Use [Lua patterns](lua-patterns.md), [event handling](event-handling.md), or the
[frame API](frame-api.md) for implementation details.

## 1. Module Decomposition

Split every non-trivial addon along these seams:

- `Core/` - bootstrap, namespace, the `ADDON_LOADED` entry point, slash command registration. Loads first.
- `Modules/` - feature units. Each module is self-contained: it owns its frames, its event registrations, and its options panel section.
- `Options/` - settings UI and the SavedVariables schema. ALWAYS keep schema definition next to the migration code that reads it.
- `Locales/` - `enUS.lua` first, then other locales. Locale files MUST be loaded before any module that uses translated strings.
- `Libs/` - embedded third-party libraries. Loaded before `Core/`.

Load order in the TOC file is the dependency graph. NEVER rely on a sibling module being loaded; if module B needs module A, declare it in `Core/` and let `Core/` orchestrate.

### Embedding strategy

- ALWAYS embed Ace3 and other LibStub-compatible libraries by listing them in `.pkgmeta` under `externals:`. The packager fetches them at build time. NEVER vendor them by hand-copying source - it rots.
- For libraries shipped stand-alone in `Libs/` (no LibStub), load them from the TOC explicitly. Document the upstream commit in a comment at the top of the TOC.
- Prefer embedded libraries over stand-alone unless the library is genuinely shared across multiple of your addons and you ship it as a separate addon.

## 2. Listener Architecture Trade-offs

Two architectural shapes exist for handling events. Pick one per addon and stay consistent.

### Single dispatcher

One frame, one `OnEvent`, a switch over `event`:

```lua
local frame = CreateFrame("Frame")
frame:RegisterEvent("PLAYER_LOGIN")
frame:RegisterEvent("LOOT_OPENED")
frame:SetScript("OnEvent", function(self, event, ...)
    if event == "PLAYER_LOGIN" then ns.OnLogin(...)
    elseif event == "LOOT_OPENED" then ns.OnLoot(...)
    end
end)
```

Use this when the addon is small (one or two concerns), or when handlers genuinely share state.

Trade-off: simple, one place to look - but the dispatcher couples unrelated concerns and grows into a god-function as the addon grows.

### Per-listener factory

One factory call per concern; the factory creates its own frame:

```lua
local _, ns = ...

ns.LootListener = {}

function ns.LootListener.Create(config)
    local listener = {}

    function listener:Start()
        ns.Addon:RegisterEvent(config.openEvent, function(_, ...)
            self:OnOpen(...)
        end)
        ns.Addon:RegisterEvent(config.closeEvent, function()
            self:OnClose()
        end)
    end

    function listener:OnOpen(...)
        -- shared logic using config values
    end

    function listener:OnClose()
        -- shared cleanup
    end

    return listener
end
```

Version-specific instantiation (`Listeners/Loot_Retail.lua`):

```lua
local _, ns = ...
if WOW_PROJECT_ID ~= WOW_PROJECT_MAINLINE then return end

local listener = ns.LootListener.Create({
    openEvent = "LOOT_READY",
    closeEvent = "LOOT_CLOSED",
})
listener:Start()
```

Use this when you have shared event-handling logic with version-specific variants, or when the addon has more than two distinct event-driven concerns.

Trade-off: more files and more indirection, but each concern is testable in isolation and version-specific differences live at the edges, not inside switch statements.

ALWAYS use the factory shape when the same logical handler must dispatch from different events on different flavors (e.g. `LOOT_READY` on retail, `LOOT_OPENED` on classic).

## 3. Capability Gating

Two mechanisms exist; they solve different problems.

### Runtime guards

```lua
if WOW_PROJECT_ID == WOW_PROJECT_MAINLINE then
    -- retail-only path
end
```

Use runtime guards for behavior differences inside otherwise-shared code paths - "this API exists on retail but not classic", "this event fires twice on classic".

### Build-time TOC selection

```toc
## Interface: 110000
# @retail@
Modules/RetailOnly.lua
# @end-retail@
# @non-retail@
Modules/ClassicShim.lua
# @end-non-retail@
```

Use packager directives when entire files should not load on a given flavor. Files gated this way never enter the Lua state, so they can reference APIs that don't exist on the other flavor without crashing.

### Combine them

TOC selects coarse flavor (which files load); runtime guards handle minor patch-level differences within a flavor. NEVER reach for a runtime guard when the entire file is flavor-specific - gate it at the TOC instead so the wrong-flavor code never parses.

## 4. Event-handling Architecture

Design-level patterns. For event API specifics, read [event handling](event-handling.md).

### Debouncing strategies

- **Timestamp guard** - store `lastFire` and ignore re-entries within a window. Use for events that fire in tight bursts you want to collapse to "fire once per burst".
- **Scheduled coalescer** - on first event, schedule a `C_Timer.After(delay, flush)`. Subsequent events within the window are absorbed. Use when you want one handler call per burst with the _latest_ payload.
- **AceTimer** - when the addon already depends on Ace3, prefer `:ScheduleTimer` over raw `C_Timer` for cancellation and lifecycle management.

### Bootstrap sequencing

- `ADDON_LOADED` (with name match) - SavedVariables are available. Run schema migration here. NEVER read SavedVariables before this fires.
- `PLAYER_LOGIN` - player data exists, UI is being built. Register most gameplay events here.
- `PLAYER_ENTERING_WORLD` - fires on login _and_ on every loading screen. Use for state that must reset per-zone, not for one-time setup.

### Lazy vs. up-front registration

Register events up-front when the handler is cheap and the event is rare. Register lazily (on user action, on options-panel open, on first need) when the handler is expensive or the feature is opt-in. NEVER register a high-frequency event (e.g. `UNIT_AURA`, `COMBAT_LOG_EVENT_UNFILTERED`) without a documented throttle or filter strategy.

## 5. Saved-variables Design

### Scope choice

- **Per-character** (`SavedVariablesPerCharacter`) - character-specific settings and state. Default for gameplay data tied to a single toon.
- **Per-account** (`SavedVariables`) - settings the user expects to share across all characters. Default for UI preferences and addon configuration.
- **Per-realm / per-faction** - emulate by keying a per-account table on `GetRealmName()` / `UnitFactionGroup("player")`. WoW does not provide these scopes natively.

### Schema versioning

ALWAYS store a `version` integer in the SavedVariables root table. Bump it when the shape changes. On `ADDON_LOADED`, compare against the current version and run migrations sequentially:

```lua
local CURRENT_VERSION = 3

local migrations = {
    [1] = function(db) db.options = db.options or {} end,
    [2] = function(db) db.options.theme = db.options.theme or "default" end,
}

local function migrate(db)
    db.version = db.version or 0
    while db.version < CURRENT_VERSION do
        local step = db.version + 1
        if migrations[step] then migrations[step](db) end
        db.version = step
    end
end
```

ALWAYS run migration before any read. NEVER branch on "is this field present?" deep in feature code - that scatters schema knowledge across the addon.

### Persist vs. recompute

Persist user choices and irreplaceable history. Recompute everything else on login. NEVER persist data derivable from the game state - it goes stale and creates a second source of truth.

## 6. Multi-flavor Strategy

### Shared core + flavor shims

One codebase, one TOC per flavor (or one TOC with packager directives), version-specific differences isolated behind a small shim module that the rest of the code calls into.

Use when the addon's logic is 80%+ shared across flavors. Most addons.

### Separate addons per flavor

Distinct repositories or distinct top-level folders, no shared code. The user installs the one matching their client.

Use ONLY when the flavors have diverged so far that "shared" is fiction - different feature sets, different UIs, different SavedVariables shapes.

### Single-TOC vs. multi-TOC

- **Single TOC + packager directives** - one `Addon.toc` with `@retail@` / `@classic@` blocks gating the file list. The packager produces flavor-specific zips. Simplest for shared-core addons.
- **Multi-TOC** - `Addon_Mainline.toc`, `Addon_Vanilla.toc`, `Addon_Wrath.toc`. The client picks the matching TOC at load time. Use when the file lists diverge meaningfully or when you need different `## Interface` numbers without packager processing.

The complexity of multi-TOC is justified only when single-TOC packager directives would obscure more than they clarify.

## 7. Testing Approach

### What is testable

- Pure logic: parsers, table transforms, formatters, comparators.
- Dispatchers, given a mocked event source.
- SavedVariables migrations: feed in an old-shape table, assert the new shape.

### What is not testable (in unit tests)

- Anything touching secure templates or combat-restricted APIs.
- Anything that creates or manipulates real frames.
- Anything reading live game state (`UnitAura`, `GetSpellInfo` without mocks, etc.).

### Tooling

- **Busted** as the test runner. Standard in the WoW Lua community.
- **`wow-mock`** (or hand-rolled mocks) to stub `CreateFrame`, `C_Timer`, event dispatch, and the global API surface. Inject these via the test harness, not via global pollution.
- **CI** - run busted on every push. GitHub Actions with a Lua + LuaRocks setup is the conventional shape.

ALWAYS structure code so the testable seam is obvious: pure logic in modules that don't import frame APIs, frame and event glue in thin wrappers around those modules. If a function can't be called from a test because it touches `CreateFrame` on the first line, the seam is in the wrong place - refactor.
