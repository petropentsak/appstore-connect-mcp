#!/usr/bin/env node
/**
 * Local stdio MCP server for App Store Connect (fork of ryaker/appstore-connect-mcp, MIT).
 * All hosted infra (Express/OAuth/Auth0/Stytch/Supabase/Vercel) has been stripped:
 * credentials come only from environment variables, JWTs are signed locally, and every
 * request goes directly to api.appstoreconnect.apple.com. Nothing is sent to any third party.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
/**
 * Create and configure MCP Server with Apple Store Connect tools
 */
declare function createMcpServer(): Server;
export { createMcpServer };
