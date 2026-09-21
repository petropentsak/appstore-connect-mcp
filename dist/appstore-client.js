/**
 * App Store Connect API Client
 * Real implementation using Apple's App Store Connect API
 */
import jwt from 'jsonwebtoken';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
/**
 * Developer-portal capability type -> the entitlement key it authorises in a provisioning
 * profile. The two vocabularies do NOT match: the portal's CARPLAY_NAVIGATION grants
 * com.apple.developer.carplay-maps, and several capabilities grant no key at all.
 * Unmapped types resolve to undefined and are reported as unknown rather than guessed.
 */
const CAPABILITY_ENTITLEMENTS = {
    ACCESS_WIFI_INFORMATION: 'com.apple.developer.networking.wifi-info',
    APPLE_ID_AUTH: 'com.apple.developer.applesignin',
    APPLE_PAY: 'com.apple.developer.in-app-payments',
    APP_ATTEST: 'com.apple.developer.devicecheck.appattest-environment',
    APP_GROUPS: 'com.apple.security.application-groups',
    ASSOCIATED_DOMAINS: 'com.apple.developer.associated-domains',
    AUTOFILL_CREDENTIAL_PROVIDER: 'com.apple.developer.authentication-services.autofill-credential-provider',
    CARPLAY_AUDIO: 'com.apple.developer.carplay-audio',
    CARPLAY_CHARGING: 'com.apple.developer.carplay-charging',
    CARPLAY_COMMUNICATION: 'com.apple.developer.carplay-communication',
    CARPLAY_DRIVING_TASK: 'com.apple.developer.carplay-driving-task',
    CARPLAY_NAVIGATION: 'com.apple.developer.carplay-maps',
    CARPLAY_PARKING: 'com.apple.developer.carplay-parking',
    CARPLAY_QUICK_ORDERING: 'com.apple.developer.carplay-quick-ordering',
    CLASSKIT: 'com.apple.developer.ClassKit-environment',
    DATA_PROTECTION: 'com.apple.developer.default-data-protection',
    GAME_CENTER: 'com.apple.developer.game-center',
    HEALTHKIT: 'com.apple.developer.healthkit',
    HOMEKIT: 'com.apple.developer.homekit',
    HOT_SPOT: 'com.apple.developer.networking.HotspotConfiguration',
    ICLOUD: 'com.apple.developer.icloud-container-identifiers',
    INTER_APP_AUDIO: 'inter-app-audio',
    MAPS: 'com.apple.developer.maps',
    MULTIPATH: 'com.apple.developer.networking.multipath',
    NETWORK_EXTENSIONS: 'com.apple.developer.networking.networkextension',
    NFC_TAG_READING: 'com.apple.developer.nfc.readersession.formats',
    PERSONAL_VPN: 'com.apple.developer.networking.vpn.api',
    PUSH_NOTIFICATIONS: 'aps-environment',
    SIRIKIT: 'com.apple.developer.siri',
    SYSTEM_EXTENSION_INSTALL: 'com.apple.developer.system-extension.install',
    USER_MANAGEMENT: 'com.apple.developer.user-management',
    WALLET: 'com.apple.developer.pass-type-identifiers',
    WIRELESS_ACCESSORY_CONFIGURATION: 'com.apple.external-accessory.wireless-configuration',
    // Needs no entitlement key — StoreKit works from the portal grant alone.
    IN_APP_PURCHASE: '',
    COREMEDIA_HLS_LOW_LATENCY: '',
};
// undefined = this tool has no mapping for the type; '' = the type needs no entitlement key.
export function entitlementKeyFor(capabilityType) {
    return CAPABILITY_ENTITLEMENTS[capabilityType];
}
/**
 * Minimal XML-plist parser — covers everything a provisioning profile contains
 * (dict/array/string/bool/integer/real/date/data). <data> blobs (the embedded developer
 * certificates) are summarised rather than returned, so output stays small.
 */
export function parsePlistXml(xml) {
    let pos = 0;
    const nextTag = () => {
        for (;;) {
            const open = xml.indexOf('<', pos);
            if (open === -1)
                return null;
            if (xml.startsWith('<!--', open)) {
                const commentEnd = xml.indexOf('-->', open);
                pos = commentEnd === -1 ? xml.length : commentEnd + 3;
                continue;
            }
            const close = xml.indexOf('>', open);
            if (close === -1)
                return null;
            const raw = xml.slice(open + 1, close);
            pos = close + 1;
            if (raw.startsWith('?') || raw.startsWith('!'))
                continue; // declaration / doctype
            return {
                name: raw.replace(/^\//, '').replace(/\/$/, '').trim().split(/\s+/)[0],
                closing: raw.startsWith('/'),
                selfClosing: raw.endsWith('/'),
            };
        }
    };
    // Text up to the next tag, then consume that tag (the element's closing tag).
    const textUntilClose = () => {
        const open = xml.indexOf('<', pos);
        const raw = xml.slice(pos, open === -1 ? xml.length : open);
        pos = open === -1 ? xml.length : open;
        nextTag();
        return raw
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&');
    };
    const readValue = (tag) => {
        switch (tag.name) {
            case 'true':
                return true;
            case 'false':
                return false;
            case 'string':
            case 'date':
                return tag.selfClosing ? '' : textUntilClose();
            case 'integer':
            case 'real':
                return tag.selfClosing ? 0 : Number(textUntilClose());
            case 'data': {
                const encoded = tag.selfClosing ? '' : textUntilClose();
                const bytes = Buffer.from(encoded.replace(/\s+/g, ''), 'base64').length;
                return `<data: ${bytes} bytes>`;
            }
            case 'dict': {
                const dict = {};
                if (tag.selfClosing)
                    return dict;
                for (;;) {
                    const keyTag = nextTag();
                    if (!keyTag || keyTag.closing)
                        return dict;
                    if (keyTag.name !== 'key') {
                        throw new Error(`Malformed plist: <${keyTag.name}> where a <key> was expected.`);
                    }
                    const key = keyTag.selfClosing ? '' : textUntilClose();
                    const valueTag = nextTag();
                    if (!valueTag)
                        throw new Error(`Malformed plist: no value for key "${key}".`);
                    dict[key] = readValue(valueTag);
                }
            }
            case 'array': {
                const array = [];
                if (tag.selfClosing)
                    return array;
                for (;;) {
                    const itemTag = nextTag();
                    if (!itemTag || itemTag.closing)
                        return array;
                    array.push(readValue(itemTag));
                }
            }
            default:
                return tag.selfClosing ? '' : textUntilClose();
        }
    };
    let tag = nextTag();
    while (tag && (tag.name === 'plist' || tag.closing))
        tag = nextTag();
    if (!tag)
        throw new Error('Malformed plist: no root element.');
    return readValue(tag);
}
/**
 * A .mobileprovision / profileContent blob is a DER CMS SignedData wrapper around an XML
 * plist. Rather than implement CMS, lift the plist out by its delimiters — the same result
 * as `security cms -D`, with no shell-out and no OS dependency.
 */
export function decodeProvisioningProfile(profileContentBase64) {
    const der = Buffer.from(profileContentBase64, 'base64');
    // latin1 preserves every byte 1:1 through the string round-trip; the slice is re-read as UTF-8.
    const bytes = der.toString('latin1');
    const start = bytes.indexOf('<?xml');
    const end = bytes.lastIndexOf('</plist>');
    if (start === -1 || end === -1) {
        throw new Error('No embedded plist found in the profile (unexpected CMS layout).');
    }
    const xml = Buffer.from(bytes.slice(start, end + '</plist>'.length), 'latin1').toString('utf-8');
    const plist = parsePlistXml(xml);
    if (typeof plist !== 'object' || Array.isArray(plist)) {
        throw new Error('Embedded plist is not a dictionary.');
    }
    return plist;
}
export class AppStoreConnectClient {
    config;
    baseUrl = 'https://api.appstoreconnect.apple.com';
    constructor(config) {
        // Check if private key is base64 encoded and trim whitespace
        let privateKey = config.privateKey.trim();
        if (!privateKey.includes('BEGIN PRIVATE KEY')) {
            // Try to decode from base64
            try {
                const decoded = Buffer.from(privateKey, 'base64').toString('utf-8').trim();
                if (decoded.includes('BEGIN PRIVATE KEY')) {
                    privateKey = decoded;
                }
            }
            catch (e) {
                // Not base64, use as is
            }
        }
        this.config = {
            ...config,
            privateKey
        };
    }
    /**
     * Generate JWT token for App Store Connect API authentication
     */
    generateToken() {
        try {
            const payload = {
                iss: this.config.issuerId,
                exp: Math.floor(Date.now() / 1000) + (20 * 60), // 20 minutes
                aud: 'appstoreconnect-v1'
            };
            console.log('Generating JWT with issuer:', this.config.issuerId);
            console.log('Key ID:', this.config.keyId);
            const token = jwt.sign(payload, this.config.privateKey, {
                algorithm: 'ES256',
                header: {
                    alg: 'ES256',
                    kid: this.config.keyId, // ✅ CORRECT: 'kid' in header
                    typ: 'JWT'
                }
            });
            console.log('JWT generated successfully');
            return token;
        }
        catch (error) {
            console.error('Failed to generate JWT:', error.message);
            throw new Error(`JWT generation failed: ${error.message}`);
        }
    }
    /**
     * Make authenticated request to App Store Connect API
     */
    async makeRequest(endpoint, options) {
        const token = this.generateToken();
        // links.next from a paginated response is an absolute URL — pass it through unchanged.
        const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
        console.log(`Making ${options?.method || 'GET'} request to: ${url}`);
        const response = await fetch(url, {
            method: options?.method || 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: options?.body ? JSON.stringify(options.body) : undefined,
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`API Error Response (${response.status}):`, errorText);
            // Try to parse error as JSON for better error messages
            try {
                const errorJson = JSON.parse(errorText);
                const errorMessage = errorJson.errors?.[0]?.detail || errorJson.errors?.[0]?.title || errorText;
                throw new Error(`App Store API error: ${response.status} - ${errorMessage}`);
            }
            catch (parseError) {
                throw new Error(`App Store API error: ${response.status} ${response.statusText} - ${errorText}`);
            }
        }
        // DELETE and relationship updates return 204 with no body — don't attempt to parse it.
        if (response.status === 204)
            return null;
        const text = await response.text();
        return text ? JSON.parse(text) : null;
    }
    // In-process cache of bundleId -> numeric app id.
    appIdCache = new Map();
    /**
     * Resolve a bundle ID (e.g. "eu.ecofactor") to Apple's numeric app ID.
     * Numeric IDs are returned unchanged; lookups are cached per process.
     */
    async resolveAppId(appIdOrBundleId) {
        const value = (appIdOrBundleId || '').trim();
        if (/^\d+$/.test(value))
            return value;
        const cached = this.appIdCache.get(value);
        if (cached)
            return cached;
        const data = await this.makeRequest(`/v1/apps?filter[bundleId]=${encodeURIComponent(value)}&limit=1`);
        const resolved = data.data?.[0]?.id;
        if (!resolved) {
            throw new Error(`No app found for bundle ID "${value}". Pass the numeric App Store app ID or a valid bundle ID.`);
        }
        this.appIdCache.set(value, resolved);
        return resolved;
    }
    /**
     * Fetch every page of a collection endpoint, concatenating data and included resources.
     * maxPages is a runaway guard, not a real limit — 200-per-page covers every collection here.
     */
    async makePaginatedRequest(endpoint, maxPages = 20) {
        const data = [];
        const included = [];
        let next = endpoint;
        for (let page = 0; next && page < maxPages; page++) {
            const response = await this.makeRequest(next);
            data.push(...(response?.data || []));
            included.push(...(response?.included || []));
            next = response?.links?.next;
        }
        return { data, included };
    }
    /**
     * Make an authenticated request that returns raw bytes (e.g. gzipped report files).
     */
    async makeRawRequest(endpoint) {
        const token = this.generateToken();
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/a-gzip, application/json',
            },
        });
        if (!response.ok) {
            const errorText = await response.text();
            let detail = errorText;
            try {
                detail = JSON.parse(errorText).errors?.[0]?.detail || detail;
            }
            catch { /* not JSON */ }
            throw new Error(`App Store API error: ${response.status} - ${detail}`);
        }
        return Buffer.from(await response.arrayBuffer());
    }
    /**
     * Parse a tab-separated report (Apple sales reports) into row objects keyed by header.
     */
    parseTsv(tsv) {
        const lines = tsv.split('\n').filter((line) => line.trim().length > 0);
        if (lines.length < 2)
            return [];
        const headers = lines[0].split('\t').map((h) => h.trim());
        return lines.slice(1).map((line) => {
            const cells = line.split('\t');
            const row = {};
            headers.forEach((h, i) => { row[h] = (cells[i] ?? '').trim(); });
            return row;
        });
    }
    /**
     * List all apps in App Store Connect
     */
    async listApps() {
        try {
            const data = await this.makeRequest('/v1/apps');
            return data.data?.map((app) => ({
                id: app.id,
                name: app.attributes.name,
                bundleId: app.attributes.bundleId,
                appStoreId: app.attributes.sku,
                status: app.attributes.appStoreState,
                platform: app.attributes.primaryLocale,
            })) || [];
        }
        catch (error) {
            console.error('Error listing apps:', error);
            throw new Error(`Failed to fetch apps from Apple Store Connect: ${error.message}`);
        }
    }
    /**
     * Get detailed information about a specific app
     */
    async getAppInfo(appId) {
        try {
            appId = await this.resolveAppId(appId);
            const data = await this.makeRequest(`/v1/apps/${appId}`);
            const app = data.data;
            if (!app)
                return null;
            return {
                id: app.id,
                name: app.attributes.name,
                bundleId: app.attributes.bundleId,
                appStoreId: app.attributes.sku,
                status: app.attributes.appStoreState,
                version: app.attributes.contentRightsDeclaration,
                platform: app.attributes.primaryLocale,
            };
        }
        catch (error) {
            console.error('Error getting app info:', error);
            throw new Error(`Failed to fetch app info from Apple Store Connect: ${error.message}`);
        }
    }
    /**
     * Get sales reports for a specific date
     */
    async getSalesData(date) {
        const targetDate = date || new Date().toISOString().split('T')[0];
        if (!this.config.vendorNumber) {
            throw new Error('Sales reports require a vendor number. Set ASC_VENDOR_NUMBER (App Store Connect → Payments and Financial Reports → the number shown next to your legal entity).');
        }
        try {
            // Sales reports are returned as a gzipped TSV file, not JSON. reportSubType and
            // version are required by Apple; vendorNumber is distinct from the issuer ID.
            const params = new URLSearchParams({
                'filter[frequency]': 'DAILY',
                'filter[reportDate]': targetDate,
                'filter[reportType]': 'SALES',
                'filter[reportSubType]': 'SUMMARY',
                'filter[vendorNumber]': this.config.vendorNumber,
                'filter[version]': '1_1',
            });
            const buffer = await this.makeRawRequest(`/v1/salesReports?${params.toString()}`);
            const rows = this.parseTsv(gunzipSync(buffer).toString('utf-8'));
            // "Developer Proceeds" is per-unit, so total proceeds = units * per-unit proceeds.
            let totalUnits = 0;
            let totalRevenue = 0;
            for (const row of rows) {
                const units = parseInt(row['Units'] || '0', 10) || 0;
                const perUnit = parseFloat(row['Developer Proceeds'] || '0') || 0;
                totalUnits += units;
                totalRevenue += units * perUnit;
            }
            return {
                date: targetDate,
                revenue: totalRevenue,
                currency: rows[0]?.['Currency of Proceeds'] || 'USD',
                transactionCount: rows.length,
                units: totalUnits,
            };
        }
        catch (error) {
            console.error('Error getting sales data:', error);
            throw new Error(`Failed to fetch sales data from Apple Store Connect: ${error.message}`);
        }
    }
    /**
     * Get app analytics data
     */
    async getAnalytics(appId) {
        try {
            appId = await this.resolveAppId(appId);
            // Note: Analytics API might require different endpoints or permissions
            const endpoint = `/v1/apps/${appId}/analyticsReportRequests`;
            return await this.makeRequest(endpoint);
        }
        catch (error) {
            console.error('Error getting analytics:', error);
            throw new Error(`Failed to fetch analytics from Apple Store Connect: ${error.message}`);
        }
    }
    /**
     * Get build information (TestFlight builds)
     */
    async getBuilds(appId) {
        try {
            appId = await this.resolveAppId(appId);
            const endpoint = `/v1/apps/${appId}/builds`;
            const data = await this.makeRequest(endpoint);
            return data.data?.map((build) => ({
                id: build.id,
                version: build.attributes.version,
                buildNumber: build.attributes.build,
                processingState: build.attributes.processingState,
                uploadedDate: build.attributes.uploadedDate,
            })) || [];
        }
        catch (error) {
            console.error('Error getting builds:', error);
            throw new Error(`Failed to fetch builds from Apple Store Connect: ${error.message}`);
        }
    }
    /**
     * List all app store versions for an app
     */
    async listAppStoreVersions(appId) {
        try {
            appId = await this.resolveAppId(appId);
            const endpoint = `/v1/apps/${appId}/appStoreVersions`;
            const response = await this.makeRequest(endpoint);
            return response.data?.map((version) => ({
                id: version.id,
                versionString: version.attributes.versionString,
                platform: version.attributes.platform,
                appStoreState: version.attributes.appStoreState,
                releaseType: version.attributes.releaseType,
                earliestReleaseDate: version.attributes.earliestReleaseDate,
                copyright: version.attributes.copyright,
                createdDate: version.attributes.createdDate,
            })) || [];
        }
        catch (error) {
            console.error('Error listing app store versions:', error);
            throw new Error(`Failed to fetch app store versions from Apple Store Connect: ${error.message}`);
        }
    }
    /**
     * List beta groups for TestFlight
     */
    async listBetaGroups(appId) {
        try {
            appId = await this.resolveAppId(appId);
            const endpoint = `/v1/apps/${appId}/betaGroups`;
            const response = await this.makeRequest(endpoint);
            return response.data?.map((group) => ({
                id: group.id,
                name: group.attributes.name,
                isInternalGroup: group.attributes.isInternalGroup,
                publicLink: group.attributes.publicLink,
                publicLinkEnabled: group.attributes.publicLinkEnabled,
                publicLinkLimit: group.attributes.publicLinkLimit,
                publicLinkLimitEnabled: group.attributes.publicLinkLimitEnabled,
                createdDate: group.attributes.createdDate,
            })) || [];
        }
        catch (error) {
            console.error('Error listing beta groups:', error);
            throw new Error(`Failed to fetch beta groups from Apple Store Connect: ${error.message}`);
        }
    }
    /**
     * Add a tester to a beta group
     */
    async addTesterToBetaGroup(params) {
        try {
            // Apple requires a betaGroups (or builds) relationship when creating a betaTester,
            // so the group is attached in the same POST that creates the tester.
            const testerBody = {
                data: {
                    type: 'betaTesters',
                    attributes: {
                        email: params.email,
                        firstName: params.firstName,
                        lastName: params.lastName,
                    },
                    relationships: {
                        betaGroups: {
                            data: [{ type: 'betaGroups', id: params.groupId }],
                        },
                    },
                }
            };
            let testerId;
            try {
                const testerResponse = await this.makeRequest('/v1/betaTesters', {
                    method: 'POST',
                    body: testerBody
                });
                testerId = testerResponse.data.id;
            }
            catch (error) {
                // Tester already exists — look them up and attach to the group directly.
                const existingTesters = await this.makeRequest(`/v1/betaTesters?filter[email]=${encodeURIComponent(params.email)}`);
                if (existingTesters.data && existingTesters.data.length > 0) {
                    testerId = existingTesters.data[0].id;
                    await this.makeRequest(`/v1/betaGroups/${params.groupId}/relationships/betaTesters`, {
                        method: 'POST',
                        body: { data: [{ type: 'betaTesters', id: testerId }] }
                    });
                }
                else {
                    throw error;
                }
            }
            return {
                success: true,
                testerId,
                groupId: params.groupId,
                email: params.email,
                message: `Successfully added ${params.email} to beta group`,
            };
        }
        catch (error) {
            console.error('Error adding tester to beta group:', error);
            throw new Error(`Failed to add tester to beta group: ${error.message}`);
        }
    }
    /**
     * Update app store version localization (descriptions, keywords, etc.)
     */
    async updateAppStoreVersionLocalization(params) {
        try {
            // First, check if localization exists
            const getEndpoint = `/v1/appStoreVersions/${params.versionId}/appStoreVersionLocalizations`;
            const existingData = await this.makeRequest(getEndpoint);
            const existingLocalization = existingData.data?.find((loc) => loc.attributes.locale === params.locale);
            if (existingLocalization) {
                // Update existing localization
                const updateBody = {
                    data: {
                        type: 'appStoreVersionLocalizations',
                        id: existingLocalization.id,
                        attributes: {
                            description: params.description,
                            keywords: params.keywords,
                            whatsNew: params.whatsNew,
                            promotionalText: params.promotionalText,
                            supportUrl: params.supportUrl,
                            marketingUrl: params.marketingUrl,
                        }
                    }
                };
                const response = await this.makeRequest(`/v1/appStoreVersionLocalizations/${existingLocalization.id}`, {
                    method: 'PATCH',
                    body: updateBody
                });
                return {
                    id: response.data.id,
                    locale: response.data.attributes.locale,
                    description: response.data.attributes.description,
                    keywords: response.data.attributes.keywords,
                    whatsNew: response.data.attributes.whatsNew,
                    promotionalText: response.data.attributes.promotionalText,
                    supportUrl: response.data.attributes.supportUrl,
                    marketingUrl: response.data.attributes.marketingUrl,
                };
            }
            else {
                // Create new localization
                const createBody = {
                    data: {
                        type: 'appStoreVersionLocalizations',
                        attributes: {
                            locale: params.locale,
                            description: params.description,
                            keywords: params.keywords,
                            whatsNew: params.whatsNew,
                            promotionalText: params.promotionalText,
                            supportUrl: params.supportUrl,
                            marketingUrl: params.marketingUrl,
                        },
                        relationships: {
                            appStoreVersion: {
                                data: {
                                    type: 'appStoreVersions',
                                    id: params.versionId
                                }
                            }
                        }
                    }
                };
                const response = await this.makeRequest('/v1/appStoreVersionLocalizations', {
                    method: 'POST',
                    body: createBody
                });
                return {
                    id: response.data.id,
                    locale: response.data.attributes.locale,
                    description: response.data.attributes.description,
                    keywords: response.data.attributes.keywords,
                    whatsNew: response.data.attributes.whatsNew,
                    promotionalText: response.data.attributes.promotionalText,
                    supportUrl: response.data.attributes.supportUrl,
                    marketingUrl: response.data.attributes.marketingUrl,
                };
            }
        }
        catch (error) {
            console.error('Error updating app store version localization:', error);
            throw new Error(`Failed to update app store version localization: ${error.message}`);
        }
    }
    /**
     * Create a new app store version
     */
    async createAppStoreVersion(params) {
        try {
            const appId = await this.resolveAppId(params.appId);
            const body = {
                data: {
                    type: 'appStoreVersions',
                    attributes: {
                        platform: params.platform,
                        versionString: params.versionString,
                        copyright: params.copyright,
                        releaseType: params.releaseType || 'MANUAL',
                        earliestReleaseDate: params.earliestReleaseDate,
                    },
                    relationships: {
                        app: {
                            data: {
                                type: 'apps',
                                id: params.appId
                            }
                        }
                    }
                }
            };
            // Add build relationship if provided
            if (params.buildId) {
                body.data.relationships.build = {
                    data: {
                        type: 'builds',
                        id: params.buildId
                    }
                };
            }
            const response = await this.makeRequest('/v1/appStoreVersions', {
                method: 'POST',
                body
            });
            const version = response.data;
            return {
                id: version.id,
                versionString: version.attributes.versionString,
                platform: version.attributes.platform,
                appStoreState: version.attributes.appStoreState,
                releaseType: version.attributes.releaseType,
                earliestReleaseDate: version.attributes.earliestReleaseDate,
                copyright: version.attributes.copyright,
                createdDate: version.attributes.createdDate,
            };
        }
        catch (error) {
            console.error('Error creating app store version:', error);
            throw new Error(`Failed to create app store version: ${error.message}`);
        }
    }
    /**
     * Find the latest uploaded build for an app + build (version) string and attach it to an
     * App Store version, if it has finished processing. Single-shot (no long polling): returns a
     * status so the caller can retry while the build is still processing.
     */
    async attachBuild(params) {
        try {
            const appId = await this.resolveAppId(params.appId);
            let build;
            if (params.buildId) {
                const data = await this.makeRequest(`/v1/builds/${params.buildId}`);
                build = data.data;
            }
            else {
                if (!params.buildVersionString) {
                    throw new Error('Provide either buildId or buildVersionString to locate the build.');
                }
                const data = await this.makeRequest(`/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(params.buildVersionString)}&sort=-uploadedDate&limit=1`);
                build = data.data?.[0];
            }
            if (!build)
                return { status: 'not_found' };
            const state = build.attributes?.processingState;
            if (state !== 'VALID')
                return { status: 'processing', buildId: build.id, processingState: state };
            await this.makeRequest(`/v1/appStoreVersions/${params.versionId}/relationships/build`, {
                method: 'PATCH',
                body: { data: { type: 'builds', id: build.id } },
            });
            return { status: 'attached', buildId: build.id, processingState: state };
        }
        catch (error) {
            console.error('Error attaching build:', error);
            throw new Error(`Failed to attach build: ${error.message}`);
        }
    }
    /**
     * Submit an App Store version for review (iOS reviewSubmissions flow): optionally set the
     * release type, then create a submission, add the version as an item, and mark it submitted.
     */
    async submitForReview(params) {
        try {
            const appId = await this.resolveAppId(params.appId);
            if (params.releaseType) {
                await this.makeRequest(`/v1/appStoreVersions/${params.versionId}`, {
                    method: 'PATCH',
                    body: {
                        data: { id: params.versionId, type: 'appStoreVersions', attributes: { releaseType: params.releaseType } },
                    },
                });
            }
            const submission = await this.makeRequest('/v1/reviewSubmissions', {
                method: 'POST',
                body: {
                    data: {
                        type: 'reviewSubmissions',
                        attributes: { platform: 'IOS' },
                        relationships: { app: { data: { type: 'apps', id: appId } } },
                    },
                },
            });
            const submissionId = submission.data.id;
            await this.makeRequest('/v1/reviewSubmissionItems', {
                method: 'POST',
                body: {
                    data: {
                        type: 'reviewSubmissionItems',
                        relationships: {
                            reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
                            appStoreVersion: { data: { type: 'appStoreVersions', id: params.versionId } },
                        },
                    },
                },
            });
            await this.makeRequest(`/v1/reviewSubmissions/${submissionId}`, {
                method: 'PATCH',
                body: { data: { id: submissionId, type: 'reviewSubmissions', attributes: { submitted: true } } },
            });
            return { submissionId };
        }
        catch (error) {
            console.error('Error submitting for review:', error);
            throw new Error(`Failed to submit for review: ${error.message}`);
        }
    }
    /**
     * List the localizations (store locales + their whatsNew/promotionalText) on an App Store
     * version — so callers can update only the locales the app actually offers.
     */
    async listVersionLocalizations(versionId) {
        try {
            const data = await this.makeRequest(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`);
            return (data.data ?? []).map((l) => ({
                locale: l.attributes.locale,
                whatsNew: l.attributes.whatsNew,
                promotionalText: l.attributes.promotionalText,
            }));
        }
        catch (error) {
            console.error('Error listing version localizations:', error);
            throw new Error(`Failed to list version localizations: ${error.message}`);
        }
    }
    /**
     * Get customer reviews for an app
     */
    async getCustomerReviews(appId, limit = 50) {
        try {
            appId = await this.resolveAppId(appId);
            const data = await this.makeRequest(`/v1/apps/${appId}/customerReviews?limit=${limit}&sort=-createdDate`);
            return data.data?.map((review) => ({
                id: review.id,
                rating: review.attributes.rating,
                title: review.attributes.title,
                body: review.attributes.body,
                reviewerNickname: review.attributes.reviewerNickname,
                territory: review.attributes.territory,
                createdDate: review.attributes.createdDate,
                lastModifiedDate: review.attributes.lastModifiedDate
            })) || [];
        }
        catch (error) {
            console.error('Error getting customer reviews:', error);
            throw new Error(`Failed to get customer reviews: ${error.message}`);
        }
    }
    /**
     * Get app pricing information
     */
    async getAppPricing(appId) {
        try {
            appId = await this.resolveAppId(appId);
            const data = await this.makeRequest(`/v1/apps/${appId}/appPriceSchedule`);
            if (!data.data)
                return null;
            return {
                id: data.data.id,
                baseTerritory: data.data.attributes?.baseTerritory,
                currency: data.data.attributes?.currency,
                prices: data.included?.map((price) => ({
                    territory: price.attributes?.territory,
                    price: price.attributes?.customerPrice,
                    proceeds: price.attributes?.wholesalePrice
                })) || []
            };
        }
        catch (error) {
            console.error('Error getting app pricing:', error);
            throw new Error(`Failed to get app pricing: ${error.message}`);
        }
    }
    /**
     * Get in-app purchases for an app
     */
    async getInAppPurchases(appId) {
        try {
            appId = await this.resolveAppId(appId);
            const data = await this.makeRequest(`/v1/apps/${appId}/inAppPurchasesV2?limit=200`);
            return data.data?.map((iap) => ({
                id: iap.id,
                name: iap.attributes.name,
                productId: iap.attributes.productId,
                state: iap.attributes.state,
                inAppPurchaseType: iap.attributes.inAppPurchaseType,
                reviewNote: iap.attributes.reviewNote,
                familySharable: iap.attributes.familySharable,
                contentHosting: iap.attributes.contentHosting,
                availableInAllTerritories: iap.attributes.availableInAllTerritories
            })) || [];
        }
        catch (error) {
            console.error('Error getting in-app purchases:', error);
            throw new Error(`Failed to get in-app purchases: ${error.message}`);
        }
    }
    /**
     * Get app availability information
     */
    async getAppAvailability(appId) {
        try {
            appId = await this.resolveAppId(appId);
            const data = await this.makeRequest(`/v1/apps/${appId}/appAvailabilityV2`);
            if (!data.data)
                return null;
            return {
                id: data.data.id,
                availableInNewTerritories: data.data.attributes?.availableInNewTerritories,
                territories: data.included?.map((territory) => territory.attributes?.territory) || []
            };
        }
        catch (error) {
            console.error('Error getting app availability:', error);
            throw new Error(`Failed to get app availability: ${error.message}`);
        }
    }
    /**
     * Get app info details including categories and age rating
     */
    async getAppInfoDetails(appId) {
        try {
            appId = await this.resolveAppId(appId);
            const data = await this.makeRequest(`/v1/apps/${appId}/appInfos`);
            if (!data.data?.[0])
                return null;
            const appInfo = data.data[0];
            return {
                id: appInfo.id,
                appStoreState: appInfo.attributes?.appStoreState,
                appStoreAgeRating: appInfo.attributes?.appStoreAgeRating,
                brazilAgeRating: appInfo.attributes?.brazilAgeRating,
                kidsAgeBand: appInfo.attributes?.kidsAgeBand,
                primaryCategory: appInfo.relationships?.primaryCategory?.data?.id,
                primarySubcategoryOne: appInfo.relationships?.primarySubcategoryOne?.data?.id,
                primarySubcategoryTwo: appInfo.relationships?.primarySubcategoryTwo?.data?.id,
                secondaryCategory: appInfo.relationships?.secondaryCategory?.data?.id,
                secondarySubcategoryOne: appInfo.relationships?.secondarySubcategoryOne?.data?.id,
                secondarySubcategoryTwo: appInfo.relationships?.secondarySubcategoryTwo?.data?.id
            };
        }
        catch (error) {
            console.error('Error getting app info details:', error);
            throw new Error(`Failed to get app info details: ${error.message}`);
        }
    }
    /**
     * Resolve an App Store version ID for an app. If versionString is given, match it exactly;
     * otherwise pick the first version in one of the preferred states, else the most recently
     * created version. Returns id + versionString + state for messaging.
     */
    async resolveVersionId(appId, versionString, preferredStates) {
        const versions = await this.listAppStoreVersions(appId);
        if (versions.length === 0)
            throw new Error('No App Store versions found for this app.');
        if (versionString) {
            const match = versions.find((v) => v.versionString === versionString);
            if (!match)
                throw new Error(`No App Store version "${versionString}" found for this app.`);
            return { id: match.id, versionString: match.versionString, state: match.appStoreState };
        }
        if (preferredStates && preferredStates.length > 0) {
            const match = versions.find((v) => preferredStates.includes(v.appStoreState));
            if (!match) {
                throw new Error(`No App Store version in state ${preferredStates.join('/')} found. Pass versionString explicitly.`);
            }
            return { id: match.id, versionString: match.versionString, state: match.appStoreState };
        }
        const latest = versions
            .slice()
            .sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''))[0];
        return { id: latest.id, versionString: latest.versionString, state: latest.appStoreState };
    }
    /**
     * Release an approved version that is waiting for manual developer release. Resolves the
     * version in PENDING_DEVELOPER_RELEASE when versionString is omitted.
     */
    async releaseVersion(params) {
        try {
            const appId = await this.resolveAppId(params.appId);
            const version = await this.resolveVersionId(appId, params.versionString, [
                'PENDING_DEVELOPER_RELEASE',
            ]);
            const response = await this.makeRequest('/v1/appStoreVersionReleaseRequests', {
                method: 'POST',
                body: {
                    data: {
                        type: 'appStoreVersionReleaseRequests',
                        relationships: {
                            appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
                        },
                    },
                },
            });
            return { versionString: version.versionString, releaseRequestId: response.data.id };
        }
        catch (error) {
            console.error('Error releasing version:', error);
            throw new Error(`Failed to release version: ${error.message}`);
        }
    }
    /**
     * Control the iOS 7-day phased release for a version. action get returns the current state;
     * start creates an ACTIVE phased release (or re-activates an existing one); pause/resume/complete
     * PATCH the state to PAUSED/ACTIVE/COMPLETE.
     */
    async managePhasedRelease(params) {
        try {
            const appId = await this.resolveAppId(params.appId);
            const version = await this.resolveVersionId(appId, params.versionString);
            const current = await this.makeRequest(`/v1/appStoreVersions/${version.id}/appStoreVersionPhasedRelease`);
            const existing = current?.data;
            if (params.action === 'get') {
                return {
                    versionString: version.versionString,
                    action: 'get',
                    id: existing?.id,
                    state: existing?.attributes?.phasedReleaseState || 'NONE',
                };
            }
            if (params.action === 'start') {
                if (existing) {
                    const resp = await this.makeRequest(`/v1/appStoreVersionPhasedReleases/${existing.id}`, {
                        method: 'PATCH',
                        body: {
                            data: {
                                id: existing.id,
                                type: 'appStoreVersionPhasedReleases',
                                attributes: { phasedReleaseState: 'ACTIVE' },
                            },
                        },
                    });
                    return {
                        versionString: version.versionString,
                        action: 'start',
                        id: resp.data.id,
                        state: resp.data.attributes?.phasedReleaseState,
                    };
                }
                const resp = await this.makeRequest('/v1/appStoreVersionPhasedReleases', {
                    method: 'POST',
                    body: {
                        data: {
                            type: 'appStoreVersionPhasedReleases',
                            attributes: { phasedReleaseState: 'ACTIVE' },
                            relationships: {
                                appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
                            },
                        },
                    },
                });
                return {
                    versionString: version.versionString,
                    action: 'start',
                    id: resp.data.id,
                    state: resp.data.attributes?.phasedReleaseState,
                };
            }
            if (!existing) {
                throw new Error(`No phased release exists for version ${version.versionString}. Use action "start" first.`);
            }
            const stateMap = { pause: 'PAUSED', resume: 'ACTIVE', complete: 'COMPLETE' };
            const newState = stateMap[params.action];
            const resp = await this.makeRequest(`/v1/appStoreVersionPhasedReleases/${existing.id}`, {
                method: 'PATCH',
                body: {
                    data: {
                        id: existing.id,
                        type: 'appStoreVersionPhasedReleases',
                        attributes: { phasedReleaseState: newState },
                    },
                },
            });
            return {
                versionString: version.versionString,
                action: params.action,
                id: existing.id,
                state: resp.data.attributes?.phasedReleaseState || newState,
            };
        }
        catch (error) {
            console.error('Error managing phased release:', error);
            throw new Error(`Failed to manage phased release: ${error.message}`);
        }
    }
    /**
     * Post (or replace) the developer response to a customer review. Apple limits the response
     * body to 5970 characters.
     */
    async replyToReview(params) {
        try {
            if (params.responseBody.length > 5970) {
                throw new Error(`Response body is ${params.responseBody.length} chars; Apple allows a maximum of 5970.`);
            }
            const response = await this.makeRequest('/v1/customerReviewResponses', {
                method: 'POST',
                body: {
                    data: {
                        type: 'customerReviewResponses',
                        attributes: { responseBody: params.responseBody },
                        relationships: {
                            review: { data: { type: 'customerReviews', id: params.reviewId } },
                        },
                    },
                },
            });
            return { responseId: response.data.id };
        }
        catch (error) {
            console.error('Error replying to review:', error);
            throw new Error(`Failed to reply to review: ${error.message}`);
        }
    }
    /**
     * Get the existing developer response for a customer review (null if none).
     */
    async getReviewResponse(reviewId) {
        try {
            const data = await this.makeRequest(`/v1/customerReviews/${reviewId}/response`);
            if (!data?.data)
                return null;
            return {
                id: data.data.id,
                responseBody: data.data.attributes?.responseBody,
                state: data.data.attributes?.state,
                lastModifiedDate: data.data.attributes?.lastModifiedDate,
            };
        }
        catch (error) {
            console.error('Error getting review response:', error);
            throw new Error(`Failed to get review response: ${error.message}`);
        }
    }
    /**
     * Delete a developer response to a customer review.
     */
    async deleteReviewResponse(responseId) {
        try {
            await this.makeRequest(`/v1/customerReviewResponses/${responseId}`, { method: 'DELETE' });
            return { deleted: true };
        }
        catch (error) {
            console.error('Error deleting review response:', error);
            throw new Error(`Failed to delete review response: ${error.message}`);
        }
    }
    /**
     * Set the TestFlight "what to test" text for a build + locale. Updates the existing
     * betaBuildLocalization when present, otherwise creates one.
     */
    async setBetaWhatsNew(params) {
        try {
            const existing = await this.makeRequest(`/v1/betaBuildLocalizations?filter[build]=${encodeURIComponent(params.buildId)}&filter[locale]=${encodeURIComponent(params.locale)}`);
            const found = existing?.data?.[0];
            if (found) {
                const resp = await this.makeRequest(`/v1/betaBuildLocalizations/${found.id}`, {
                    method: 'PATCH',
                    body: {
                        data: {
                            id: found.id,
                            type: 'betaBuildLocalizations',
                            attributes: { whatsNew: params.whatsNew },
                        },
                    },
                });
                return { id: resp.data.id, locale: params.locale, created: false };
            }
            const resp = await this.makeRequest('/v1/betaBuildLocalizations', {
                method: 'POST',
                body: {
                    data: {
                        type: 'betaBuildLocalizations',
                        attributes: { locale: params.locale, whatsNew: params.whatsNew },
                        relationships: {
                            build: { data: { type: 'builds', id: params.buildId } },
                        },
                    },
                },
            });
            return { id: resp.data.id, locale: params.locale, created: true };
        }
        catch (error) {
            console.error('Error setting beta whats new:', error);
            throw new Error(`Failed to set beta what's new: ${error.message}`);
        }
    }
    /**
     * Submit a build for TestFlight (beta) app review.
     */
    async submitBuildForBetaReview(buildId) {
        try {
            const response = await this.makeRequest('/v1/betaAppReviewSubmissions', {
                method: 'POST',
                body: {
                    data: {
                        type: 'betaAppReviewSubmissions',
                        relationships: { build: { data: { type: 'builds', id: buildId } } },
                    },
                },
            });
            return { submissionId: response.data.id, state: response.data.attributes?.betaReviewState };
        }
        catch (error) {
            console.error('Error submitting build for beta review:', error);
            throw new Error(`Failed to submit build for beta review: ${error.message}`);
        }
    }
    /**
     * Mark a TestFlight build as expired.
     */
    async expireBuild(buildId) {
        try {
            const response = await this.makeRequest(`/v1/builds/${buildId}`, {
                method: 'PATCH',
                body: { data: { id: buildId, type: 'builds', attributes: { expired: true } } },
            });
            return { buildId, expired: response?.data?.attributes?.expired ?? true };
        }
        catch (error) {
            console.error('Error expiring build:', error);
            throw new Error(`Failed to expire build: ${error.message}`);
        }
    }
    /**
     * Get available app price points for an app in a territory. Returns the price point id plus
     * customer price and developer proceeds — the id feeds update_price_schedule.
     */
    async getAppPricePoints(params) {
        try {
            const appId = await this.resolveAppId(params.appId);
            const data = await this.makeRequest(`/v1/apps/${appId}/appPricePoints?filter[territory]=${encodeURIComponent(params.territory)}&limit=200`);
            return (data?.data ?? []).map((pp) => ({
                id: pp.id,
                customerPrice: pp.attributes?.customerPrice,
                proceeds: pp.attributes?.proceeds,
            }));
        }
        catch (error) {
            console.error('Error getting app price points:', error);
            throw new Error(`Failed to get app price points: ${error.message}`);
        }
    }
    /**
     * Set an app's price by creating a new appPriceSchedule pinned to a price point in a base
     * territory. Uses the modern (2023+) pricing API.
     * NOTE: this pricing API shape is intricate and needs live verification against a real account.
     */
    async updatePriceSchedule(params) {
        try {
            const appId = await this.resolveAppId(params.appId);
            const response = await this.makeRequest('/v1/appPriceSchedules', {
                method: 'POST',
                body: {
                    data: {
                        type: 'appPriceSchedules',
                        relationships: {
                            app: { data: { type: 'apps', id: appId } },
                            baseTerritory: { data: { type: 'territories', id: params.territory } },
                            manualPrices: { data: [{ type: 'appPrices', id: params.pricePointId }] },
                        },
                    },
                    included: [
                        {
                            type: 'appPrices',
                            id: params.pricePointId,
                            attributes: {},
                            relationships: {
                                appPricePoint: { data: { type: 'appPricePoints', id: params.pricePointId } },
                            },
                        },
                    ],
                },
            });
            return { scheduleId: response.data.id };
        }
        catch (error) {
            console.error('Error updating price schedule:', error);
            throw new Error(`Failed to update price schedule: ${error.message}`);
        }
    }
    /**
     * Set an app's territory availability via the v2 appAvailabilities API.
     * NOTE: the v2 appAvailabilities shape needs live verification against a real account.
     */
    async setAppAvailability(params) {
        try {
            const appId = await this.resolveAppId(params.appId);
            const response = await this.makeRequest('/v2/appAvailabilities', {
                method: 'POST',
                body: {
                    data: {
                        type: 'appAvailabilities',
                        attributes: { availableInNewTerritories: params.availableInNewTerritories ?? false },
                        relationships: {
                            app: { data: { type: 'apps', id: appId } },
                            territoryAvailabilities: {
                                data: params.territories.map((id) => ({ type: 'territoryAvailabilities', id })),
                            },
                        },
                    },
                },
            });
            return { availabilityId: response.data.id };
        }
        catch (error) {
            console.error('Error setting app availability:', error);
            throw new Error(`Failed to set app availability: ${error.message}`);
        }
    }
    /**
     * Upload a single screenshot to an app screenshot set: reserve the asset, upload each byte
     * range to the pre-signed URLs, then commit with the file's MD5 checksum.
     * NOTE: the reserve/upload/commit flow needs live verification against a real account.
     */
    async uploadScreenshot(params) {
        try {
            const fileBuffer = readFileSync(params.filePath);
            const fileName = basename(params.filePath);
            const fileSize = fileBuffer.length;
            // Reserve the screenshot asset — Apple returns the upload operations to perform.
            const reserve = await this.makeRequest('/v1/appScreenshots', {
                method: 'POST',
                body: {
                    data: {
                        type: 'appScreenshots',
                        attributes: { fileName, fileSize },
                        relationships: {
                            appScreenshotSet: {
                                data: { type: 'appScreenshotSets', id: params.screenshotSetId },
                            },
                        },
                    },
                },
            });
            const screenshotId = reserve.data.id;
            const operations = reserve.data.attributes?.uploadOperations || [];
            // Each operation is a pre-signed URL for one byte range — raw fetch, no JWT.
            for (const op of operations) {
                const slice = fileBuffer.subarray(op.offset, op.offset + op.length);
                const headers = {};
                for (const h of op.requestHeaders || [])
                    headers[h.name] = h.value;
                const uploadResp = await fetch(op.url, { method: op.method, headers, body: slice });
                if (!uploadResp.ok) {
                    const errText = await uploadResp.text();
                    throw new Error(`Screenshot chunk upload failed: ${uploadResp.status} - ${errText}`);
                }
            }
            // Commit: mark uploaded and supply the full-file MD5 checksum.
            const checksum = createHash('md5').update(fileBuffer).digest('hex');
            await this.makeRequest(`/v1/appScreenshots/${screenshotId}`, {
                method: 'PATCH',
                body: {
                    data: {
                        id: screenshotId,
                        type: 'appScreenshots',
                        attributes: { uploaded: true, sourceFileChecksum: checksum },
                    },
                },
            });
            return { id: screenshotId, fileName, fileSize };
        }
        catch (error) {
            console.error('Error uploading screenshot:', error);
            throw new Error(`Failed to upload screenshot: ${error.message}`);
        }
    }
    // ---------------------------------------------------------------------------
    // Signing identity: bundle IDs, capabilities, provisioning profiles
    // ---------------------------------------------------------------------------
    // In-process cache of the full bundle-ID list (identifier + capability relationships).
    bundleIdsCache;
    /**
     * Fetch every bundle ID on the team with its enabled capabilities. Cached per process:
     * portal capabilities change rarely and every lookup here needs the whole list anyway,
     * because Apple's filter[identifier] is a PARTIAL match ("eu.ecofactor" also matches
     * "eu.ecofactortr"), so identifiers are matched exactly on this side.
     */
    async fetchAllBundleIds() {
        if (!this.bundleIdsCache) {
            this.bundleIdsCache = await this.makePaginatedRequest('/v1/bundleIds?include=bundleIdCapabilities&limit=200');
        }
        return this.bundleIdsCache;
    }
    /**
     * Resolve a bundle identifier ("eu.ecofactor") or a portal resource id ("636AMV3G4A")
     * to the full bundle-ID record. Exact match only.
     */
    async resolveBundleIdRef(identifierOrId) {
        const value = (identifierOrId || '').trim();
        const { data } = await this.fetchAllBundleIds();
        const match = data.find((b) => b.attributes?.identifier === value) || data.find((b) => b.id === value);
        if (!match) {
            throw new Error(`No bundle ID found for "${value}". Pass the exact identifier (e.g. eu.ecofactor) or the portal resource id, or call list_bundle_ids to see them.`);
        }
        return match;
    }
    /**
     * List bundle IDs with the capabilities enabled on each. identifier is a case-insensitive
     * substring filter applied locally (see fetchAllBundleIds for why).
     */
    async listBundleIds(params) {
        try {
            const { data, included } = await this.fetchAllBundleIds();
            const capabilities = new Map();
            for (const item of included) {
                if (item.type === 'bundleIdCapabilities')
                    capabilities.set(item.id, item.attributes || {});
            }
            const needle = (params.identifier || '').trim().toLowerCase();
            const platform = (params.platform || '').trim().toUpperCase();
            return data
                .filter((bundle) => {
                const identifier = bundle.attributes?.identifier || '';
                if (needle && !identifier.toLowerCase().includes(needle))
                    return false;
                if (platform && (bundle.attributes?.platform || '') !== platform)
                    return false;
                return true;
            })
                .sort((a, b) => (a.attributes?.identifier || '').localeCompare(b.attributes?.identifier || ''))
                .map((bundle) => ({
                id: bundle.id,
                identifier: bundle.attributes?.identifier || '',
                name: bundle.attributes?.name || '',
                platform: bundle.attributes?.platform || '',
                capabilities: (bundle.relationships?.bundleIdCapabilities?.data || [])
                    .map((ref) => {
                    const attributes = capabilities.get(ref.id) || {};
                    // Relationship refs are "<bundleIdRef>_<CAPABILITY_TYPE>" — usable even when
                    // the capability was not returned in the included section.
                    const capabilityType = attributes.capabilityType || String(ref.id).replace(`${bundle.id}_`, '');
                    return {
                        capabilityType,
                        entitlementKey: entitlementKeyFor(capabilityType),
                        settings: attributes.settings || undefined,
                    };
                })
                    .sort((a, b) => a.capabilityType.localeCompare(b.capabilityType)),
            }));
        }
        catch (error) {
            console.error('Error listing bundle IDs:', error);
            throw new Error(`Failed to list bundle IDs: ${error.message}`);
        }
    }
    /**
     * Capabilities enabled on one bundle ID, with the entitlement key each one authorises.
     * A capability here is Apple's GRANT — the app still has to request the key in its
     * .entitlements file for the build to claim it.
     */
    async getBundleIdCapabilities(bundleId) {
        try {
            const bundle = await this.resolveBundleIdRef(bundleId);
            // This relationship endpoint rejects the limit parameter, so don't send one.
            const response = await this.makeRequest(`/v1/bundleIds/${bundle.id}/bundleIdCapabilities`);
            const capabilities = (response?.data || [])
                .map((capability) => ({
                capabilityType: capability.attributes?.capabilityType || capability.id,
                entitlementKey: entitlementKeyFor(capability.attributes?.capabilityType || ''),
                settings: capability.attributes?.settings || undefined,
            }))
                .sort((a, b) => a.capabilityType.localeCompare(b.capabilityType));
            return {
                id: bundle.id,
                identifier: bundle.attributes?.identifier || '',
                name: bundle.attributes?.name || '',
                platform: bundle.attributes?.platform || '',
                capabilities,
            };
        }
        catch (error) {
            console.error('Error getting bundle ID capabilities:', error);
            throw new Error(`Failed to get bundle ID capabilities: ${error.message}`);
        }
    }
    /**
     * List provisioning profiles. profileContent is excluded here (it is a large DER blob) —
     * use getProfileEntitlements for the decoded entitlements of one profile.
     */
    async listProfiles(params) {
        try {
            const query = [
                'include=bundleId',
                'fields[profiles]=name,profileType,profileState,uuid,expirationDate,createdDate,platform,bundleId',
                'fields[bundleIds]=identifier,name',
                'limit=200',
            ];
            if (params.profileType)
                query.push(`filter[profileType]=${encodeURIComponent(params.profileType.toUpperCase())}`);
            if (params.profileState)
                query.push(`filter[profileState]=${encodeURIComponent(params.profileState.toUpperCase())}`);
            const { data, included } = await this.makePaginatedRequest(`/v1/profiles?${query.join('&')}`);
            const bundleIds = new Map();
            for (const item of included) {
                if (item.type === 'bundleIds')
                    bundleIds.set(item.id, item.attributes?.identifier || '');
            }
            const wanted = (params.bundleId || '').trim();
            const profiles = data
                .map((profile) => ({
                id: profile.id,
                name: profile.attributes?.name || '',
                profileType: profile.attributes?.profileType || '',
                profileState: profile.attributes?.profileState || '',
                uuid: profile.attributes?.uuid || '',
                expirationDate: profile.attributes?.expirationDate || '',
                bundleIdentifier: bundleIds.get(profile.relationships?.bundleId?.data?.id) || '',
            }))
                .filter((profile) => !wanted || profile.bundleIdentifier === wanted)
                .sort((a, b) => (b.expirationDate || '').localeCompare(a.expirationDate || ''));
            return params.limit ? profiles.slice(0, params.limit) : profiles;
        }
        catch (error) {
            console.error('Error listing profiles:', error);
            throw new Error(`Failed to list profiles: ${error.message}`);
        }
    }
    /**
     * Decode one provisioning profile and return the entitlements it actually authorises —
     * the ground truth for "can this build sign that entitlement". Either pass profileId, or
     * pass bundleId and let the newest non-expired profile of profileType be picked.
     */
    async getProfileEntitlements(params) {
        try {
            let profileId = (params.profileId || '').trim();
            if (!profileId) {
                if (!params.bundleId)
                    throw new Error('Pass either profileId or bundleId.');
                const profileType = (params.profileType || 'IOS_APP_STORE').toUpperCase();
                const candidates = await this.listProfiles({ bundleId: params.bundleId, profileType });
                const usable = candidates.filter((profile) => profile.profileState === 'ACTIVE');
                const chosen = usable[0] || candidates[0];
                if (!chosen) {
                    throw new Error(`No ${profileType} profile found for bundle ID "${params.bundleId}". Call list_profiles to see what exists.`);
                }
                profileId = chosen.id;
            }
            const response = await this.makeRequest(`/v1/profiles/${profileId}?include=bundleId&fields[profiles]=name,profileType,profileState,uuid,expirationDate,profileContent,bundleId&fields[bundleIds]=identifier`);
            const attributes = response?.data?.attributes || {};
            if (!attributes.profileContent) {
                throw new Error(`Profile ${profileId} returned no profileContent.`);
            }
            const plist = decodeProvisioningProfile(attributes.profileContent);
            const bundleIdentifier = (response?.included || []).find((item) => item.type === 'bundleIds')?.attributes
                ?.identifier || '';
            return {
                id: response.data.id,
                name: attributes.name || String(plist.Name || ''),
                uuid: attributes.uuid || String(plist.UUID || ''),
                profileType: attributes.profileType || '',
                profileState: attributes.profileState || '',
                expirationDate: attributes.expirationDate || String(plist.ExpirationDate || ''),
                bundleIdentifier,
                entitlements: plist.Entitlements || {},
            };
        }
        catch (error) {
            console.error('Error getting profile entitlements:', error);
            throw new Error(`Failed to get profile entitlements: ${error.message}`);
        }
    }
}
