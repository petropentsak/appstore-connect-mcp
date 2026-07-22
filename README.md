# appstore-connect-mcp

A **local, single-tenant stdio MCP server** for the Apple App Store Connect API.

Fork of [ryaker/appstore-connect-mcp](https://github.com/ryaker/appstore-connect-mcp) (MIT) with **all hosted infrastructure removed**. This variant exists so App Store Connect credentials never leave the machine.

## Security posture

- **Credentials from environment only.** Reads `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_PRIVATE_KEY` (falls back to `APPLE_*`). Nothing is persisted.
- **No external infrastructure.** The upstream project could store your `.p8` key in Supabase and expose it behind an Auth0/Stytch OAuth server on Vercel. All of that is deleted — no Express, no Supabase, no Auth0/Stytch, no OAuth, no HTTP transport.
- **JWT signed locally** (ES256, `jsonwebtoken`) and every request goes **directly to `api.appstoreconnect.apple.com`**. No proxy, no telemetry, no phone-home.
- **Minimal dependency surface:** `@modelcontextprotocol/sdk`, `jsonwebtoken`, `dotenv`.
- No install-time scripts (`postinstall`/`prepare`).

> Known audit note: `@modelcontextprotocol/sdk` transitively pulls `@hono/node-server` (moderate advisory). It is only used by the SDK's HTTP/SSE transport, which this server never imports — it is not reachable in stdio mode.

## Tools (15)

`list_apps`, `get_app_info`, `get_app_info_details`, `get_app_availability`, `get_app_pricing`,
`get_in_app_purchases`, `get_builds`, `list_app_store_versions`, `create_app_store_version`,
`update_app_store_version_localization`, `get_analytics`, `get_sales_data`, `get_customer_reviews`,
`list_beta_groups`, `add_tester_to_beta_group`.

## Usage (Claude Code / Desktop)

```jsonc
{
  "mcpServers": {
    "appstore-connect": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:petropentsak/appstore-connect-mcp#v0.1.0"],
      "env": {
        "ASC_KEY_ID": "...",
        "ASC_ISSUER_ID": "...",
        "ASC_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
      }
    }
  }
}
```

The URL is pinned to an immutable tag so `npx` caches it. `dist/` is committed, so there is **no build step at launch** (this is what keeps `npx github:` reliable).

## Development

```bash
npm install
npm run build      # tsc -> dist/ (commit dist/ before tagging)
npm run dev        # tsx src/index.ts
```

Release flow: edit → `npm run build` → commit (include `dist/`) → `git tag vX.Y` → `git push origin HEAD --tags` → bump the `#vX.Y` tag in your MCP config.

## Credit

Based on [ryaker/appstore-connect-mcp](https://github.com/ryaker/appstore-connect-mcp). MIT license retained.
