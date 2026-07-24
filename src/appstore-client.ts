/**
 * App Store Connect API Client
 * Real implementation using Apple's App Store Connect API
 */

import jwt from 'jsonwebtoken';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export interface AppStoreConfig {
  keyId: string;
  issuerId: string;
  privateKey: string;
  bundleId: string;
  appStoreId?: string;
  vendorNumber?: string;
}

export interface AppInfo {
  id: string;
  name: string;
  bundleId: string;
  appStoreId?: string;
  status: string;
  version?: string;
  platform?: string;
}

export interface SalesData {
  date: string;
  revenue: number;
  currency: string;
  transactionCount: number;
  units: number;
}

export interface AppStoreVersion {
  id: string;
  versionString: string;
  platform: string;
  appStoreState: string;
  releaseType?: string;
  earliestReleaseDate?: string;
  copyright?: string;
  createdDate: string;
}

export class AppStoreConnectClient {
  private config: AppStoreConfig;
  private baseUrl = 'https://api.appstoreconnect.apple.com';

  constructor(config: AppStoreConfig) {
    // Check if private key is base64 encoded and trim whitespace
    let privateKey = config.privateKey.trim();
    if (!privateKey.includes('BEGIN PRIVATE KEY')) {
      // Try to decode from base64
      try {
        const decoded = Buffer.from(privateKey, 'base64').toString('utf-8').trim();
        if (decoded.includes('BEGIN PRIVATE KEY')) {
          privateKey = decoded;
        }
      } catch (e) {
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
  private generateToken(): string {
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
          kid: this.config.keyId,  // ✅ CORRECT: 'kid' in header
          typ: 'JWT'
        }
      });
      
      console.log('JWT generated successfully');
      return token;
    } catch (error: any) {
      console.error('Failed to generate JWT:', error.message);
      throw new Error(`JWT generation failed: ${error.message}`);
    }
  }

  /**
   * Make authenticated request to App Store Connect API
   */
  private async makeRequest(endpoint: string, options?: {
    method?: string;
    body?: any;
  }): Promise<any> {
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
      } catch (parseError) {
        throw new Error(`App Store API error: ${response.status} ${response.statusText} - ${errorText}`);
      }
    }

    // DELETE and relationship updates return 204 with no body — don't attempt to parse it.
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  // In-process cache of bundleId -> numeric app id.
  private appIdCache = new Map<string, string>();

  /**
   * Resolve a bundle ID (e.g. "eu.ecofactor") to Apple's numeric app ID.
   * Numeric IDs are returned unchanged; lookups are cached per process.
   */
  private async resolveAppId(appIdOrBundleId: string): Promise<string> {
    const value = (appIdOrBundleId || '').trim();
    if (/^\d+$/.test(value)) return value;
    const cached = this.appIdCache.get(value);
    if (cached) return cached;
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
  private async makeRawRequest(endpoint: string): Promise<Buffer> {
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
      try { detail = JSON.parse(errorText).errors?.[0]?.detail || detail; } catch { /* not JSON */ }
      throw new Error(`App Store API error: ${response.status} - ${detail}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Parse a tab-separated report (Apple sales reports) into row objects keyed by header.
   */
  private parseTsv(tsv: string): Array<Record<string, string>> {
    const lines = tsv.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length < 2) return [];
    const headers = lines[0].split('\t').map((h) => h.trim());
    return lines.slice(1).map((line) => {
      const cells = line.split('\t');
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = (cells[i] ?? '').trim(); });
      return row;
    });
  }

  /**
   * List all apps in App Store Connect
   */
  async listApps(): Promise<AppInfo[]> {
    try {
      const data = await this.makeRequest('/v1/apps');
      
      return data.data?.map((app: any) => ({
        id: app.id,
        name: app.attributes.name,
        bundleId: app.attributes.bundleId,
        appStoreId: app.attributes.sku,
        status: app.attributes.appStoreState,
        platform: app.attributes.primaryLocale,
      })) || [];
    } catch (error: any) {
      console.error('Error listing apps:', error);
      throw new Error(`Failed to fetch apps from Apple Store Connect: ${error.message}`);
    }
  }

  /**
   * Get detailed information about a specific app
   */
  async getAppInfo(appId: string): Promise<AppInfo | null> {
    try {
      appId = await this.resolveAppId(appId);
      const data = await this.makeRequest(`/v1/apps/${appId}`);
      const app = data.data;
      
      if (!app) return null;

      return {
        id: app.id,
        name: app.attributes.name,
        bundleId: app.attributes.bundleId,
        appStoreId: app.attributes.sku,
        status: app.attributes.appStoreState,
        version: app.attributes.contentRightsDeclaration,
        platform: app.attributes.primaryLocale,
      };
    } catch (error: any) {
      console.error('Error getting app info:', error);
      throw new Error(`Failed to fetch app info from Apple Store Connect: ${error.message}`);
    }
  }

  /**
   * Get sales reports for a specific date
   */
  async getSalesData(date?: string): Promise<SalesData> {
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
    } catch (error: any) {
      console.error('Error getting sales data:', error);
      throw new Error(`Failed to fetch sales data from Apple Store Connect: ${error.message}`);
    }
  }

  /**
   * Get app analytics data
   */
  async getAnalytics(appId: string): Promise<any> {
    try {
      appId = await this.resolveAppId(appId);
      // Note: Analytics API might require different endpoints or permissions
      const endpoint = `/v1/apps/${appId}/analyticsReportRequests`;
      return await this.makeRequest(endpoint);
    } catch (error: any) {
      console.error('Error getting analytics:', error);
      throw new Error(`Failed to fetch analytics from Apple Store Connect: ${error.message}`);
    }
  }

  /**
   * Get build information (TestFlight builds)
   */
  async getBuilds(appId: string): Promise<any[]> {
    try {
      appId = await this.resolveAppId(appId);
      const endpoint = `/v1/apps/${appId}/builds`;
      const data = await this.makeRequest(endpoint);
      
      return data.data?.map((build: any) => ({
        id: build.id,
        version: build.attributes.version,
        buildNumber: build.attributes.build,
        processingState: build.attributes.processingState,
        uploadedDate: build.attributes.uploadedDate,
      })) || [];
    } catch (error: any) {
      console.error('Error getting builds:', error);
      throw new Error(`Failed to fetch builds from Apple Store Connect: ${error.message}`);
    }
  }

  /**
   * List all app store versions for an app
   */
  async listAppStoreVersions(appId: string): Promise<AppStoreVersion[]> {
    try {
      appId = await this.resolveAppId(appId);
      const endpoint = `/v1/apps/${appId}/appStoreVersions`;
      const response = await this.makeRequest(endpoint);
      
      return response.data?.map((version: any) => ({
        id: version.id,
        versionString: version.attributes.versionString,
        platform: version.attributes.platform,
        appStoreState: version.attributes.appStoreState,
        releaseType: version.attributes.releaseType,
        earliestReleaseDate: version.attributes.earliestReleaseDate,
        copyright: version.attributes.copyright,
        createdDate: version.attributes.createdDate,
      })) || [];
    } catch (error: any) {
      console.error('Error listing app store versions:', error);
      throw new Error(`Failed to fetch app store versions from Apple Store Connect: ${error.message}`);
    }
  }

  /**
   * List beta groups for TestFlight
   */
  async listBetaGroups(appId: string): Promise<any[]> {
    try {
      appId = await this.resolveAppId(appId);
      const endpoint = `/v1/apps/${appId}/betaGroups`;
      const response = await this.makeRequest(endpoint);
      
      return response.data?.map((group: any) => ({
        id: group.id,
        name: group.attributes.name,
        isInternalGroup: group.attributes.isInternalGroup,
        publicLink: group.attributes.publicLink,
        publicLinkEnabled: group.attributes.publicLinkEnabled,
        publicLinkLimit: group.attributes.publicLinkLimit,
        publicLinkLimitEnabled: group.attributes.publicLinkLimitEnabled,
        createdDate: group.attributes.createdDate,
      })) || [];
    } catch (error: any) {
      console.error('Error listing beta groups:', error);
      throw new Error(`Failed to fetch beta groups from Apple Store Connect: ${error.message}`);
    }
  }

  /**
   * Add a tester to a beta group
   */
  async addTesterToBetaGroup(params: {
    groupId: string;
    email: string;
    firstName?: string;
    lastName?: string;
  }): Promise<any> {
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

      let testerId: string;
      try {
        const testerResponse = await this.makeRequest('/v1/betaTesters', {
          method: 'POST',
          body: testerBody
        });
        testerId = testerResponse.data.id;
      } catch (error: any) {
        // Tester already exists — look them up and attach to the group directly.
        const existingTesters = await this.makeRequest(`/v1/betaTesters?filter[email]=${encodeURIComponent(params.email)}`);
        if (existingTesters.data && existingTesters.data.length > 0) {
          testerId = existingTesters.data[0].id;
          await this.makeRequest(`/v1/betaGroups/${params.groupId}/relationships/betaTesters`, {
            method: 'POST',
            body: { data: [{ type: 'betaTesters', id: testerId }] }
          });
        } else {
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
    } catch (error: any) {
      console.error('Error adding tester to beta group:', error);
      throw new Error(`Failed to add tester to beta group: ${error.message}`);
    }
  }

  /**
   * Update app store version localization (descriptions, keywords, etc.)
   */
  async updateAppStoreVersionLocalization(params: {
    versionId: string;
    locale: string;
    description?: string;
    keywords?: string;
    whatsNew?: string;
    promotionalText?: string;
    supportUrl?: string;
    marketingUrl?: string;
  }): Promise<any> {
    try {
      // First, check if localization exists
      const getEndpoint = `/v1/appStoreVersions/${params.versionId}/appStoreVersionLocalizations`;
      const existingData = await this.makeRequest(getEndpoint);
      
      const existingLocalization = existingData.data?.find(
        (loc: any) => loc.attributes.locale === params.locale
      );

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

        const response = await this.makeRequest(
          `/v1/appStoreVersionLocalizations/${existingLocalization.id}`,
          {
            method: 'PATCH',
            body: updateBody
          }
        );

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
      } else {
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
    } catch (error: any) {
      console.error('Error updating app store version localization:', error);
      throw new Error(`Failed to update app store version localization: ${error.message}`);
    }
  }

  /**
   * Create a new app store version
   */
  async createAppStoreVersion(params: {
    appId: string;
    platform: string;
    versionString: string;
    copyright?: string;
    releaseType?: string;
    earliestReleaseDate?: string;
    buildId?: string;
  }): Promise<AppStoreVersion> {
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
        (body.data.relationships as any).build = {
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
    } catch (error: any) {
      console.error('Error creating app store version:', error);
      throw new Error(`Failed to create app store version: ${error.message}`);
    }
  }

  /**
   * Find the latest uploaded build for an app + build (version) string and attach it to an
   * App Store version, if it has finished processing. Single-shot (no long polling): returns a
   * status so the caller can retry while the build is still processing.
   */
  async attachBuild(params: {
    appId: string;
    versionId: string;
    buildId?: string;
    buildVersionString?: string;
  }): Promise<{ status: 'attached' | 'processing' | 'not_found'; buildId?: string; processingState?: string }> {
    try {
      const appId = await this.resolveAppId(params.appId);

      let build: any;
      if (params.buildId) {
        const data = await this.makeRequest(`/v1/builds/${params.buildId}`);
        build = data.data;
      } else {
        if (!params.buildVersionString) {
          throw new Error('Provide either buildId or buildVersionString to locate the build.');
        }
        const data = await this.makeRequest(
          `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(params.buildVersionString)}&sort=-uploadedDate&limit=1`,
        );
        build = data.data?.[0];
      }

      if (!build) return { status: 'not_found' };

      const state = build.attributes?.processingState;
      if (state !== 'VALID') return { status: 'processing', buildId: build.id, processingState: state };

      await this.makeRequest(`/v1/appStoreVersions/${params.versionId}/relationships/build`, {
        method: 'PATCH',
        body: { data: { type: 'builds', id: build.id } },
      });
      return { status: 'attached', buildId: build.id, processingState: state };
    } catch (error: any) {
      console.error('Error attaching build:', error);
      throw new Error(`Failed to attach build: ${error.message}`);
    }
  }

  /**
   * Submit an App Store version for review (iOS reviewSubmissions flow): optionally set the
   * release type, then create a submission, add the version as an item, and mark it submitted.
   */
  async submitForReview(params: {
    appId: string;
    versionId: string;
    releaseType?: 'MANUAL' | 'AFTER_APPROVAL' | 'SCHEDULED';
  }): Promise<{ submissionId: string }> {
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
    } catch (error: any) {
      console.error('Error submitting for review:', error);
      throw new Error(`Failed to submit for review: ${error.message}`);
    }
  }

  /**
   * List the localizations (store locales + their whatsNew/promotionalText) on an App Store
   * version — so callers can update only the locales the app actually offers.
   */
  async listVersionLocalizations(
    versionId: string,
  ): Promise<Array<{ locale: string; whatsNew?: string; promotionalText?: string }>> {
    try {
      const data = await this.makeRequest(
        `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`,
      );
      return (data.data ?? []).map((l: any) => ({
        locale: l.attributes.locale,
        whatsNew: l.attributes.whatsNew,
        promotionalText: l.attributes.promotionalText,
      }));
    } catch (error: any) {
      console.error('Error listing version localizations:', error);
      throw new Error(`Failed to list version localizations: ${error.message}`);
    }
  }

  /**
   * Get customer reviews for an app
   */
  async getCustomerReviews(appId: string, limit: number = 50): Promise<any[]> {
    try {
      appId = await this.resolveAppId(appId);
      const data = await this.makeRequest(`/v1/apps/${appId}/customerReviews?limit=${limit}&sort=-createdDate`);
      
      return data.data?.map((review: any) => ({
        id: review.id,
        rating: review.attributes.rating,
        title: review.attributes.title,
        body: review.attributes.body,
        reviewerNickname: review.attributes.reviewerNickname,
        territory: review.attributes.territory,
        createdDate: review.attributes.createdDate,
        lastModifiedDate: review.attributes.lastModifiedDate
      })) || [];
    } catch (error: any) {
      console.error('Error getting customer reviews:', error);
      throw new Error(`Failed to get customer reviews: ${error.message}`);
    }
  }

  /**
   * Get app pricing information
   */
  async getAppPricing(appId: string): Promise<any> {
    try {
      appId = await this.resolveAppId(appId);
      const data = await this.makeRequest(`/v1/apps/${appId}/appPriceSchedule`);
      
      if (!data.data) return null;

      return {
        id: data.data.id,
        baseTerritory: data.data.attributes?.baseTerritory,
        currency: data.data.attributes?.currency,
        prices: data.included?.map((price: any) => ({
          territory: price.attributes?.territory,
          price: price.attributes?.customerPrice,
          proceeds: price.attributes?.wholesalePrice
        })) || []
      };
    } catch (error: any) {
      console.error('Error getting app pricing:', error);
      throw new Error(`Failed to get app pricing: ${error.message}`);
    }
  }

  /**
   * Get in-app purchases for an app
   */
  async getInAppPurchases(appId: string): Promise<any[]> {
    try {
      appId = await this.resolveAppId(appId);
      const data = await this.makeRequest(`/v1/apps/${appId}/inAppPurchasesV2?limit=200`);
      
      return data.data?.map((iap: any) => ({
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
    } catch (error: any) {
      console.error('Error getting in-app purchases:', error);
      throw new Error(`Failed to get in-app purchases: ${error.message}`);
    }
  }

  /**
   * Get app availability information
   */
  async getAppAvailability(appId: string): Promise<any> {
    try {
      appId = await this.resolveAppId(appId);
      const data = await this.makeRequest(`/v1/apps/${appId}/appAvailabilityV2`);
      
      if (!data.data) return null;

      return {
        id: data.data.id,
        availableInNewTerritories: data.data.attributes?.availableInNewTerritories,
        territories: data.included?.map((territory: any) => territory.attributes?.territory) || []
      };
    } catch (error: any) {
      console.error('Error getting app availability:', error);
      throw new Error(`Failed to get app availability: ${error.message}`);
    }
  }

  /**
   * Get app info details including categories and age rating
   */
  async getAppInfoDetails(appId: string): Promise<any> {
    try {
      appId = await this.resolveAppId(appId);
      const data = await this.makeRequest(`/v1/apps/${appId}/appInfos`);
      
      if (!data.data?.[0]) return null;

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
    } catch (error: any) {
      console.error('Error getting app info details:', error);
      throw new Error(`Failed to get app info details: ${error.message}`);
    }
  }

  /**
   * Resolve an App Store version ID for an app. If versionString is given, match it exactly;
   * otherwise pick the first version in one of the preferred states, else the most recently
   * created version. Returns id + versionString + state for messaging.
   */
  private async resolveVersionId(
    appId: string,
    versionString?: string,
    preferredStates?: string[],
  ): Promise<{ id: string; versionString: string; state: string }> {
    const versions = await this.listAppStoreVersions(appId);
    if (versions.length === 0) throw new Error('No App Store versions found for this app.');

    if (versionString) {
      const match = versions.find((v) => v.versionString === versionString);
      if (!match) throw new Error(`No App Store version "${versionString}" found for this app.`);
      return { id: match.id, versionString: match.versionString, state: match.appStoreState };
    }

    if (preferredStates && preferredStates.length > 0) {
      const match = versions.find((v) => preferredStates.includes(v.appStoreState));
      if (!match) {
        throw new Error(
          `No App Store version in state ${preferredStates.join('/')} found. Pass versionString explicitly.`,
        );
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
  async releaseVersion(params: {
    appId: string;
    versionString?: string;
  }): Promise<{ versionString: string; releaseRequestId: string }> {
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
    } catch (error: any) {
      console.error('Error releasing version:', error);
      throw new Error(`Failed to release version: ${error.message}`);
    }
  }

  /**
   * Control the iOS 7-day phased release for a version. action get returns the current state;
   * start creates an ACTIVE phased release (or re-activates an existing one); pause/resume/complete
   * PATCH the state to PAUSED/ACTIVE/COMPLETE.
   */
  async managePhasedRelease(params: {
    appId: string;
    versionString?: string;
    action: 'get' | 'start' | 'pause' | 'resume' | 'complete';
  }): Promise<{ versionString: string; action: string; id?: string; state?: string }> {
    try {
      const appId = await this.resolveAppId(params.appId);
      const version = await this.resolveVersionId(appId, params.versionString);

      const current = await this.makeRequest(
        `/v1/appStoreVersions/${version.id}/appStoreVersionPhasedRelease`,
      );
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
          const resp = await this.makeRequest(
            `/v1/appStoreVersionPhasedReleases/${existing.id}`,
            {
              method: 'PATCH',
              body: {
                data: {
                  id: existing.id,
                  type: 'appStoreVersionPhasedReleases',
                  attributes: { phasedReleaseState: 'ACTIVE' },
                },
              },
            },
          );
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
        throw new Error(
          `No phased release exists for version ${version.versionString}. Use action "start" first.`,
        );
      }
      const stateMap = { pause: 'PAUSED', resume: 'ACTIVE', complete: 'COMPLETE' } as const;
      const newState = stateMap[params.action];
      const resp = await this.makeRequest(
        `/v1/appStoreVersionPhasedReleases/${existing.id}`,
        {
          method: 'PATCH',
          body: {
            data: {
              id: existing.id,
              type: 'appStoreVersionPhasedReleases',
              attributes: { phasedReleaseState: newState },
            },
          },
        },
      );
      return {
        versionString: version.versionString,
        action: params.action,
        id: existing.id,
        state: resp.data.attributes?.phasedReleaseState || newState,
      };
    } catch (error: any) {
      console.error('Error managing phased release:', error);
      throw new Error(`Failed to manage phased release: ${error.message}`);
    }
  }

  /**
   * Post (or replace) the developer response to a customer review. Apple limits the response
   * body to 5970 characters.
   */
  async replyToReview(params: {
    reviewId: string;
    responseBody: string;
  }): Promise<{ responseId: string }> {
    try {
      if (params.responseBody.length > 5970) {
        throw new Error(
          `Response body is ${params.responseBody.length} chars; Apple allows a maximum of 5970.`,
        );
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
    } catch (error: any) {
      console.error('Error replying to review:', error);
      throw new Error(`Failed to reply to review: ${error.message}`);
    }
  }

  /**
   * Get the existing developer response for a customer review (null if none).
   */
  async getReviewResponse(
    reviewId: string,
  ): Promise<{ id: string; responseBody: string; state?: string; lastModifiedDate?: string } | null> {
    try {
      const data = await this.makeRequest(`/v1/customerReviews/${reviewId}/response`);
      if (!data?.data) return null;
      return {
        id: data.data.id,
        responseBody: data.data.attributes?.responseBody,
        state: data.data.attributes?.state,
        lastModifiedDate: data.data.attributes?.lastModifiedDate,
      };
    } catch (error: any) {
      console.error('Error getting review response:', error);
      throw new Error(`Failed to get review response: ${error.message}`);
    }
  }

  /**
   * Delete a developer response to a customer review.
   */
  async deleteReviewResponse(responseId: string): Promise<{ deleted: true }> {
    try {
      await this.makeRequest(`/v1/customerReviewResponses/${responseId}`, { method: 'DELETE' });
      return { deleted: true };
    } catch (error: any) {
      console.error('Error deleting review response:', error);
      throw new Error(`Failed to delete review response: ${error.message}`);
    }
  }

  /**
   * Set the TestFlight "what to test" text for a build + locale. Updates the existing
   * betaBuildLocalization when present, otherwise creates one.
   */
  async setBetaWhatsNew(params: {
    buildId: string;
    locale: string;
    whatsNew: string;
  }): Promise<{ id: string; locale: string; created: boolean }> {
    try {
      const existing = await this.makeRequest(
        `/v1/betaBuildLocalizations?filter[build]=${encodeURIComponent(params.buildId)}&filter[locale]=${encodeURIComponent(params.locale)}`,
      );
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
    } catch (error: any) {
      console.error('Error setting beta whats new:', error);
      throw new Error(`Failed to set beta what's new: ${error.message}`);
    }
  }

  /**
   * Submit a build for TestFlight (beta) app review.
   */
  async submitBuildForBetaReview(buildId: string): Promise<{ submissionId: string; state?: string }> {
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
    } catch (error: any) {
      console.error('Error submitting build for beta review:', error);
      throw new Error(`Failed to submit build for beta review: ${error.message}`);
    }
  }

  /**
   * Mark a TestFlight build as expired.
   */
  async expireBuild(buildId: string): Promise<{ buildId: string; expired: boolean }> {
    try {
      const response = await this.makeRequest(`/v1/builds/${buildId}`, {
        method: 'PATCH',
        body: { data: { id: buildId, type: 'builds', attributes: { expired: true } } },
      });
      return { buildId, expired: response?.data?.attributes?.expired ?? true };
    } catch (error: any) {
      console.error('Error expiring build:', error);
      throw new Error(`Failed to expire build: ${error.message}`);
    }
  }

  /**
   * Get available app price points for an app in a territory. Returns the price point id plus
   * customer price and developer proceeds — the id feeds update_price_schedule.
   */
  async getAppPricePoints(params: {
    appId: string;
    territory: string;
  }): Promise<Array<{ id: string; customerPrice?: string; proceeds?: string }>> {
    try {
      const appId = await this.resolveAppId(params.appId);
      const data = await this.makeRequest(
        `/v1/apps/${appId}/appPricePoints?filter[territory]=${encodeURIComponent(params.territory)}&limit=200`,
      );
      return (data?.data ?? []).map((pp: any) => ({
        id: pp.id,
        customerPrice: pp.attributes?.customerPrice,
        proceeds: pp.attributes?.proceeds,
      }));
    } catch (error: any) {
      console.error('Error getting app price points:', error);
      throw new Error(`Failed to get app price points: ${error.message}`);
    }
  }

  /**
   * Set an app's price by creating a new appPriceSchedule pinned to a price point in a base
   * territory. Uses the modern (2023+) pricing API.
   * NOTE: this pricing API shape is intricate and needs live verification against a real account.
   */
  async updatePriceSchedule(params: {
    appId: string;
    territory: string;
    pricePointId: string;
  }): Promise<{ scheduleId: string }> {
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
    } catch (error: any) {
      console.error('Error updating price schedule:', error);
      throw new Error(`Failed to update price schedule: ${error.message}`);
    }
  }

  /**
   * Set an app's territory availability via the v2 appAvailabilities API.
   * NOTE: the v2 appAvailabilities shape needs live verification against a real account.
   */
  async setAppAvailability(params: {
    appId: string;
    territories: string[];
    availableInNewTerritories?: boolean;
  }): Promise<{ availabilityId: string }> {
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
    } catch (error: any) {
      console.error('Error setting app availability:', error);
      throw new Error(`Failed to set app availability: ${error.message}`);
    }
  }

  /**
   * Upload a single screenshot to an app screenshot set: reserve the asset, upload each byte
   * range to the pre-signed URLs, then commit with the file's MD5 checksum.
   * NOTE: the reserve/upload/commit flow needs live verification against a real account.
   */
  async uploadScreenshot(params: {
    screenshotSetId: string;
    filePath: string;
  }): Promise<{ id: string; fileName: string; fileSize: number }> {
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
      const operations: any[] = reserve.data.attributes?.uploadOperations || [];

      // Each operation is a pre-signed URL for one byte range — raw fetch, no JWT.
      for (const op of operations) {
        const slice = fileBuffer.subarray(op.offset, op.offset + op.length);
        const headers: Record<string, string> = {};
        for (const h of op.requestHeaders || []) headers[h.name] = h.value;
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
    } catch (error: any) {
      console.error('Error uploading screenshot:', error);
      throw new Error(`Failed to upload screenshot: ${error.message}`);
    }
  }
}