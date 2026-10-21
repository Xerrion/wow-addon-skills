# Streamable HTTP on Coolify

Deploy this repository with the Docker Compose build pack. The Bun server exposes `/mcp` on container port `3000`. Coolify terminates HTTPS and forwards requests to that port. The [Coolify Compose documentation](https://coolify.io/docs/applications/builds/docker-compose) explains the build pack and domain configuration.

1. Create a Git-based application in Coolify, select the Docker Compose build pack, and use `compose.yaml` from the repository root.
2. Set the required runtime environment variables:

   | Variable             | Value                                                              |
   | -------------------- | ------------------------------------------------------------------ |
   | `WOW_MCP_PUBLIC_URL` | Your HTTPS origin, such as `https://wow-mcp.example.com`           |
   | `WOW_MCP_TOKEN`      | A random secret of at least 32 printable characters without spaces |

   Generate a token locally with Bun:

   ```sh
   bun -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
   ```

3. Assign the `wow-addon-mcp` service a domain using internal port `3000`, for example `https://wow-mcp.example.com:3000`, then deploy. The public MCP URL is `https://wow-mcp.example.com/mcp`. The port suffix in Coolify selects the container port; clients use the normal HTTPS URL.
4. Wait for `/ready` to return HTTP `200`. The server downloads the shared API catalog and all four FrameXML flavors into the persistent volume automatically. Runtime logs show clone and update progress. During initial setup, `/health` stays available and authenticated MCP requests return `503` with a retry hint.

5. Print the finished settings from the container terminal:

   ```sh
   bun run config:http
   ```

   Copy the JSON into a client that accepts Streamable HTTP URLs and custom headers. Reload its MCP connections, confirm four tools are listed, then call `wow-event-info` with `{"event":"PLAYER_LOGIN"}`. The JSON contains the secret token. Store it in your client's secret settings when supported.

## Storage and health

The `annotations` volume is mounted at `/data`. The server runs as the unprivileged `bun` user. Shared API annotations live in `/data/annotations`; FrameXML worktrees live in `/data/framexml`. Keep these mount paths stable because Git worktree metadata records absolute paths. Container rebuilds preserve the volume. Back it up before removing the application or volume.

`GET /health` returns HTTP `200` without authentication while the process is running. Its JSON reports `status`, annotation readiness, whether an update is running, the last successful refresh time in Unix milliseconds, and whether the latest update failed. `GET /ready` returns `503` until the required catalogs and all four flavor directories are populated, then `200`. The Docker image checks `/health` so the initial download can finish without a health-check restart. The Compose file exposes the application only to the container network; Coolify's proxy provides public access.

## Automatic annotation updates

The server uses `maintain-annotations.sh` to clone the maintained Ketho API repository and the NumyAddon FrameXML repository. It refreshes all supported flavors every 24 hours after a successful update. Git updates use fast-forward pulls and retain the maintenance script's repository-origin and destination checks. A saved refresh timestamp at `/data/framexml.update.json` survives container replacement and prevents each restart from triggering another download.

Warm starts serve existing data immediately. If data is missing, startup repairs it even when the saved refresh timestamp is recent. If an update fails, existing local data stays available where usable and the server retries after one hour. Tools read annotation files on each call, so updates take effect without restarting MCP. Failed initial downloads leave MCP unready until a retry succeeds. Each maintenance attempt has a 30-minute timeout.

One maintenance run can be active per process. Use one application replica per annotation volume. Shutdown cancels the timer and terminates an active maintenance process, including Git descendants. Set `WOW_MCP_MANAGE_ANNOTATIONS=false` only for annotation storage you maintain separately; this disables automatic downloads and readiness checks for annotation contents.

The MCP endpoint requires `Authorization: Bearer <WOW_MCP_TOKEN>` on every request. Requests with an unexpected Host or Origin are rejected. HTTPS is required for the configured public origin outside localhost. The configured origin is the only accepted browser Origin; native MCP clients can omit Origin. The server does not use forwarded headers to override these checks. Keep the proxy's upstream Host header equal to the configured public hostname.

## Transport behavior

The endpoint uses the official SDK's [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), with SSE responses and a new MCP server instance per request. It supports current requests and the older `initialize` handshake without storing sessions or requiring sticky routing. Standalone GET streams and DELETE session operations return `405`. Request bodies are limited to 1 MiB.

This deployment uses one shared bearer token for a private instance. Every authenticated client can query the same annotation storage. Clients that require interactive OAuth discovery need an OAuth resource-server integration, which is not included. Wiki fetches run on the host and can contact only Warcraft Wiki under the existing tool restrictions.

When using another reverse proxy, preserve streaming responses and disable response buffering. The application sends `X-Accel-Buffering: no` and `Cache-Control: no-store` on MCP responses. SIGINT and SIGTERM close the HTTP listener and active MCP exchanges.

## Run HTTP locally

After `bun ci` and `bun run build`, start a loopback-only server:

```sh
export WOW_MCP_TOKEN="$(bun -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
bun run start:http
```

The default endpoint is `http://127.0.0.1:3000/mcp`. Keep the token in the same shell when running `bun run config:http`. Use `PORT` to change the port. Existing `WOW_ANNOTATIONS_ROOT`, `WOW_FRAMEXML_ROOT`, and `WOW_RG_COMMAND` settings work with both transports. HTTP manages those annotation directories automatically; the interactive installer continues to prepare local stdio settings with its existing annotation choice.
