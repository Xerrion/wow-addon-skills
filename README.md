# WoW addon skills and MCP tools

Portable guidance and a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for World of Warcraft addon development. Use the Markdown skill with your preferred coding assistant. Run the server locally over stdio, or self-host it over Streamable HTTP.

API, event, and Blizzard source lookups read files on the machine running the server. The `wow-wiki-fetch` tool contacts `https://warcraft.wiki.gg`. HTTP mode also downloads and refreshes the annotation repositories automatically. Local stdio operation needs no account or API key. HTTP hosting uses a bearer token that you control. Dependency installation downloads the declared packages.

## Included

| Component                                          | Purpose                                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [WoW addon skill](skills/wow-addon/SKILL.md)       | Addon design, Lua patterns, events, frames, SavedVariables, packaging, and research references |
| [Research agent instructions](agents/wow-addon.md) | Optional read-only specialist instructions in plain Markdown                                   |
| [MCP tools](mcp/tools/)                            | API signatures, exact event payloads, wiki articles, and per-flavor Blizzard source searches   |
| Annotation maintenance scripts                     | Set up and update local annotations for Retail and Classic flavors                             |

## Interactive setup

Install [Bun 1.3.12 or newer](https://bun.com/docs/installation) and [ripgrep (`rg`)](https://github.com/BurntSushi/ripgrep). Annotation downloads also need Git and Bash 3.2 or newer on macOS/Linux, or PowerShell 5.1 or newer on Windows.

1. Clone the repository and enter it:

   ```sh
   git clone https://github.com/Xerrion/wow-addon-skills.git
   cd wow-addon-skills
   ```

2. Start the installer in a terminal:

   ```sh
   ./install.sh
   ```

   On Windows, run `.\install.ps1`. Choose whether to install the skill, prepare the MCP server, and download or update annotations. Press Enter to accept the displayed default. Existing skills require confirmation before replacement. Until the questions are complete, Ctrl+C or an unfinished answer cancels setup before installation starts.

3. Copy the printed JSON into your client's MCP settings, then reload its connections. The JSON contains the detected Bun and ripgrep executables, the built server path, and your annotation directories. All paths are absolute, with JSON escaping handled automatically. The installer prints the settings and leaves client configuration files untouched.

4. Confirm that the client lists four tools. Call `wow-event-info` with `{"event":"PLAYER_LOGIN"}` to check the local event catalog. If you skipped annotation downloads, point the installer at existing annotation checkouts or run it again with annotations enabled.

MCP setup installs dependencies from `bun.lock` when the SDK or compiler is missing and always rebuilds the server. Bun handles dependency installation, compilation, tests, and server execution. It needs no account or API key. Keep the checkout at its current location; rerun MCP setup and replace the settings if you move it.

### Scripted setup

Use MCP-only mode to build the server and print JSON without prompts:

```sh
./install.sh --mcp > wow-addon-mcp.json
```

```powershell
.\install.ps1 -Mcp > wow-addon-mcp.json
```

Prompts, build logs, and errors go to stderr; successful MCP output on stdout is only JSON. A failed setup returns a nonzero exit code without printing partial JSON. The redirect above creates a JSON file in your current directory; it does not register the server with a client.

Use `--interactive` or `-Interactive` to force prompts when input is redirected. Use `--non-interactive` or `-NonInteractive` for skill-only installation without prompts. An invocation with flags, or with redirected input, keeps the skill-only behavior unless MCP mode is selected. Add `--annotations` or `-Annotations` to download annotations in scripted mode.

The [configuration example](examples/mcp.json) remains available for manual setup. The `mcpServers` wrapper is common, but clients can use a different format or settings location. Use the stdio server settings supported by your client.

The setup follows [BetterCLI's help guidance](https://bettercli.org/design/cli-help-page/) and [installation guidance](https://bettercli.org/design/distribution/self-executing-installer/): show a starting command, make changes explicit, check prerequisites, and keep a scripted path available.

## Streamable HTTP and Coolify

Run `bun run start:http` after building to serve MCP at `/mcp`, a liveness check at `/health`, and readiness at `/ready`. Set `WOW_MCP_TOKEN` to a secret of at least 32 characters first. HTTP binds to `127.0.0.1:3000` by default. Set `WOW_MCP_HOST=0.0.0.0` and `WOW_MCP_PUBLIC_URL=https://your-domain` behind an HTTPS reverse proxy.

HTTP startup installs the shared API annotations and all four FrameXML flavors automatically. The server refreshes them every 24 hours and saves the successful refresh time beside the data, so restarts preserve the schedule. MCP requests wait with `503` until the initial data is ready. Failed refreshes keep existing local data available and retry after one hour. Set `WOW_MCP_MANAGE_ANNOTATIONS=false` only when you manage the annotation files separately. Automatic maintenance needs Git and Bash on macOS/Linux, or Windows PowerShell on Windows; the container includes its prerequisites.

The [Coolify setup guide](docs/coolify.md) covers deployment with the included [Dockerfile](Dockerfile) and [Compose file](compose.yaml), persistent annotation data, and client settings. Inside the configured container, `bun run config:http` prints complete MCP JSON containing the public URL and bearer token. Treat this output as a secret. An [HTTP configuration example](examples/mcp-http.json) is also available.

HTTP serves the same four tools using stateless Streamable HTTP, with SSE responses and support for the older initialization handshake. Clients must support a custom `Authorization` header; interactive OAuth login is not implemented. In HTTP mode, local file lookups read the server's annotation storage.

## Tool reference

Clients may add a prefix to these tool names. Use the name exposed by your client.

| Tool                  | Arguments                                | Source and behavior                                                                                                                                          |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wow-api-lookup`      | `query`                                  | Exact symbol lookup in the local curated LuaLS tree, such as `C_Item.GetItemInfo`, `Frame:SetSize`, or `Enum.ItemQuality`. No fuzzy search or network fetch. |
| `wow-event-info`      | `event`                                  | One exact event name, such as `PLAYER_LOGIN`. Returns its local payload annotation and a bounded family window. A missing event may include suggestions.     |
| `wow-blizzard-source` | `pattern`, optional `flavor` and `scope` | Ripgrep regular expression search in local annotated FrameXML. Flavor defaults to `live`; scope defaults to `lua`.                                           |
| `wow-wiki-fetch`      | `page`                                   | Fetch one Warcraft Wiki slug or HTTPS URL and render the article as Markdown, with URL, categories, and redirect metadata when available.                    |

Successful calls return MCP text content and `structuredContent` with `output` and, where available, `metadata`. Execution errors use `isError: true`. A completed lookup with no matches returns an explanatory result. Outputs are bounded; check truncation notes before treating a result as complete.

## Local data and configuration

| Environment variable   | Default                                                                                      | Purpose                                             |
| ---------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `WOW_ANNOTATIONS_ROOT` | `~/.local/share/wow-annotations` on macOS/Linux; `%LOCALAPPDATA%/wow-annotations` on Windows | Ketho checkout containing `Annotations/Core/`       |
| `WOW_FRAMEXML_ROOT`    | `~/.local/share/wow-framexml` on macOS/Linux; `%LOCALAPPDATA%/wow-framexml` on Windows       | Parent directory of the FrameXML flavor worktrees   |
| `WOW_RG_COMMAND`       | `rg`                                                                                         | Ripgrep executable name or absolute executable path |

Set these in the MCP server's `env` configuration when the defaults do not match your files. Use absolute paths; the server does not expand `~` or shell variables in configuration values. `WOW_RG_COMMAND` names one executable and does not accept shell arguments. Restart the MCP connection after changing environment values.

The maintenance scripts honor the same `WOW_ANNOTATIONS_ROOT` and `WOW_FRAMEXML_ROOT` overrides. Interactive MCP setup passes its normalized directory choices to annotation maintenance. For separate maintenance runs, export absolute paths in those variables before running the script.

```text
<data root>/wow-annotations/
  Annotations/Core/
<data root>/wow-framexml/
  .bare/
  live/Annotations/
  classic/Annotations/
  classic_era/Annotations/
  classic_anniversary/Annotations/
```

| Flavor argument       | FrameXML directory    |
| --------------------- | --------------------- |
| `live` or `retail`    | `live`                |
| `classic`             | `classic`             |
| `classic_era`         | `classic_era`         |
| `classic_anniversary` | `classic_anniversary` |

The source tool supports `scope: "lua"`, `"xml"`, or `"all"`. It searches annotated files, with bounded context and match counts. The API and event tools use the shared Ketho catalog and do not accept a flavor argument. Confirm the target client's build and source version before making compatibility claims.

To update only one FrameXML flavor, run `./maintain-annotations.sh --flavor live` or `.\maintain-annotations.ps1 -Flavor live`. Ketho's shared annotations are also maintained by that run.

## Install the optional skill

The skill works independently of the MCP server. Clients that support Markdown skills can load [skills/wow-addon/SKILL.md](skills/wow-addon/SKILL.md), together with its `references/` directory. Clients can also use [agents/wow-addon.md](agents/wow-addon.md) as read-only research instructions according to their own configuration format.

On macOS/Linux:

```sh
./install.sh --non-interactive
```

On Windows:

```powershell
.\install.ps1 -NonInteractive
```

Skill-only mode copies `wow-addon` to `~/.agents/skills/wow-addon` by default. It skips an existing installation unless you pass `--force` or `-Force`. Interactive mode asks before replacement and defaults to keeping the existing copy. Use `--skills-dir /absolute/path/to/skills` or `-SkillsDir 'C:\path\to\skills'` for a different parent directory. Add `--annotations` or `-Annotations` to run annotation setup after installing the skill.

Skill-only mode does not install Bun dependencies or build the MCP server. Neither mode edits a coding assistant's settings.

## Update and verify

After pulling changes into this checkout, rebuild and run the checks:

```sh
git pull
bun ci
bun run build
bun run check
bun run test
```

Restart your client's MCP connection to load the rebuilt server. If you installed the skill, refresh that copy with `./install.sh --force` or `.\install.ps1 -Force`. HTTP mode maintains annotations automatically. For stdio, update them with the maintenance script.

## Migrate from the previous OpenCode installation

1. Build and register this MCP server, then verify a local lookup.
2. Remove the old copied `wow-api-lookup.ts`, `wow-event-info.ts`, `wow-wiki-fetch.ts`, and `wow-blizzard-source.ts` from the tool directory used by your previous OpenCode installation. Inspect the files before deleting them so you preserve any local changes.
3. Replace old split WoW skill references with the consolidated `wow-addon` skill. Remove obsolete copied WoW commands or agent registrations if you no longer use them.
4. Remove old annotation `external_directory` permission entries only if you added them for this integration and no other workflow uses them. The MCP server reads the configured local directories itself.

No script performs this migration or edits existing client settings. OpenCode can use the MCP server through its MCP configuration, just like other compatible clients.

## Uninstall

Remove the `wow-addon` MCP entry from your client and reload its connections. To remove an installed skill, run `./uninstall.sh` or `.\uninstall.ps1`. Pass the same custom skills directory used during installation when applicable. The uninstaller asks before removing the skill; `--yes` or `-Yes` skips that prompt.

Annotation repositories remain on disk. Remove those separately when you no longer need them.
