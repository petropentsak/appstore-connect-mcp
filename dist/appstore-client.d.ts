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
     * Find the latest uploaded build for an app + build (version) string and attach it to an
     * App Store version, if it has finished processing. Single-shot (no long polling): returns a
     * status so the caller can retry while the build is still processing.
     */
    attachBuild(params: {
        appId: string;
        versionId: string;
        buildId?: string;
        buildVersionString?: string;
    }): Promise<{
        status: 'attached' | 'processing' | 'not_found';
        buildId?: string;
        processingState?: string;
    }>;
    /**
     * Submit an App Store version for review (iOS reviewSubmissions flow): optionally set the
     * release type, then create a submission, add the version as an item, and mark it submitted.
     */
    submitForReview(params: {
        appId: string;
        versionId: string;
        releaseType?: 'MANUAL' | 'AFTER_APPROVAL' | 'SCHEDULED';
    }): Promise<{
        submissionId: string;
    }>;
    /**
     * List the localizations (store locales + their whatsNew/promotionalText) on an App Store
     * version — so callers can update only the locales the app actually offers.
     */
    listVersionLocalizations(versionId: string): Promise<Array<{
        locale: string;
        whatsNew?: string;
        promotionalText?: string;
    }>>;
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
    /**
     * Resolve an App Store version ID for an app. If versionString is given, match it exactly;
     * otherwise pick the first version in one of the preferred states, else the most recently
     * created version. Returns id + versionString + state for messaging.
     */
    private resolveVersionId;
    /**
     * Release an approved version that is waiting for manual developer release. Resolves the
     * version in PENDING_DEVELOPER_RELEASE when versionString is omitted.
     */
    releaseVersion(params: {
        appId: string;
        versionString?: string;
    }): Promise<{
        versionString: string;
        releaseRequestId: string;
    }>;
    /**
     * Control the iOS 7-day phased release for a version. action get returns the current state;
     * start creates an ACTIVE phased release (or re-activates an existing one); pause/resume/complete
     * PATCH the state to PAUSED/ACTIVE/COMPLETE.
     */
    managePhasedRelease(params: {
        appId: string;
        versionString?: string;
        action: 'get' | 'start' | 'pause' | 'resume' | 'complete';
    }): Promise<{
        versionString: string;
        action: string;
        id?: string;
        state?: string;
    }>;
    /**
     * Post (or replace) the developer response to a customer review. Apple limits the response
     * body to 5970 characters.
     */
    replyToReview(params: {
        reviewId: string;
        responseBody: string;
    }): Promise<{
        responseId: string;
    }>;
    /**
     * Get the existing developer response for a customer review (null if none).
     */
    getReviewResponse(reviewId: string): Promise<{
        id: string;
        responseBody: string;
        state?: string;
        lastModifiedDate?: string;
    } | null>;
    /**
     * Delete a developer response to a customer review.
     */
    deleteReviewResponse(responseId: string): Promise<{
        deleted: true;
    }>;
    /**
     * Set the TestFlight "what to test" text for a build + locale. Updates the existing
     * betaBuildLocalization when present, otherwise creates one.
     */
    setBetaWhatsNew(params: {
        buildId: string;
        locale: string;
        whatsNew: string;
    }): Promise<{
        id: string;
        locale: string;
        created: boolean;
    }>;
    /**
     * Submit a build for TestFlight (beta) app review.
     */
    submitBuildForBetaReview(buildId: string): Promise<{
        submissionId: string;
        state?: string;
    }>;
    /**
     * Mark a TestFlight build as expired.
     */
    expireBuild(buildId: string): Promise<{
        buildId: string;
        expired: boolean;
    }>;
    /**
     * Get available app price points for an app in a territory. Returns the price point id plus
     * customer price and developer proceeds — the id feeds update_price_schedule.
     */
    getAppPricePoints(params: {
        appId: string;
        territory: string;
    }): Promise<Array<{
        id: string;
        customerPrice?: string;
        proceeds?: string;
    }>>;
    /**
     * Set an app's price by creating a new appPriceSchedule pinned to a price point in a base
     * territory. Uses the modern (2023+) pricing API.
     * NOTE: this pricing API shape is intricate and needs live verification against a real account.
     */
    updatePriceSchedule(params: {
        appId: string;
        territory: string;
        pricePointId: string;
    }): Promise<{
        scheduleId: string;
    }>;
    /**
     * Set an app's territory availability via the v2 appAvailabilities API.
     * NOTE: the v2 appAvailabilities shape needs live verification against a real account.
     */
    setAppAvailability(params: {
        appId: string;
        territories: string[];
        availableInNewTerritories?: boolean;
    }): Promise<{
        availabilityId: string;
    }>;
    /**
     * Upload a single screenshot to an app screenshot set: reserve the asset, upload each byte
     * range to the pre-signed URLs, then commit with the file's MD5 checksum.
     * NOTE: the reserve/upload/commit flow needs live verification against a real account.
     */
    uploadScreenshot(params: {
        screenshotSetId: string;
        filePath: string;
    }): Promise<{
        id: string;
        fileName: string;
        fileSize: number;
    }>;
}
