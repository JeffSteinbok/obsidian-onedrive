/**
 * TypeScript interfaces and types for the OneDrive sync plugin
 */

// ============================================================================
// Authentication Types
// ============================================================================

export interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
	message?: string;
}

export interface TokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	scope: string;
	refresh_token?: string;
}

export interface StoredTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // Unix timestamp in milliseconds
	expiresIn: number; // Duration in seconds
}

// ============================================================================
// OneDrive API Types
// ============================================================================

export interface OneDriveItem {
	id: string;
	name: string;
	size?: number;
	folder?: {
		childCount: number;
	};
	file?: {
		mimeType: string;
		hashes?: {
			sha1Hash?: string;
			quickXorHash?: string;
		};
	};
	deleted?: {
		state: string;
	};
	lastModifiedDateTime: string;
	createdDateTime: string;
	'@microsoft.graph.downloadUrl'?: string;
	parentReference?: {
		id: string;
		path: string;
		driveId?: string;
	};
	remoteItem?: {
		id: string;
		name: string;
		folder?: { childCount: number };
		parentReference: {
			driveId: string;
			id?: string;
			path?: string;
		};
	};
	__resolvedVaultPath?: string;
}

export interface OneDriveUploadSession {
	uploadUrl: string;
	expirationDateTime: string;
	nextExpectedRanges?: string[];
}

export interface OneDriveUser {
	displayName: string;
	mail?: string;
	userPrincipalName: string;
	id: string;
}

// ============================================================================
// Sync Types
// ============================================================================

export interface SyncState {
	lastSyncTime: number; // Unix timestamp in milliseconds
	fileStates: Map<string, FileState>;
	folderStates: Map<string, string>; // OneDrive folder id → vault path. Needed
	// so that folder-delete delta entries (which arrive with id only — no name,
	// no parentReference) can be reverse-resolved to a path and expanded into
	// per-file deletes for everything we know was beneath that folder.
	deltaLink?: string; // OneDrive delta API cursor
	obsidianDeltaLink?: string; // Separate delta cursor for .obsidian scope
}

export interface FileState {
	path: string;
	localMtime: number; // from Obsidian file.stat.mtime
	remoteHash: string; // quickXorHash from OneDrive
	size: number;
	remoteModifiedTime: number;
	oneDriveId?: string;
	localContentHash?: string; // hex hash of local content (config files only)
}

export enum LocalChangeType {
	MODIFY = 'modify',
	CREATE = 'create',
	DELETE = 'delete',
	RENAME = 'rename',
}

export interface LocalChange {
	path: string;
	type: LocalChangeType;
	oldPath?: string; // for renames
}

export interface DeltaResponse {
	items: OneDriveItem[];
	deltaLink: string;
}

export enum SyncDirection {
	UPLOAD = 'upload',
	DOWNLOAD = 'download',
	SKIP = 'skip',
	CONFLICT = 'conflict',
}

export interface SyncOperation {
	path: string;
	direction: SyncDirection;
	localState?: FileState;
	remoteState?: FileState;
}

export interface LargeDeleteWarningInfo {
	localDeleteCount: number; // files about to be deleted from the local vault (driven by remote)
	remoteDeleteCount: number; // files about to be deleted from OneDrive (driven by local)
	threshold: number;
	sampleLocalDeletes: string[]; // up to 10 example paths
	sampleRemoteDeletes: string[]; // up to 10 example paths
}

export type LargeDeleteDecision = 'proceed' | 'cancel' | 'disable';

export type LargeDeleteWarningHandler = (
	info: LargeDeleteWarningInfo
) => Promise<LargeDeleteDecision>;

export enum ConflictResolutionStrategy {
	LAST_WRITE_WINS = 'last-write-wins',
	CREATE_DUPLICATE = 'create-duplicate',
	MANUAL = 'manual',
}

export interface ConflictInfo {
	path: string;
	localModifiedTime: number;
	remoteModifiedTime: number;
	localSize: number;
	remoteSize: number;
}

// ============================================================================
// Conflict Queue Types
// ============================================================================

export enum ConflictResolution {
	ACCEPT_CURRENT = 'accept-current',
	ACCEPT_INCOMING = 'accept-incoming',
	ACCEPT_BOTH = 'accept-both',
}

export interface ConflictEntry {
	id: string;
	path: string;
	localModifiedTime: number;
	remoteModifiedTime: number;
	localSize: number;
	remoteSize: number;
	remoteOneDriveId: string;
	remoteHash: string;
	createdAt: number;
	isTextFile: boolean;
}

export interface PersistedConflictQueue {
	entries: ConflictEntry[];
}

// ============================================================================
// Plugin Settings Types
// ============================================================================

export enum OneDriveAccessMode {
	APP_FOLDER = 'app-folder', // Secure, isolated folder
	FULL_ACCESS = 'full-access', // Access to all OneDrive files
}

export interface PluginSettings {
	// Authentication
	useCustomClientId: boolean;
	customClientId?: string;
	tokens?: StoredTokens;
	connectedUser?: OneDriveUser;

	// Access mode
	accessMode: OneDriveAccessMode; // App Folder (default) or Full Access

	// Sync configuration
	syncInterval: number; // Minutes (0 = manual only)
	conflictResolution: ConflictResolutionStrategy;
	startupSyncDelay: number; // Seconds (0 = disabled, 1, 10, 30)
	syncAppSettings: boolean; // Opt-in sync for Obsidian app settings (app.json, appearance.json, hotkeys.json)
	syncPluginManifests: boolean; // Opt-in sync for selected Obsidian plugin manifest files and binaries
	syncState?: {
		lastSyncTime: number;
		fileStates: Array<[string, FileState]>;
		deltaLink?: string;
		obsidianDeltaLink?: string;
	};
	conflictQueue?: PersistedConflictQueue;

	// Advanced
	remotePath?: string; // Custom path (only used with Full Access mode)
	remoteDriveId?: string; // Drive ID for shared/mounted folders
	remoteItemId?: string; // Item ID of the root folder on the remote drive
	remoteRootName?: string; // Display name of the root folder on the remote drive
	remoteRootPath?: string; // Full path of the folder on the remote drive (e.g. /Documents/ObsidianVaults/JeffBrain)
	enableDebugLogging: boolean;
	largeDeleteThreshold: number; // Warn if a sync would delete more than this many files (0 = disabled)
}

export const DEFAULT_SETTINGS: PluginSettings = {
	// Authentication
	useCustomClientId: false,
	customClientId: undefined,
	tokens: undefined,
	connectedUser: undefined,

	// Access mode
	accessMode: OneDriveAccessMode.APP_FOLDER, // Default to secure mode

	// Sync configuration
	syncInterval: 5, // Poll every 5 minutes
	conflictResolution: ConflictResolutionStrategy.LAST_WRITE_WINS,
	startupSyncDelay: 10, // 10 seconds default
	syncAppSettings: true,
	syncPluginManifests: true,
	syncState: undefined,
	conflictQueue: undefined,

	// Advanced
	remotePath: undefined, // Only used with Full Access mode
	enableDebugLogging: false,
	largeDeleteThreshold: 25,
};

// ============================================================================
// Error Types
// ============================================================================

export class OneDriveError extends Error {
	constructor(
		message: string,
		public code?: string,
		public statusCode?: number
	) {
		super(message);
		this.name = 'OneDriveError';
	}
}

export class AuthenticationError extends OneDriveError {
	constructor(message: string, code?: string) {
		super(message, code, 401);
		this.name = 'AuthenticationError';
	}
}

export class RateLimitError extends OneDriveError {
	constructor(
		message: string,
		public retryAfter?: number
	) {
		super(message, 'rate_limit', 429);
		this.name = 'RateLimitError';
	}
}

export class SyncError extends Error {
	constructor(
		message: string,
		public path?: string,
		public operation?: string
	) {
		super(message);
		this.name = 'SyncError';
	}
}
