---
name: wow-addon
description: Develop, review, and troubleshoot World of Warcraft addons. Use for addon architecture, Lua patterns, events, frames and widgets, SavedVariables, client flavor support, or WoW API and Blizzard source research.
---

# WoW addons

Read the reference for the current task. Load additional references only when needed.

## Select a task

| Task                                                                                          | Read when needed                                   |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Module structure, listener architecture, SavedVariables schemas, packaging, or client flavors | [Addon design](references/addon-design.md)         |
| API signatures, event payloads, LuaLS annotations, or Blizzard source research                | [Research toolkit](references/research-toolkit.md) |
| Event registration, dispatch, login sequence, combat lockdown, throttling, or cleanup         | [Event handling](references/event-handling.md)     |
| Frames, anchors, textures, widgets, secure templates, pooling, taint, or tooltips             | [Frame API](references/frame-api.md)               |
| Namespaces, cached globals, Lua patterns, SavedVariables access, hooks, or deferred work      | [Lua patterns](references/lua-patterns.md)         |

Identify the target client flavor and build before making an API compatibility claim.
Confirm exact signatures and event payloads against sources for that client.
Examples in these references illustrate patterns and do not establish availability on every client.

The research toolkit describes optional WoW tools exposed by a local MCP server.
MCP clients may prefix their names. The skill works without that server; use permitted local sources or primary documentation when the tools are unavailable.
For research or review tasks, use the references within the assigned role and scope.
