import { createHash, timingSafeEqual } from "node:crypto";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
} from "@modelcontextprotocol/server";
import type { AnnotationStatus } from "./annotations.ts";
import { createServer } from "./index.ts";

const MAX_BODY_BYTES = 1024 * 1024;

export function httpConfiguration(env = process.env) {
  const hostname = env.WOW_MCP_HOST || "127.0.0.1";
  const portValue = env.PORT || "3000";
  if (!/^\d+$/.test(portValue) || Number(portValue) > 65535) {
    throw new Error("PORT must be an integer from 0 to 65535.");
  }
  const token = env.WOW_MCP_TOKEN || "";
  if (!/^[\x21-\x7e]{32,}$/.test(token)) {
    throw new Error(
      "Set WOW_MCP_TOKEN to a secret of at least 32 printable characters without spaces.",
    );
  }
  const loopbackHosts = localhostAllowedHostnames();
  if (!loopbackHosts.includes(hostname) && !env.WOW_MCP_PUBLIC_URL) {
    throw new Error(
      "Set WOW_MCP_PUBLIC_URL to your HTTPS origin when binding beyond localhost.",
    );
  }
  const publicUrl = new URL(
    env.WOW_MCP_PUBLIC_URL || `http://${hostname}:${portValue}`,
  );
  if (
    (publicUrl.protocol !== "https:" &&
      !(
        publicUrl.protocol === "http:" && loopbackHosts.includes(publicUrl.hostname)
      )) ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.search ||
    publicUrl.hash ||
    !["/", "/mcp"].includes(publicUrl.pathname)
  ) {
    throw new Error(
      "WOW_MCP_PUBLIC_URL must be an HTTPS origin or /mcp URL without credentials, query, or fragment. HTTP is allowed on localhost.",
    );
  }
  return { hostname, port: Number(portValue), token, publicUrl };
}

export function createHttpApplication(
  configuration = httpConfiguration(),
  annotations?: () => AnnotationStatus,
) {
  const handler = createMcpHandler(createServer, {
    legacy: "stateless",
    responseMode: "sse",
    maxRequestBodySize: MAX_BODY_BYTES,
  });
  const allowedHosts = [
    ...localhostAllowedHostnames(),
    configuration.publicUrl.hostname,
  ];
  const expectedAuthorization = createHash("sha256")
    .update(configuration.token)
    .digest();

  return {
    close: handler.close,
    async fetch(request: Request): Promise<Response> {
      const rejectedHost = hostHeaderValidationResponse(request, allowedHosts);
      if (rejectedHost) return rejectedHost;
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== configuration.publicUrl.origin) {
        return Response.json({ error: "Origin is not allowed." }, { status: 403 });
      }
      const pathname = new URL(request.url).pathname;
      if (
        ["/health", "/ready"].includes(pathname) &&
        ["GET", "HEAD"].includes(request.method)
      ) {
        const annotationStatus = annotations?.();
        const ready = annotationStatus?.ready ?? true;
        const body = {
          status: ready ? "ok" : "initializing",
          ...(annotationStatus && { annotations: annotationStatus }),
        };
        return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
          status: pathname === "/ready" && !ready ? 503 : 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      if (pathname !== "/mcp") {
        return Response.json({ error: "Not found." }, { status: 404 });
      }
      const authorization = createHash("sha256")
        .update(
          /^Bearer +(.+)$/i.exec(request.headers.get("authorization") || "")?.[1] || "",
        )
        .digest();
      if (!timingSafeEqual(authorization, expectedAuthorization)) {
        return Response.json(
          { error: "A valid Bearer token is required." },
          {
            status: 401,
            headers: { "www-authenticate": 'Bearer realm="wow-addon-mcp"' },
          },
        );
      }
      if (annotations && !annotations().ready) {
        return Response.json(
          {
            error:
              "Annotations are being prepared. Retry after initialization completes.",
          },
          {
            status: 503,
            headers: { "retry-after": "60", "cache-control": "no-store" },
          },
        );
      }
      const response = await handler.fetch(request);
      response.headers.set("cache-control", "no-store");
      response.headers.set("x-accel-buffering", "no");
      return response;
    },
  };
}

export function httpClientConfiguration(configuration = httpConfiguration()) {
  return {
    mcpServers: {
      "wow-addon": {
        url: new URL("/mcp", configuration.publicUrl).href,
        headers: { Authorization: `Bearer ${configuration.token}` },
      },
    },
  };
}
