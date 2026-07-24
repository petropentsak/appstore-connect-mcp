#!/usr/bin/env node
/**
 * Local stdio MCP server for App Store Connect (fork of ryaker/appstore-connect-mcp, MIT).
 * All hosted infra (Express/OAuth/Auth0/Stytch/Supabase/Vercel) has been stripped:
 * credentials come only from environment variables, JWTs are signed locally, and every
 * request goes directly to api.appstoreconnect.apple.com. Nothing is sent to any third party.
 */
// stdio transport uses stdout for the JSON-RPC stream — any stray stdout write corrupts it.
// Redirect all console.log to stderr before anything else loads.
console.log = (...args) => console.error(...args);
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AppStoreConnectClient } from './appstore-client.js';
import dotenv from 'dotenv';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
// Load environment variables (harmless no-op when launched with env already injected).
dotenv.config();
// Read a credential from the ASC_* names (primary), falling back to the upstream APPLE_* names.
function readEnv(ascName, appleName) {
    return (process.env[ascName] || process.env[appleName] || '').trim();
}
// Function to get App Store config at runtime.
function getAppStoreConfig() {
    // Handle a private key supplied either as raw PEM or base64-encoded PEM.
    let privateKey = readEnv('ASC_PRIVATE_KEY', 'APPLE_PRIVATE_KEY');
    if (!privateKey) {
        console.error('❌ ASC_PRIVATE_KEY (or APPLE_PRIVATE_KEY) is not set!');
    }
    else if (!privateKey.includes('BEGIN PRIVATE KEY')) {
        try {
            const decoded = Buffer.from(privateKey, 'base64').toString('utf-8').trim();
            if (decoded.includes('BEGIN PRIVATE KEY'))
                privateKey = decoded;
            else
                privateKey = privateKey.replace(/\\n/g, '\n');
        }
        catch {
            privateKey = privateKey.replace(/\\n/g, '\n');
        }
    }
    else {
        privateKey = privateKey.replace(/\\n/g, '\n');
    }
    return {
        keyId: readEnv('ASC_KEY_ID', 'APPLE_KEY_ID'),
        issuerId: readEnv('ASC_ISSUER_ID', 'APPLE_ISSUER_ID'),
        privateKey: privateKey.trim(),
        bundleId: readEnv('ASC_BUNDLE_ID', 'APPLE_BUNDLE_ID'),
        appStoreId: readEnv('ASC_APP_STORE_ID', 'APPLE_APP_STORE_ID') || undefined,
        vendorNumber: readEnv('ASC_VENDOR_NUMBER', 'APPLE_VENDOR_NUMBER') || undefined,
    };
}
/**
 * Create and configure MCP Server with Apple Store Connect tools
 */
function createMcpServer() {
    const server = new Server({
        name: 'appstore-connect-server',
        version: '2.1.0',
    }, {
        capabilities: {
            tools: {},
        },
    });
    // Initialize Apple Store Connect client
    const appStoreConfig = getAppStoreConfig();
    const appStoreClient = new AppStoreConnectClient(appStoreConfig);
    // List available tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: 'list_apps',
                    description: 'List all apps in App Store Connect',
                    inputSchema: {
                        type: 'object',
                        properties: {},
                    },
                },
                {
                    name: 'get_app_info',
                    description: 'Get detailed information about a specific app',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: {
                                type: 'string',
                                description: 'The App Store Connect app ID',
                            },
                        },
                        required: ['appId'],
                    },
                },
                {
                    name: 'get_sales_data',
                    description: 'Get sales and revenue data for a specific date',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            date: {
                                type: 'string',
                                description: 'Date in YYYY-MM-DD format (optional, defaults to today)',
                            },
                        },
                    },
                },
                {
                    name: 'get_analytics',
                    description: 'Get app analytics data including installs, sessions, and retention',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: {
                                type: 'string',
                                description: 'The App Store Connect app ID',
                            },
                        },
                        required: ['appId'],
                    },
                },
                {
                    name: 'get_builds',
                    description: 'Get TestFlight build information for an app',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: {
                                type: 'string',
                                description: 'The App Store Connect app ID',
                            },
                        },
                        required: ['appId'],
                    },
                },
                {
                    name: 'create_app_store_version',
                    description: 'Create a new app store version for an app',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: {
                                type: 'string',
                                description: 'The ID of the app',
                            },
                            platform: {
                                type: 'string',
                                description: 'The platform (IOS, MAC_OS, TV_OS, VISION_OS)',
                                enum: ['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'],
                            },
                            versionString: {
                                type: 'string',
                                description: 'Version string in format X.Y or X.Y.Z (e.g., "1.0" or "1.0.0")',
                            },
                            copyright: {
                                type: 'string',
                                description: 'Copyright text for this version (optional)',
                            },
                            releaseType: {
                                type: 'string',
                                description: 'How the app should be released (optional)',
                                enum: ['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'],
                            },
                            earliestReleaseDate: {
                                type: 'string',
                                description: 'ISO 8601 date string for scheduled release (required when releaseType is SCHEDULED)',
                            },
                            buildId: {
                                type: 'string',
                                description: 'ID of the build to associate with this version (optional)',
                            },
                        },
                        required: ['appId', 'platform', 'versionString'],
                    },
                },
                {
                    name: 'attach_build',
                    description: 'Attach a processed TestFlight build to an App Store version. Single-shot: returns attached | processing | not_found so the caller can retry while the build is still processing.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: { type: 'string', description: 'Numeric app ID or bundle ID' },
                            versionId: { type: 'string', description: 'App Store version ID to attach the build to' },
                            buildId: { type: 'string', description: 'Build ID to attach (optional; else located by buildVersionString)' },
                            buildVersionString: { type: 'string', description: 'Build (version) string to locate the latest matching build' },
                        },
                        required: ['appId', 'versionId'],
                    },
                },
                {
                    name: 'submit_for_review',
                    description: 'Submit an App Store version for review (iOS reviewSubmissions flow). Optionally sets the release type first.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: { type: 'string', description: 'Numeric app ID or bundle ID' },
                            versionId: { type: 'string', description: 'App Store version ID to submit' },
                            releaseType: {
                                type: 'string',
                                description: 'Optional release type to set before submitting',
                                enum: ['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'],
                            },
                        },
                        required: ['appId', 'versionId'],
                    },
                },
                {
                    name: 'list_version_localizations',
                    description: 'List the store locales (and their release notes / promo text) present on an App Store version.',
                    inputSchema: {
                        type: 'object',
                        properties: { versionId: { type: 'string', description: 'App Store version ID' } },
                        required: ['versionId'],
                    },
                },
                {
                    name: 'list_app_store_versions',
                    description: 'List all app store versions for an app',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: {
                                type: 'string',
                                description: 'The ID of the app',
                            },
                        },
                        required: ['appId'],
                    },
                },
                {
                    name: 'update_app_store_version_localization',
                    description: 'Update app store version localization (descriptions, keywords, what\'s new)',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            versionId: {
                                type: 'string',
                                description: 'The ID of the app store version',
                            },
                            locale: {
                                type: 'string',
                                description: 'The locale code (e.g., "en-US", "es-ES", "fr-FR")',
                            },
                            description: {
                                type: 'string',
                                description: 'App description for this locale (4000 chars max)',
                            },
                            keywords: {
                                type: 'string',
                                description: 'Keywords for app store search (100 chars max)',
                            },
                            whatsNew: {
                                type: 'string',
                                description: 'Release notes / what\'s new text (4000 chars max)',
                            },
                            promotionalText: {
                                type: 'string',
                                description: 'Promotional text (170 chars max)',
                            },
                            supportUrl: {
                                type: 'string',
                                description: 'Support URL for this locale',
                            },
                            marketingUrl: {
                                type: 'string',
                                description: 'Marketing URL for this locale',
                            },
                        },
                        required: ['versionId', 'locale'],
                    },
                },
                {
                    name: 'list_beta_groups',
                    description: 'List all TestFlight beta groups for an app',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: {
                                type: 'string',
                                description: 'The ID of the app',
                            },
                        },
                        required: ['appId'],
                    },
                },
                {
                    name: 'add_tester_to_beta_group',
                    description: 'Add a tester to a TestFlight beta group',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            groupId: {
                                type: 'string',
                                description: 'The ID of the beta group',
                            },
                            email: {
                                type: 'string',
                                description: 'Email address of the tester',
                            },
                            firstName: {
                                type: 'string',
                                description: 'First name of the tester (optional)',
                            },
                            lastName: {
                                type: 'string',
                                description: 'Last name of the tester (optional)',
                            },
                        },
                        required: ['groupId', 'email'],
                    },
                },
                {
                    name: 'get_customer_reviews',
                    description: 'Get customer reviews for an app',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: {
                                type: 'string',
                                description: 'The ID of the app',
                            },
                            limit: {
                                type: 'number',
                                description: 'Maximum number of reviews to return (default: 50)',
                            },
                        },
                        required: ['appId'],
                    },
                },
                {
                    name: 'get_app_pricing',
                    description: 'Get app pricing information',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: {
                                type: 'string',
                                description: 'The ID of the app',
                            },
                        },
                        required: ['appId'],
                    },
                },
                {
                    name: 'get_in_app_purchases',
                    description: 'Get in-app purchases for an app',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: {
                                type: 'string',
                                description: 'The ID of the app',
                            },
                        },
                        required: ['appId'],
                    },
                },
                {
                    name: 'get_app_availability',
                    description: 'Get app availability information',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: {
                                type: 'string',
                                description: 'The ID of the app',
                            },
                        },
                        required: ['appId'],
                    },
                },
                {
                    name: 'get_app_info_details',
                    description: 'Get detailed app info including categories and age rating',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: {
                                type: 'string',
                                description: 'The ID of the app',
                            },
                        },
                        required: ['appId'],
                    },
                },
                {
                    name: 'release_version',
                    description: 'Release an approved App Store version that is waiting for manual developer release. Resolves the version in PENDING_DEVELOPER_RELEASE when versionString is omitted.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: { type: 'string', description: 'Numeric app ID or bundle ID' },
                            versionString: {
                                type: 'string',
                                description: 'Version to release (optional; defaults to the one pending developer release)',
                            },
                        },
                        required: ['appId'],
                    },
                },
                {
                    name: 'manage_phased_release',
                    description: 'Control the iOS 7-day phased release for a version: get current state, start (ACTIVE), pause, resume, or complete (release to all users at once).',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: { type: 'string', description: 'Numeric app ID or bundle ID' },
                            versionString: {
                                type: 'string',
                                description: 'Version to control (optional; defaults to the latest version)',
                            },
                            action: {
                                type: 'string',
                                description: 'Phased release action',
                                enum: ['get', 'start', 'pause', 'resume', 'complete'],
                            },
                        },
                        required: ['appId', 'action'],
                    },
                },
                {
                    name: 'reply_to_review',
                    description: 'Post or replace the developer response to a customer review (max 5970 chars).',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            reviewId: { type: 'string', description: 'The customer review ID' },
                            responseBody: { type: 'string', description: 'Response text (5970 chars max)' },
                        },
                        required: ['reviewId', 'responseBody'],
                    },
                },
                {
                    name: 'get_review_response',
                    description: 'Get the existing developer response for a customer review.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            reviewId: { type: 'string', description: 'The customer review ID' },
                        },
                        required: ['reviewId'],
                    },
                },
                {
                    name: 'delete_review_response',
                    description: 'Delete a developer response to a customer review.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            responseId: { type: 'string', description: 'The customer review response ID' },
                        },
                        required: ['responseId'],
                    },
                },
                {
                    name: 'set_beta_whats_new',
                    description: 'Set the TestFlight "what to test" text for a build and locale.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            buildId: { type: 'string', description: 'The build ID' },
                            locale: { type: 'string', description: 'Locale code (default "en-US")' },
                            whatsNew: { type: 'string', description: 'What to test text' },
                        },
                        required: ['buildId', 'whatsNew'],
                    },
                },
                {
                    name: 'submit_build_for_beta_review',
                    description: 'Submit a build for TestFlight (beta) app review.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            buildId: { type: 'string', description: 'The build ID' },
                        },
                        required: ['buildId'],
                    },
                },
                {
                    name: 'expire_build',
                    description: 'Mark a TestFlight build as expired.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            buildId: { type: 'string', description: 'The build ID' },
                        },
                        required: ['buildId'],
                    },
                },
                {
                    name: 'get_app_price_points',
                    description: 'Get available price points for an app in a territory (id + customer price + proceeds). The id feeds update_price_schedule.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: { type: 'string', description: 'Numeric app ID or bundle ID' },
                            territory: { type: 'string', description: 'Territory code (default "USA")' },
                        },
                        required: ['appId'],
                    },
                },
                {
                    name: 'update_price_schedule',
                    description: 'Set an app price by creating a new price schedule pinned to a price point in a base territory (modern pricing API).',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: { type: 'string', description: 'Numeric app ID or bundle ID' },
                            territory: { type: 'string', description: 'Base territory code (e.g. "USA")' },
                            pricePointId: { type: 'string', description: 'Price point ID from get_app_price_points' },
                        },
                        required: ['appId', 'territory', 'pricePointId'],
                    },
                },
                {
                    name: 'set_app_availability',
                    description: 'Set an app\'s territory availability via the v2 appAvailabilities API.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            appId: { type: 'string', description: 'Numeric app ID or bundle ID' },
                            territories: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Territory codes the app should be available in',
                            },
                            availableInNewTerritories: {
                                type: 'boolean',
                                description: 'Whether to auto-enable future new territories (default false)',
                            },
                        },
                        required: ['appId', 'territories'],
                    },
                },
                {
                    name: 'upload_screenshot',
                    description: 'Upload one screenshot to an app screenshot set (reserve, upload byte ranges to pre-signed URLs, commit with MD5).',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            screenshotSetId: { type: 'string', description: 'The app screenshot set ID' },
                            filePath: { type: 'string', description: 'Absolute path to the screenshot file' },
                        },
                        required: ['screenshotSetId', 'filePath'],
                    },
                },
            ],
        };
    });
    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        try {
            switch (name) {
                case 'list_apps': {
                    const apps = await appStoreClient.listApps();
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Found ${apps.length} apps:\n\n${apps
                                    .map((app) => `• ${app.name} (${app.bundleId})\n  Status: ${app.status}\n  App Store ID: ${app.appStoreId || 'N/A'}\n  Platform: ${app.platform || 'N/A'}`)
                                    .join('\n\n')}`,
                            },
                        ],
                    };
                }
                case 'get_app_info': {
                    const { appId } = args;
                    const appInfo = await appStoreClient.getAppInfo(appId);
                    if (!appInfo) {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: `App not found with ID: ${appId}`,
                                },
                            ],
                        };
                    }
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `App Information:
• Name: ${appInfo.name}
• Bundle ID: ${appInfo.bundleId}
• App Store ID: ${appInfo.appStoreId || 'N/A'}
• Status: ${appInfo.status}
• Version: ${appInfo.version || 'N/A'}
• Platform: ${appInfo.platform || 'N/A'}`,
                            },
                        ],
                    };
                }
                case 'get_sales_data': {
                    const { date } = args;
                    const salesData = await appStoreClient.getSalesData(date);
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Sales Data for ${salesData.date}:
• Revenue: ${salesData.currency} ${salesData.revenue.toFixed(2)}
• Units Sold: ${salesData.units}
• Transaction Count: ${salesData.transactionCount}
• Currency: ${salesData.currency}`,
                            },
                        ],
                    };
                }
                case 'get_analytics': {
                    const { appId } = args;
                    const analytics = await appStoreClient.getAnalytics(appId);
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Analytics for App ${appId}:
• Total Installs: ${analytics.installs?.toLocaleString() || 'N/A'}
• Total Sessions: ${analytics.sessions?.toLocaleString() || 'N/A'}
• Active Users: ${analytics.activeUsers?.toLocaleString() || 'N/A'}
• Retention Rates:
  - Day 1: ${((analytics.retention?.day1 || 0) * 100).toFixed(1)}%
  - Day 7: ${((analytics.retention?.day7 || 0) * 100).toFixed(1)}%
  - Day 30: ${((analytics.retention?.day30 || 0) * 100).toFixed(1)}%`,
                            },
                        ],
                    };
                }
                case 'get_builds': {
                    const { appId } = args;
                    const builds = await appStoreClient.getBuilds(appId);
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `TestFlight Builds for App ${appId}:

${builds
                                    .map((build, index) => `${index + 1}. Version ${build.version} (Build ${build.buildNumber})
   • Processing State: ${build.processingState}
   • Uploaded: ${new Date(build.uploadedDate).toLocaleDateString()}
   • Build ID: ${build.id}`)
                                    .join('\n\n')}`,
                            },
                        ],
                    };
                }
                case 'create_app_store_version': {
                    const { appId, platform, versionString, copyright, releaseType, earliestReleaseDate, buildId } = args;
                    const version = await appStoreClient.createAppStoreVersion({
                        appId,
                        platform,
                        versionString,
                        copyright,
                        releaseType,
                        earliestReleaseDate,
                        buildId,
                    });
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `✅ App Store Version Created Successfully:
• Version: ${version.versionString}
• Platform: ${version.platform}
• State: ${version.appStoreState}
• Release Type: ${version.releaseType || 'MANUAL'}
• Version ID: ${version.id}
${version.earliestReleaseDate ? `• Scheduled Release: ${version.earliestReleaseDate}` : ''}
${version.copyright ? `• Copyright: ${version.copyright}` : ''}
• Created: ${new Date(version.createdDate).toLocaleString()}`,
                            },
                        ],
                    };
                }
                case 'list_app_store_versions': {
                    const { appId } = args;
                    const versions = await appStoreClient.listAppStoreVersions(appId);
                    if (versions.length === 0) {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: `No app store versions found for app ID: ${appId}`,
                                },
                            ],
                        };
                    }
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `📱 App Store Versions for App ${appId}:

${versions
                                    .map((version, index) => `${index + 1}. Version ${version.versionString}
   • Platform: ${version.platform}
   • State: ${version.appStoreState}
   • Release Type: ${version.releaseType || 'MANUAL'}
   • Version ID: ${version.id}
   ${version.earliestReleaseDate ? `• Scheduled: ${new Date(version.earliestReleaseDate).toLocaleDateString()}` : ''}
   ${version.copyright ? `• Copyright: ${version.copyright}` : ''}
   • Created: ${new Date(version.createdDate).toLocaleDateString()}`)
                                    .join('\n\n')}`,
                            },
                        ],
                    };
                }
                case 'update_app_store_version_localization': {
                    const { versionId, locale, description, keywords, whatsNew, promotionalText, supportUrl, marketingUrl, } = args;
                    const localization = await appStoreClient.updateAppStoreVersionLocalization({
                        versionId,
                        locale,
                        description,
                        keywords,
                        whatsNew,
                        promotionalText,
                        supportUrl,
                        marketingUrl,
                    });
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `✅ App Store Version Localization Updated:
• Version ID: ${versionId}
• Locale: ${locale}
• Localization ID: ${localization.id}
${description ? `• Description: ${description.substring(0, 100)}...` : ''}
${keywords ? `• Keywords: ${keywords}` : ''}
${whatsNew ? `• What's New: ${whatsNew.substring(0, 100)}...` : ''}
${promotionalText ? `• Promotional Text: ${promotionalText}` : ''}
${supportUrl ? `• Support URL: ${supportUrl}` : ''}
${marketingUrl ? `• Marketing URL: ${marketingUrl}` : ''}`,
                            },
                        ],
                    };
                }
                case 'list_beta_groups': {
                    const { appId } = args;
                    const groups = await appStoreClient.listBetaGroups(appId);
                    if (groups.length === 0) {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: `No beta groups found for app ID: ${appId}`,
                                },
                            ],
                        };
                    }
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `🧪 TestFlight Beta Groups for App ${appId}:

${groups
                                    .map((group, index) => `${index + 1}. ${group.name}
   • Group ID: ${group.id}
   • Type: ${group.isInternalGroup ? 'Internal' : 'External'}
   ${group.publicLinkEnabled ? `• Public Link: ${group.publicLink}` : ''}
   ${group.publicLinkLimitEnabled ? `• Limit: ${group.publicLinkLimit} testers` : ''}
   • Created: ${new Date(group.createdDate).toLocaleDateString()}`)
                                    .join('\n\n')}`,
                            },
                        ],
                    };
                }
                case 'add_tester_to_beta_group': {
                    const { groupId, email, firstName, lastName } = args;
                    const result = await appStoreClient.addTesterToBetaGroup({
                        groupId,
                        email,
                        firstName,
                        lastName,
                    });
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `✅ ${result.message}
• Email: ${result.email}
• Group ID: ${result.groupId}
• Tester ID: ${result.testerId}
${firstName || lastName ? `• Name: ${firstName || ''} ${lastName || ''}` : ''}`,
                            },
                        ],
                    };
                }
                case 'get_customer_reviews': {
                    const { appId, limit } = args;
                    const reviews = await appStoreClient.getCustomerReviews(appId, limit || 50);
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `📝 Customer Reviews for App ${appId}:

${reviews.length === 0 ? 'No reviews found.' : reviews
                                    .map((review, index) => `${index + 1}. ${review.title || 'Untitled'}
   • Rating: ${'⭐'.repeat(review.rating)}
   • Reviewer: ${review.reviewerNickname}
   • Territory: ${review.territory}
   • Date: ${new Date(review.createdDate).toLocaleDateString()}
   ${review.body ? `• Review: ${review.body.substring(0, 200)}${review.body.length > 200 ? '...' : ''}` : ''}`)
                                    .join('\n\n')}`,
                            },
                        ],
                    };
                }
                case 'get_app_pricing': {
                    const { appId } = args;
                    const pricing = await appStoreClient.getAppPricing(appId);
                    return {
                        content: [
                            {
                                type: 'text',
                                text: pricing ? `💰 App Pricing for App ${appId}:

• Base Territory: ${pricing.baseTerritory}
• Currency: ${pricing.currency}

${pricing.prices.length === 0 ? 'No pricing data available.' : pricing.prices
                                    .map((price, index) => `${index + 1}. ${price.territory}
   • Customer Price: ${price.price}
   • Developer Proceeds: ${price.proceeds}`)
                                    .join('\n\n')}` : `No pricing information found for app ${appId}.`,
                            },
                        ],
                    };
                }
                case 'get_in_app_purchases': {
                    const { appId } = args;
                    const purchases = await appStoreClient.getInAppPurchases(appId);
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `🛒 In-App Purchases for App ${appId}:

${purchases.length === 0 ? 'No in-app purchases found.' : purchases
                                    .map((iap, index) => `${index + 1}. ${iap.name}
   • Product ID: ${iap.productId}
   • Type: ${iap.inAppPurchaseType}
   • State: ${iap.state}
   • Family Sharable: ${iap.familySharable ? 'Yes' : 'No'}
   • Available in All Territories: ${iap.availableInAllTerritories ? 'Yes' : 'No'}
   ${iap.reviewNote ? `• Review Note: ${iap.reviewNote}` : ''}`)
                                    .join('\n\n')}`,
                            },
                        ],
                    };
                }
                case 'get_app_availability': {
                    const { appId } = args;
                    const availability = await appStoreClient.getAppAvailability(appId);
                    return {
                        content: [
                            {
                                type: 'text',
                                text: availability ? `🌍 App Availability for App ${appId}:

• Available in New Territories: ${availability.availableInNewTerritories ? 'Yes' : 'No'}

Available Territories:
${availability.territories.length === 0 ? 'All territories' : availability.territories
                                    .map((territory, index) => `${index + 1}. ${territory}`)
                                    .join('\n')}` : `No availability information found for app ${appId}.`,
                            },
                        ],
                    };
                }
                case 'get_app_info_details': {
                    const { appId } = args;
                    const details = await appStoreClient.getAppInfoDetails(appId);
                    return {
                        content: [
                            {
                                type: 'text',
                                text: details ? `ℹ️  Detailed App Info for App ${appId}:

• App Store State: ${details.appStoreState}
• Age Rating: ${details.appStoreAgeRating}
${details.brazilAgeRating ? `• Brazil Age Rating: ${details.brazilAgeRating}` : ''}
${details.kidsAgeBand ? `• Kids Age Band: ${details.kidsAgeBand}` : ''}

Categories:
• Primary Category ID: ${details.primaryCategory || 'Not set'}
${details.primarySubcategoryOne ? `• Primary Subcategory 1: ${details.primarySubcategoryOne}` : ''}
${details.primarySubcategoryTwo ? `• Primary Subcategory 2: ${details.primarySubcategoryTwo}` : ''}
${details.secondaryCategory ? `• Secondary Category: ${details.secondaryCategory}` : ''}
${details.secondarySubcategoryOne ? `• Secondary Subcategory 1: ${details.secondarySubcategoryOne}` : ''}
${details.secondarySubcategoryTwo ? `• Secondary Subcategory 2: ${details.secondarySubcategoryTwo}` : ''}` : `No detailed info found for app ${appId}.`,
                            },
                        ],
                    };
                }
                case 'attach_build': {
                    const { appId, versionId, buildId, buildVersionString } = args;
                    const r = await appStoreClient.attachBuild({ appId, versionId, buildId, buildVersionString });
                    const msg = r.status === 'attached'
                        ? `✅ Build ${r.buildId} attached to version ${versionId}.`
                        : r.status === 'processing'
                            ? `⏳ Build ${r.buildId ?? ''} still processing (state: ${r.processingState}). Retry shortly.`
                            : `❔ No matching build found yet for version ${versionId}. Retry once the upload appears.`;
                    return { content: [{ type: 'text', text: msg }] };
                }
                case 'list_version_localizations': {
                    const { versionId } = args;
                    const locs = await appStoreClient.listVersionLocalizations(versionId);
                    const text = locs.length ? locs.map((l) => `• ${l.locale}`).join('\n') : 'No localizations.';
                    return { content: [{ type: 'text', text: `🌐 Localizations on version ${versionId}:\n${text}` }] };
                }
                case 'submit_for_review': {
                    const { appId, versionId, releaseType } = args;
                    const r = await appStoreClient.submitForReview({ appId, versionId, releaseType });
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `✅ Submitted version ${versionId} for App Store review${releaseType ? ` (${releaseType} release)` : ''}. Submission ID: ${r.submissionId}`,
                            },
                        ],
                    };
                }
                case 'release_version': {
                    const { appId, versionString } = args;
                    const r = await appStoreClient.releaseVersion({ appId, versionString });
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `🚀 Released version ${r.versionString}. Release request ID: ${r.releaseRequestId}`,
                            },
                        ],
                    };
                }
                case 'manage_phased_release': {
                    const { appId, versionString, action } = args;
                    const r = await appStoreClient.managePhasedRelease({ appId, versionString, action });
                    return {
                        content: [
                            {
                                type: 'text',
                                text: action === 'get'
                                    ? `📶 Phased release for version ${r.versionString}: ${r.state}${r.id ? ` (id: ${r.id})` : ''}`
                                    : `✅ Phased release for version ${r.versionString} — ${action} → ${r.state}${r.id ? ` (id: ${r.id})` : ''}`,
                            },
                        ],
                    };
                }
                case 'reply_to_review': {
                    const { reviewId, responseBody } = args;
                    const r = await appStoreClient.replyToReview({ reviewId, responseBody });
                    return {
                        content: [
                            { type: 'text', text: `✅ Replied to review ${reviewId}. Response ID: ${r.responseId}` },
                        ],
                    };
                }
                case 'get_review_response': {
                    const { reviewId } = args;
                    const r = await appStoreClient.getReviewResponse(reviewId);
                    return {
                        content: [
                            {
                                type: 'text',
                                text: r
                                    ? `💬 Response to review ${reviewId} (${r.state || 'N/A'}):\n${r.responseBody}`
                                    : `No developer response found for review ${reviewId}.`,
                            },
                        ],
                    };
                }
                case 'delete_review_response': {
                    const { responseId } = args;
                    await appStoreClient.deleteReviewResponse(responseId);
                    return {
                        content: [{ type: 'text', text: `🗑️  Deleted review response ${responseId}.` }],
                    };
                }
                case 'set_beta_whats_new': {
                    const { buildId, locale, whatsNew } = args;
                    const r = await appStoreClient.setBetaWhatsNew({
                        buildId,
                        locale: locale || 'en-US',
                        whatsNew,
                    });
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `✅ ${r.created ? 'Created' : 'Updated'} TestFlight "what to test" for build ${buildId} (${r.locale}). Localization ID: ${r.id}`,
                            },
                        ],
                    };
                }
                case 'submit_build_for_beta_review': {
                    const { buildId } = args;
                    const r = await appStoreClient.submitBuildForBetaReview(buildId);
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `✅ Submitted build ${buildId} for TestFlight beta review${r.state ? ` (${r.state})` : ''}. Submission ID: ${r.submissionId}`,
                            },
                        ],
                    };
                }
                case 'expire_build': {
                    const { buildId } = args;
                    const r = await appStoreClient.expireBuild(buildId);
                    return {
                        content: [{ type: 'text', text: `✅ Build ${r.buildId} marked expired.` }],
                    };
                }
                case 'get_app_price_points': {
                    const { appId, territory } = args;
                    const points = await appStoreClient.getAppPricePoints({
                        appId,
                        territory: territory || 'USA',
                    });
                    return {
                        content: [
                            {
                                type: 'text',
                                text: points.length
                                    ? `💵 Price points for app ${appId} (${territory || 'USA'}):\n\n${points
                                        .map((p, i) => `${i + 1}. ${p.customerPrice ?? 'N/A'} (proceeds: ${p.proceeds ?? 'N/A'})\n   • ID: ${p.id}`)
                                        .join('\n')}`
                                    : `No price points found for app ${appId} in ${territory || 'USA'}.`,
                            },
                        ],
                    };
                }
                case 'update_price_schedule': {
                    const { appId, territory, pricePointId } = args;
                    const r = await appStoreClient.updatePriceSchedule({ appId, territory, pricePointId });
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `✅ Created price schedule for app ${appId} in ${territory} at price point ${pricePointId}. Schedule ID: ${r.scheduleId}`,
                            },
                        ],
                    };
                }
                case 'set_app_availability': {
                    const { appId, territories, availableInNewTerritories } = args;
                    const r = await appStoreClient.setAppAvailability({
                        appId,
                        territories,
                        availableInNewTerritories,
                    });
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `✅ Set availability for app ${appId} in ${territories.length} territories. Availability ID: ${r.availabilityId}`,
                            },
                        ],
                    };
                }
                case 'upload_screenshot': {
                    const { screenshotSetId, filePath } = args;
                    const r = await appStoreClient.uploadScreenshot({ screenshotSetId, filePath });
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `🖼️  Uploaded ${r.fileName} (${r.fileSize} bytes) to set ${screenshotSetId}. Screenshot ID: ${r.id}`,
                            },
                        ],
                    };
                }
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        }
        catch (error) {
            console.error(`Error executing tool ${name}:`, error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    });
    return server;
}
/**
 * Start the MCP server over stdio (local, single-tenant).
 */
async function main() {
    // Only the signing credentials are required. bundleId is optional — this server
    // manages many apps, so it is not tied to a single bundle.
    const config = getAppStoreConfig();
    const required = [
        ['keyId', 'ASC_KEY_ID'],
        ['issuerId', 'ASC_ISSUER_ID'],
        ['privateKey', 'ASC_PRIVATE_KEY'],
    ];
    const missing = required.filter(([k]) => !config[k]).map(([, name]) => name);
    if (missing.length > 0) {
        console.error('❌ Missing required credentials:', missing.join(', '));
        process.exit(1);
    }
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('✅ App Store Connect MCP server running on stdio');
    const shutdown = async () => {
        await server.close().catch(() => { });
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
// Start the server if this file is the entry point. Resolve argv[1] through realpath so
// launching via a bin symlink (e.g. `npx github:...`) still matches import.meta.url.
function isMainModule() {
    const entry = process.argv[1];
    if (!entry)
        return false;
    try {
        return import.meta.url === pathToFileURL(realpathSync(entry)).href;
    }
    catch {
        return false;
    }
}
if (isMainModule()) {
    main().catch((error) => {
        console.error('💥 Server crashed:', error);
        process.exit(1);
    });
}
export { createMcpServer };
