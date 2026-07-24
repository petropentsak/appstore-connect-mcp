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

## Available tools (30)

### Apps & info

| Tool | Description | Key inputs |
|------|-------------|------------|
| `list_apps` | List all apps in App Store Connect | — |
| `get_app_info` | Get detailed information about a specific app | `appId` |
| `get_app_info_details` | Get detailed app info including categories and age rating | `appId` |

### Versions & release

| Tool | Description | Key inputs |
|------|-------------|------------|
| `list_app_store_versions` | List all App Store versions for an app | `appId` |
| `create_app_store_version` | Create a new App Store version | `appId`, `platform`, `versionString` |
| `update_app_store_version_localization` | Update a version's localization (description, keywords, what's new) | `versionId`, `locale` |
| `list_version_localizations` | List the store locales present on a version | `versionId` |
| `attach_build` | Attach a processed TestFlight build to a version | `appId`, `versionId` |
| `submit_for_review` | Submit a version for App Store review | `appId`, `versionId` |
| `release_version` | Release an approved version pending manual developer release | `appId`, `versionString?` |
| `manage_phased_release` | Control the iOS 7-day phased rollout (get/start/pause/resume/complete) | `appId`, `action`, `versionString?` |

### TestFlight & builds

| Tool | Description | Key inputs |
|------|-------------|------------|
| `get_builds` | Get TestFlight build information | `appId` |
| `list_beta_groups` | List TestFlight beta groups | `appId` |
| `add_tester_to_beta_group` | Add a tester to a beta group | `groupId`, `email` |
| `set_beta_whats_new` | Set the TestFlight "what to test" text for a build + locale | `buildId`, `whatsNew`, `locale?` |
| `submit_build_for_beta_review` | Submit a build for TestFlight (beta) app review | `buildId` |
| `expire_build` | Mark a TestFlight build as expired | `buildId` |

### Reviews

| Tool | Description | Key inputs |
|------|-------------|------------|
| `get_customer_reviews` | Get customer reviews for an app | `appId`, `limit?` |
| `reply_to_review` | Post or replace the developer response to a review (max 5970 chars) | `reviewId`, `responseBody` |
| `get_review_response` | Get the existing developer response for a review | `reviewId` |
| `delete_review_response` | Delete a developer response | `responseId` |

### Pricing & availability

| Tool | Description | Key inputs |
|------|-------------|------------|
| `get_app_pricing` | Get current app pricing | `appId` |
| `get_app_price_points` | Get available price points for a territory (id + customer price + proceeds) | `appId`, `territory?` |
| `update_price_schedule` | Set price by creating a new price schedule at a price point | `appId`, `territory`, `pricePointId` |
| `get_app_availability` | Get territory availability | `appId` |
| `set_app_availability` | Set territory availability (v2 API) | `appId`, `territories` |
| `get_in_app_purchases` | Get in-app purchases | `appId` |

### Assets

| Tool | Description | Key inputs |
|------|-------------|------------|
| `upload_screenshot` | Upload one screenshot to a screenshot set (reserve → upload → commit) | `screenshotSetId`, `filePath` |

### Analytics & sales

| Tool | Description | Key inputs |
|------|-------------|------------|
| `get_analytics` | Get app analytics (installs, sessions, retention) | `appId` |
| `get_sales_data` | Get sales and revenue data for a date | `date?` |

## Usage (Claude Code / Desktop)

```jsonc
{
  "mcpServers": {
    "appstore-connect": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:petropentsak/appstore-connect-mcp"],
      "env": {
        "ASC_KEY_ID": "...",
        "ASC_ISSUER_ID": "...",
        "ASC_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
      }
    }
  }
}
```

The URL is **not** pinned — it tracks the default-branch HEAD (`dist/` is committed, so there is **no build step at launch**, which is what keeps `npx github:` reliable). Because there is no version pin, every commit on the default branch must be installable.

## Development

```bash
npm install
npm run build      # tsc -> dist/ (commit dist/ so npx github: needs no build)
npm run dev        # tsx src/index.ts
```

Release flow: edit → `npm run build` → commit (include `dist/`) → `git push origin HEAD` (default branch, no tag) → clear `~/.npm/_npx` if a stale tarball is cached → reconnect / cold-start the MCP client.

## Credit

Based on [ryaker/appstore-connect-mcp](https://github.com/ryaker/appstore-connect-mcp). MIT license retained.
