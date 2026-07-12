# Mono MCP Adapter

This is a separate Streamable HTTP MCP process. It does not contain Mono business
logic or provider keys. It authenticates MCP clients, then calls the Workbench
Mono Creative Service API.

```bash
MONO_MCP_API_KEY=client-token \
MONO_PLATFORM_API_KEY=platform-token \
MONO_SERVICE_URL=http://127.0.0.1:3000 \
npm run mono:mcp
```

The endpoint is `http://127.0.0.1:8787/mcp`. Configure Hermes with that remote
MCP URL and its bearer token only after its deployment confirms Streamable HTTP
MCP support. `mono_generate_image` uses the same server-side batch contract as
the Workbench Image2 workspace and direct chat tool.
