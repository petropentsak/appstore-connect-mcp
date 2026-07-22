/**
 * App Store Connect API Client
 * Real implementation using Apple's App Store Connect API
 */
import jwt from 'jsonwebtoken';
import { gunzipSync } from 'node:zlib';
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
        const url = `${this.baseUrl}${endpoint}`;
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
        return response.json();
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
}
