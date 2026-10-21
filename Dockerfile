FROM oven/bun:slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun ci
COPY tsconfig.json ./
COPY mcp ./mcp
RUN bun run build

FROM oven/bun:1.3.12-debian
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && apt-get clean \
  && mkdir -p /data/annotations /data/framexml \
  && chown -R bun:bun /data
WORKDIR /app
COPY package.json bun.lock ./
RUN bun ci --production
COPY --from=build /app/dist ./dist
COPY maintain-annotations.sh ./
ENV WOW_MCP_HOST=0.0.0.0 \
    WOW_MCP_MANAGE_ANNOTATIONS=true \
  PORT=3000 \
  WOW_ANNOTATIONS_ROOT=/data/annotations \
  WOW_FRAMEXML_ROOT=/data/framexml \
  WOW_RG_COMMAND=/usr/bin/rg
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD bun -e 'const response = await fetch("http://127.0.0.1:3000/health"); process.exit(response.ok ? 0 : 1)'
CMD ["bun", "dist/mcp/http-server.mjs"]
