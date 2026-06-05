/**
 * Constants for OneDrive OAuth and API integration
 */

// OAuth 2.0 Device Code Flow endpoints
export const OAUTH_ENDPOINTS = {
	DEVICE_CODE: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
	TOKEN: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
	AUTHORIZE: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
};

// Microsoft Graph API
export const GRAPH_API_ENDPOINT = 'https://graph.microsoft.com/v1.0';

// OAuth scopes for App Folder mode (default - secure, isolated)
export const OAUTH_SCOPES_APP_FOLDER = [
	'User.Read', // Read user profile
	'Files.ReadWrite.AppFolder', // Read/write app-specific folder only
	'offline_access', // Enable refresh tokens
];

// OAuth scopes for Full Access mode (advanced - for sharing)
export const OAUTH_SCOPES_FULL_ACCESS = [
	'User.Read', // Read user profile
	'Files.ReadWrite.All', // Read/write access to all OneDrive files
	'offline_access', // Enable refresh tokens
];

// Default OneDrive client ID (registered Azure AD app)
export const DEFAULT_ONEDRIVE_CLIENT_ID = '49ec1ec3-7237-4b7b-89e0-aeb6565fc70b';

// Sync configuration
export const SYNC_CONFIG = {
	// Throttle delay for vault events (milliseconds)
	EVENT_THROTTLE_MS: 3000,
	// Token refresh buffer (milliseconds before expiry)
	TOKEN_REFRESH_BUFFER_MS: 120000, // 2 minutes
	// Default chunk size for large file uploads
	DEFAULT_CHUNK_SIZE: 6815744, // 6.5 MB (proven size from remotely-save)
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

// Plugin metadata
export const PLUGIN_INFO = {
	NAME: 'OneDrive Sync',
	ID: 'onedrive-sync',
	VERSION: '0.1.0',
};
