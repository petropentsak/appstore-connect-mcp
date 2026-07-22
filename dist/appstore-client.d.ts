/**
 * App Store Connect API Client
 * Real implementation using Apple's App Store Connect API
 */
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
export declare class AppStoreConnectClient {
    private config;
    private baseUrl;
    constructor(config: AppStoreConfig);
    /**
     * Generate JWT token for App Store Connect API authentication
     */
    private generateToken;
    /**
     * Make authenticated request to App Store Connect API
     */
    private makeRequest;
    private appIdCache;
    /**
     * Resolve a bundle ID (e.g. "eu.ecofactor") to Apple's numeric app ID.
     * Numeric IDs are returned unchanged; lookups are cached per process.
     */
    private resolveAppId;
    /**
     * Make an authenticated request that returns raw bytes (e.g. gzipped report files).
     */
    private makeRawRequest;
    /**
     * Parse a tab-separated report (Apple sales reports) into row objects keyed by header.
     */
    private parseTsv;
    /**
     * List all apps in App Store Connect
     */
    listApps(): Promise<AppInfo[]>;
    /**
     * Get detailed information about a specific app
     */
    getAppInfo(appId: string): Promise<AppInfo | null>;
    /**
     * Get sales reports for a specific date
     */
    getSalesData(date?: string): Promise<SalesData>;
    /**
     * Get app analytics data
     */
    getAnalytics(appId: string): Promise<any>;
    /**
     * Get build information (TestFlight builds)
     */
    getBuilds(appId: string): Promise<any[]>;
    /**
     * List all app store versions for an app
     */
    listAppStoreVersions(appId: string): Promise<AppStoreVersion[]>;
    /**
     * List beta groups for TestFlight
     */
    listBetaGroups(appId: string): Promise<any[]>;
    /**
     * Add a tester to a beta group
     */
    addTesterToBetaGroup(params: {
        groupId: string;
        email: string;
        firstName?: string;
        lastName?: string;
    }): Promise<any>;
    /**
     * Update app store version localization (descriptions, keywords, etc.)
     */
    updateAppStoreVersionLocalization(params: {
        versionId: string;
        locale: string;
        description?: string;
        keywords?: string;
        whatsNew?: string;
        promotionalText?: string;
        supportUrl?: string;
        marketingUrl?: string;
    }): Promise<any>;
    /**
     * Create a new app store version
     */
    createAppStoreVersion(params: {
        appId: string;
        platform: string;
        versionString: string;
        copyright?: string;
        releaseType?: string;
        earliestReleaseDate?: string;
        buildId?: string;
    }): Promise<AppStoreVersion>;
    /**
     * Get customer reviews for an app
     */
    getCustomerReviews(appId: string, limit?: number): Promise<any[]>;
    /**
     * Get app pricing information
     */
    getAppPricing(appId: string): Promise<any>;
    /**
     * Get in-app purchases for an app
     */
    getInAppPurchases(appId: string): Promise<any[]>;
    /**
     * Get app availability information
     */
    getAppAvailability(appId: string): Promise<any>;
    /**
     * Get app info details including categories and age rating
     */
    getAppInfoDetails(appId: string): Promise<any>;
}
