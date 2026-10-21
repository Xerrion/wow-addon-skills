# WoW addon research toolkit

A short reference for picking the right research tool and reading the annotations they return. Each tool's parameters and full behavior live in the tool itself; this reference only covers when to prefer one over another.

The named tools are optional integrations exposed by this repository's local MCP server.
MCP clients may prefix the tool names. Discover the available tools in your client and use the names it exposes.
If they are unavailable, use permitted local annotations, Blizzard source, or primary API documentation.
Keep every lookup specific to the selected client flavor and build.

## Tool selection precedence

| Question                                      | Tool and arguments                                                                                               | Source                                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| API, widget, enum, type, or library signature | `wow-api-lookup` with `query`, such as `C_Item.GetItemInfo` or `Frame:SetSize`                                   | Exact symbol lookup in local LuaLS annotations. No fuzzy search or wiki fetch.                                                       |
| Event name and payload                        | `wow-event-info` with one exact `event`, such as `PLAYER_LOGIN`                                                  | Local event catalog, with a bounded same-prefix family window and suggestions for missing names. No network fetch.                   |
| Blizzard's implementation                     | `wow-blizzard-source` with a ripgrep `pattern`, optional `flavor`, and optional `scope`                          | Local annotated FrameXML. Flavor defaults to `live` (`retail` is an alias); scope defaults to `lua` and also accepts `xml` or `all`. |
| Behavioral detail absent from local sources   | `wow-wiki-fetch` with `page`, such as `API_C_Item.GetItemInfo` or a full `https://warcraft.wiki.gg/wiki/...` URL | An explicit fetch from Warcraft Wiki, with redirects restricted to that HTTPS origin.                                                |

Prefer local signatures and event payloads, then relevant Blizzard source. Use wiki articles for caveats, patch history, or behavior that annotations do not describe. Use annotated Blizzard source to understand existing patterns.

The MCP server returns text content and `structuredContent` containing `output` and optional `metadata`. Wiki metadata includes its URL, categories, and redirect information when available. Blizzard source metadata includes the resolved flavor, rendered match count, and truncation state. Execution errors set `isError: true`; a completed lookup with no matches returns an explanatory result. Check search limits and truncation before inferring absence.

## LuaLS annotation format

Annotations use the LuaLS comment syntax. Common forms:

```lua
---@param paramName ParamType Description
---@return ReturnType? Description   -- ? = nullable
---@class ClassName : OptionalParent
---@field fieldName FieldType Description
---@overload fun(short: string): boolean
```

Multiple `---@return` lines indicate multiple return values, in order. `?` after a type marks it nullable. Generics appear as `---@generic T` and are referenced by name later in the block.

## Multi-flavor reminder

WoW publishes multiple flavors in parallel: Retail (live), Classic, Vanilla (Classic Era), Anniversary, plus PTR and beta variants. An API that exists in Retail may be missing, renamed, or have a different return-value count in a Classic flavor.

The source tool selects the local `live`, `classic`, `classic_era`, or `classic_anniversary` FrameXML worktree. API and event lookups use the shared Ketho catalog and do not take a flavor argument. Record the catalog or source version and verify it against the target client before claiming support. The wiki tool has no flavor selector; read each article's version notes.

## Runtime version-guard idiom

Addons gate code by flavor at runtime through `WOW_PROJECT_ID` and the `WOW_PROJECT_*` constants:

- `WOW_PROJECT_MAINLINE`. Retail
- `WOW_PROJECT_CLASSIC`. Classic Era (Vanilla)
- `WOW_PROJECT_CATACLYSM_CLASSIC`, `WOW_PROJECT_MISTS_CLASSIC`, `WOW_PROJECT_ANNIVERSARY_CLASSIC`. Successive Classic re-releases

A common form is a top-of-file early return:

```lua
if WOW_PROJECT_ID ~= WOW_PROJECT_MAINLINE then return end
```

Build-time exclusion is a separate mechanism: `.toc` files use packager directives such as `#@retail@` / `#@end-retail@` so a flavor's package never ships the file at all.

## wago.tools

[wago.tools](https://wago.tools/) is the canonical browser for WoW's internal database tables (DB2). Spell IDs, item IDs, quest IDs, build/interface numbers per flavor. Useful when an addon references numeric IDs and you need to resolve them to names, or vice versa.
