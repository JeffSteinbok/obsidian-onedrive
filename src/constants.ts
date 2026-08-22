/**
 * Constants for OneDrive OAuth and API integration
 */

import { AccountType, OneDriveAccessMode } from './types';

// Global Microsoft identity host. Passed as a parameter of resolveOAuthEndpoints()
// so a national cloud (US Government, 21Vianet) can supply a different host later.
export const IDENTITY_HOST = 'https://login.microsoftonline.com';

export interface OAuthEndpointSet {
	DEVICE_CODE: string;
	TOKEN: string;
	AUTHORIZE: string;
}

// A tenant ID is either a directory GUID or a verified domain
// (contoso.onmicrosoft.com). Anything else — surrounding whitespace from a
// portal copy/paste, a pasted full authority URL, a stray path segment —
// would silently rewrite the authority URL, so reject it up front instead of
// sending a malformed request and reporting an opaque 400.
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/** Resolve the OAuth endpoints for an account type. Throws if a tenant ID is required but unusable. */
export function resolveOAuthEndpoints(
	accountType: AccountType,
	tenantId: string | undefined,
	identityHost: string = IDENTITY_HOST
): OAuthEndpointSet {
	let segment: string;
	if (accountType === 'personal') {
		segment = 'consumers';
	} else if (accountType === 'work-school') {
		segment = 'organizations';
	} else {
		const trimmedTenantId = tenantId?.trim();
		if (!trimmedTenantId) {
			throw new Error('A tenant ID is required for the tenant account type');
		}
		if (!TENANT_ID_PATTERN.test(trimmedTenantId)) {
			throw new Error(
				`Invalid tenant ID "${trimmedTenantId}". Use the directory (tenant) ID or a verified domain name.`
			);
		}
		segment = trimmedTenantId;
	}

	return {
		DEVICE_CODE: `${identityHost}/${segment}/oauth2/v2.0/devicecode`,
		TOKEN: `${identityHost}/${segment}/oauth2/v2.0/token`,
		AUTHORIZE: `${identityHost}/${segment}/oauth2/v2.0/authorize`,
	};
}

// Default endpoint set for callers without a configured identity (e.g. constructor defaults).
export const OAUTH_ENDPOINTS = resolveOAuthEndpoints('personal', undefined);

// Microsoft Graph API
export const GRAPH_API_ENDPOINT = 'https://graph.microsoft.com/v1.0';

// OAuth scopes for App Folder mode (default - secure, isolated). Personal accounts only.
export const OAUTH_SCOPES_APP_FOLDER = [
	'User.Read', // Read user profile
	'Files.ReadWrite.AppFolder', // Read/write app-specific folder only
	'offline_access', // Enable refresh tokens
];

// OAuth scopes for Full Access mode (advanced - for sharing). Personal accounts only.
export const OAUTH_SCOPES_FULL_ACCESS = [
	'User.Read', // Read user profile
	'Files.ReadWrite.All', // Read/write access to all OneDrive files
	'offline_access', // Enable refresh tokens
];

// OAuth scopes for work/school accounts. Files.ReadWrite.AppFolder is not offered
// to work or school accounts, so these accounts always use Full Access mode —
// which includes the shared-folder browser. Browsing and syncing a folder on
// another drive needs Files.ReadWrite.All; plain Files.ReadWrite only covers the
// signed-in user's own drive and would 403 as soon as a shared folder is picked.
export const OAUTH_SCOPES_WORK_SCHOOL = [
	'User.Read', // Read user profile
	'Files.ReadWrite.All', // Read/write access to the user's files and shared folders
	'offline_access', // Enable refresh tokens
];

export function resolveOAuthScopes(accountType: AccountType, accessMode: OneDriveAccessMode): string[] {
	if (accountType !== 'personal') {
		return OAUTH_SCOPES_WORK_SCHOOL;
	}
	return accessMode === OneDriveAccessMode.FULL_ACCESS ? OAUTH_SCOPES_FULL_ACCESS : OAUTH_SCOPES_APP_FOLDER;
}

// Default OneDrive client ID (registered Azure AD app)
export const DEFAULT_ONEDRIVE_CLIENT_ID = '49ec1ec3-7237-4b7b-89e0-aeb6565fc70b';

// Sync configuration
export const SYNC_CONFIG = {
	// Throttle delay for vault events (milliseconds)
	EVENT_THROTTLE_MS: 3000,
	// Token refresh buffer (milliseconds before expiry)
	TOKEN_REFRESH_BUFFER_MS: 120000, // 2 minutes
	// Minimum chunk size for OneDrive API
	MIN_CHUNK_SIZE: 327680, // 320 KB
	// Maximum chunk size for OneDrive API
	MAX_CHUNK_SIZE: 62914560, // 60 MB
	// Small file upload threshold
	SMALL_FILE_THRESHOLD: 4194304, // 4 MB
	// Target number of chunks per file
	TARGET_CHUNKS_PER_FILE: 20,
};

// OneDrive paths
export const ONEDRIVE_PATHS = {
	// Default app folder (requires Files.ReadWrite.AppFolder scope)
	APP_FOLDER: '/Apps/ObsidianOneDrive',
	// Special value for app folder API endpoint
	APP_ROOT: 'approot',
};
