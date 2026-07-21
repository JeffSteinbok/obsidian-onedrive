/**
 * OneDrive Client - Microsoft Graph API wrapper for OneDrive operations
 *
 * This module provides a clean interface to OneDrive's REST API via the
 * Microsoft Graph SDK. It handles authentication, retries, and path encoding.
 *
 * ## Supported Access Modes
 *
 * - **App Folder**: Isolated `/Apps/ObsidianOneDrive/` folder (default, most secure)
 * - **Full Access**: Any folder in user's OneDrive (needed for shared folders)
 *
 * ## Key Operations
 *
 * - **Delta API** (`getDelta`): Incremental change tracking for efficient sync
 * - **File Operations**: Upload, download, delete, move via Graph API
 * - **Folder Browsing**: List folders for the settings UI picker
 * - **Shared Drive Support**: Access folders shared from other users' OneDrives
 *
 * ## Path Handling
 *
 * OneDrive paths require special encoding for Graph API:
 * - Colons in paths must be encoded (conflicts with Graph's `:` path syntax)
 * - The `encodePathForGraph()` utility handles this
 *
 * ## Error Handling
 *
 * All operations use `retryWithBackoff()` for transient failures and rate limits.
 * Graph API errors are normalized to `OneDriveError` with helpful messages.
 *
 * @see OneDriveAuthProvider for authentication
 * @see FileOperations for higher-level file sync operations
 * @see ChunkUploader for large file uploads
 */

import { Client } from '@microsoft/microsoft-graph-client';
import { requestUrl } from 'obsidian';
import { OneDriveAuthProvider } from '../auth/authProvider';
import { OneDriveItem, OneDriveUser, OneDriveError, OneDriveAccessMode, DeltaResponse } from '../types';
import { logger } from '../utils/logger';
import { retryWithBackoff } from '../utils/retry';
import { encodePathForGraph, stripGraphPrefix } from '../utils/pathUtils';
import { ONEDRIVE_PATHS } from '../constants';

interface GraphCollectionResponse<T> {
	value: T[];
}

interface GraphDeltaApiResponse<T> extends GraphCollectionResponse<T> {
	'@odata.nextLink'?: string;
	'@odata.deltaLink'?: string;
}

type GraphUserResponse = Pick<OneDriveUser, 'id' | 'displayName' | 'mail' | 'userPrincipalName'>;

/**
 * OneDrive client for interacting with Microsoft Graph API
 */
export class OneDriveClient {
	private client: Client;
	private authProvider: OneDriveAuthProvider;
	private accessMode: OneDriveAccessMode;

	// Shared/mounted folder support
	private remoteDriveId?: string;
	private remoteItemId?: string;
	private remoteRootName?: string;
	// Relative path from the shared root to the actual vault folder.
	// Empty when the vault IS the shared root (e.g. test2).
	// Example: "ObsidianVaults/JeffBrain" when shared root is "Jeff Documents"
	// and vault is at "Jeff Documents/ObsidianVaults/JeffBrain".
	private relativePathInShared = '';

	constructor(authProvider: OneDriveAuthProvider, accessMode: OneDriveAccessMode = OneDriveAccessMode.APP_FOLDER) {
		this.authProvider = authProvider;
		this.accessMode = accessMode;
		this.client = Client.initWithMiddleware({
			authProvider: this.authProvider,
		});
		logger.debug('OneDrive client initialized with mode:', accessMode);
	}

	/**
	 * Configure the client for a shared/mounted folder on a different drive.
	 *
	 * @param driveId  - The remote drive ID (owner's drive)
	 * @param itemId   - The item ID of the shared root folder on that drive
	 * @param rootName - Display name of the shared root folder
	 * @param relativePath - Path from the shared root to the vault folder
	 *                       (empty string when the vault IS the shared root)
	 */
	setRemoteDrive(driveId: string, itemId: string, rootName: string, relativePath = ''): void {
		this.remoteDriveId = driveId;
		this.remoteItemId = itemId;
		this.remoteRootName = rootName;
		this.relativePathInShared = relativePath.replace(/^\/+|\/+$/g, '');
		logger.info(`Configured shared drive: driveId=${driveId}, itemId=${itemId}, rootName=${rootName}, relativePath=${this.relativePathInShared || '(root)'}`);
	}

	/**
	 * Check if operating on a shared/remote drive
	 */
	isSharedDrive(): boolean {
		return !!(this.remoteDriveId && this.remoteItemId);
	}

	/**
	 * Build a Graph API endpoint for a given remote path and optional suffix.
	 * Handles app-folder, full-access, and shared-folder modes.
	 *
	 * @param rawPath - Unencoded path relative to the sync root (e.g. "subfolder/file.md").
	 *                  May be empty for root operations.
	 * @param suffix  - Optional Graph operation suffix (e.g. "content", "children", "createUploadSession", "delta")
	 */
	buildEndpoint(rawPath: string, suffix?: string): string {
		// Normalize: strip leading/trailing slashes
		const cleanPath = rawPath.replace(/^\/+|\/+$/g, '');

		if (this.isSharedDrive()) {
			const base = `/drives/${this.remoteDriveId}/items/${this.remoteItemId}`;
			// Prepend the relative path from shared root to vault folder
			// e.g. if shared root is "Jeff Documents" and vault is at
			// "Jeff Documents/ObsidianVaults/JeffBrain", relative is
			// "ObsidianVaults/JeffBrain"
			const fullPath = this.relativePathInShared
				? (cleanPath ? `${this.relativePathInShared}/${cleanPath}` : this.relativePathInShared)
				: cleanPath;
			const encodedPath = fullPath ? encodePathForGraph(fullPath) : '';
			if (!encodedPath) {
				// Root of vault (which IS the shared root)
				return suffix ? `${base}/${suffix}` : base;
			}
			// Nested path within shared folder
			return suffix
				? `${base}:/${encodedPath}:/${suffix}`
				: `${base}:/${encodedPath}`;
		}

		const encodedPath = cleanPath ? encodePathForGraph(cleanPath) : '';

		if (this.accessMode === OneDriveAccessMode.APP_FOLDER) {
			const base = '/me/drive/special/approot';
			if (!encodedPath) {
				return suffix ? `${base}/${suffix}` : base;
			}
			return suffix
				? `${base}:/${encodedPath}:/${suffix}`
				: `${base}:/${encodedPath}`;
		}

		// Full access mode (non-shared)
		const base = '/me/drive/root';
		if (!encodedPath) {
			return suffix ? `${base}/${suffix}` : base;
		}
		return suffix
			? `${base}:/${encodedPath}:/${suffix}`
			: `${base}:/${encodedPath}`;
	}

	/**
	 * Build an endpoint for an item by ID, using the correct drive.
	 */
	getItemEndpoint(itemId: string): string {
		if (this.remoteDriveId) {
			return `/drives/${this.remoteDriveId}/items/${itemId}`;
		}
		return `/me/drive/items/${itemId}`;
	}

	/**
	 * Get a valid access token. Used by callers that make raw HTTP requests
	 * (e.g. requestUrl) instead of going through the Graph SDK client.
	 */
	async getAccessToken(): Promise<string> {
		return this.authProvider.getAccessToken();
	}

	private async getGraph<T>(endpoint: string): Promise<T> {
		return retryWithBackoff<T>(() => this.client.api(endpoint).get() as Promise<T>);
	}

	private async postGraph<T>(endpoint: string, body: unknown): Promise<T> {
		return retryWithBackoff<T>(() => this.client.api(endpoint).post(body) as Promise<T>);
	}

	/**
	 * Resolve the actual path of a shared folder on its home drive.
	 * Call after selecting a shared folder to get its full path for delta path stripping.
	 */
	async resolveSharedFolderPath(driveId: string, itemId: string): Promise<string> {
		logger.debug('Resolving shared folder path:', { driveId, itemId });

		try {
			const item = await this.getGraph<OneDriveItem>(`/drives/${driveId}/items/${itemId}`);
			// Build the full path from parentReference.path + name
			// parentReference.path may be "/drive/root:" or "/drives/{id}/root:/some/path"
			let parentPath = item.parentReference?.path || '';
			// Strip all known Graph API prefixes
			parentPath = parentPath.replace(/^\/drives\/[^/]+\/root:/, '');
			parentPath = parentPath.replace(/^\/drive\/root:/, '');

			const fullPath = parentPath ? `${parentPath}/${item.name}` : `/${item.name}`;
			logger.info(`Resolved shared folder path: ${fullPath}`);
			return fullPath;
		} catch (error) {
			logger.error('Failed to resolve shared folder path:', error);
			throw new OneDriveError(
				`Failed to resolve shared folder: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * @deprecated Use buildEndpoint() instead. Kept for backward compat during migration.
	 */
	getDriveEndpoint(path: string): string {
		if (this.accessMode === OneDriveAccessMode.APP_FOLDER) {
			return `/me/drive/special/approot:/${path}`;
		} else {
			return `/me/drive/root:/${path}`;
		}
	}

	/**
	 * Get current user info
	 */
	async getUserInfo(): Promise<OneDriveUser> {
		logger.debug('Fetching user info');

		try {
			const response = await this.getGraph<GraphUserResponse>('/me');

			return {
				id: response.id,
				displayName: response.displayName,
				mail: response.mail,
				userPrincipalName: response.userPrincipalName,
			};
		} catch (error) {
			logger.error('Failed to get user info:', error);
			throw new OneDriveError(
				`Failed to get user info: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * Resolve the actual on-disk path of the app folder (e.g. "/Apps/ObsidianOneDrive").
	 * The folder name is determined by the Azure app registration display name and may
	 * differ from the hardcoded constant — call this at init time to discover the real path.
	 */
	async resolveAppFolderPath(): Promise<string> {
		try {
			const item = await this.getGraph<OneDriveItem>('/me/drive/special/approot');
			const parentPath = item.parentReference?.path
				? stripGraphPrefix(item.parentReference.path)
				: '/Apps';
			return `${parentPath}/${item.name}`;
		} catch (error) {
			logger.warn('Could not resolve app folder path, using default', error);
			return ONEDRIVE_PATHS.APP_FOLDER;
		}
	}

	/**
	 * Get item by path (relative to sync root)
	 */
	async getItemByPath(path: string): Promise<OneDriveItem> {
		logger.debug('Getting item by path:', path);

		try {
			const endpoint = this.buildEndpoint(path);
			return await this.getGraph<OneDriveItem>(endpoint);
		} catch (error) {
			logger.error(`Failed to get item at path ${path}:`, error);
			throw new OneDriveError(
				`Failed to get item: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * List items in a folder (path relative to sync root)
	 */
	async listFolder(folderPath: string = ''): Promise<OneDriveItem[]> {
		logger.debug('Listing folder:', folderPath);

		try {
			const apiPath = this.buildEndpoint(folderPath, 'children');
			const response = await this.getGraph<GraphCollectionResponse<OneDriveItem>>(apiPath);

			return response.value;
		} catch (error) {
			logger.error(`Failed to list folder ${folderPath}:`, error);
			throw new OneDriveError(
				`Failed to list folder: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * List folders at a specific path for the folder picker.
	 * For the user's own drive, uses /me/drive paths.
	 * For shared folders, uses /drives/{driveId}/items/{itemId} paths.
	 */
	async listFoldersForPicker(
		folderPath: string = '',
		sharedDriveId?: string,
		sharedItemId?: string,
		relativePathInShared?: string
	): Promise<OneDriveItem[]> {
		logger.debug('Listing folders for picker:', { folderPath, sharedDriveId, relativePathInShared });

		try {
			let apiPath: string;

			if (sharedDriveId && sharedItemId) {
				// Inside a shared folder — use the remote drive
				const cleanRelative = (relativePathInShared || '').replace(/^\/+|\/+$/g, '');
				if (!cleanRelative) {
					apiPath = `/drives/${sharedDriveId}/items/${sharedItemId}/children`;
				} else {
					const encoded = encodePathForGraph(cleanRelative);
					apiPath = `/drives/${sharedDriveId}/items/${sharedItemId}:/${encoded}:/children`;
				}
			} else {
				// User's own drive
				const cleanPath = folderPath.replace(/^\/+|\/+$/g, '');
				if (!cleanPath) {
					apiPath = '/me/drive/root/children';
				} else {
					const encoded = encodePathForGraph(cleanPath);
					apiPath = `/me/drive/root:/${encoded}:/children`;
				}
			}

			const response = await this.getGraph<GraphCollectionResponse<OneDriveItem>>(apiPath);
			const items = response.value;

			// Return only folders (including shared/mounted shortcuts)
			return items.filter((item) => item.folder || item.remoteItem?.folder);
		} catch (error) {
			logger.error(`Failed to list folders for picker at ${folderPath}:`, error);
			throw new OneDriveError(
				`Failed to list folders: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * List folders within the App Folder for the folder picker.
	 * Uses /me/drive/special/approot as the base.
	 */
	async listAppFoldersForPicker(folderPath: string = ''): Promise<OneDriveItem[]> {
		logger.debug('Listing App Folder subfolders for picker:', { folderPath });

		try {
			const cleanPath = folderPath.replace(/^\/+|\/+$/g, '');
			let apiPath: string;

			if (!cleanPath) {
				apiPath = '/me/drive/special/approot/children';
			} else {
				const encoded = encodePathForGraph(cleanPath);
				apiPath = `/me/drive/special/approot:/${encoded}:/children`;
			}

			const response = await this.getGraph<GraphCollectionResponse<OneDriveItem>>(apiPath);
			// Return only folders
			return response.value.filter((item) => item.folder);
		} catch (error) {
			logger.error(`Failed to list App Folder subfolders at ${folderPath}:`, error);
			throw new OneDriveError(
				`Failed to list folders: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * List all items recursively
	 */
	async listAllItems(folderPath: string = ''): Promise<OneDriveItem[]> {
		const allItems: OneDriveItem[] = [];
		await this.listRecursive(folderPath, allItems);
		return allItems;
	}

	private async listRecursive(folderPath: string, accumulator: OneDriveItem[]): Promise<void> {
		const items = await this.listFolder(folderPath);

		for (const item of items) {
			accumulator.push(item);

			// If it's a folder, recurse into it
			if (item.folder) {
				const childPath = folderPath ? `${folderPath}/${item.name}` : item.name;
				await this.listRecursive(childPath, accumulator);
			}
		}
	}

	/**
	 * Create a folder
	 */
	async createFolder(folderPath: string, folderName: string): Promise<OneDriveItem> {
		logger.debug('Creating folder:', folderPath, folderName);

		try {
			const apiPath = this.buildEndpoint(folderPath, 'children');

			return await this.postGraph<OneDriveItem>(apiPath, {
				name: folderName,
				folder: {},
				'@microsoft.graph.conflictBehavior': 'fail',
			});
		} catch (error) {
			// Ignore if folder already exists
			if (error instanceof Error && error.message.includes('nameAlreadyExists')) {
				logger.debug(`Folder ${folderName} already exists`);
				return this.getItemByPath(folderPath ? `${folderPath}/${folderName}` : folderName);
			}

			logger.error(`Failed to create folder ${folderPath}/${folderName}:`, error);
			throw new OneDriveError(
				`Failed to create folder: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * Delete an item
	 */
	async deleteItem(itemId: string): Promise<void> {
		logger.debug('Deleting item:', itemId);

		try {
			await retryWithBackoff(() => this.client.api(this.getItemEndpoint(itemId)).delete());
			logger.debug('Item deleted successfully');
		} catch (error) {
			// 404 means the item is already gone — that's the outcome we wanted
			if (error && typeof error === 'object' && 'statusCode' in error && (error as { statusCode: number }).statusCode === 404) {
				logger.debug(`Item ${itemId} already deleted (404) — treating as success`);
				return;
			}
			logger.error(`Failed to delete item ${itemId}:`, error);
			throw new OneDriveError(
				`Failed to delete item: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * Move/rename an item using OneDrive's PATCH API.
	 * This is atomic and more efficient than delete+upload (no re-upload needed).
	 * @param itemId The OneDrive ID of the item to move
	 * @param newPath The new path (relative to remote root) for the item
	 * @returns The updated item metadata
	 */
	async moveItem(itemId: string, newPath: string): Promise<OneDriveItem> {
		logger.debug(`Moving item ${itemId} to ${newPath}`);

		// Parse the new path into parent folder path and new name
		const segments = newPath.split('/').filter((s) => s.length > 0);
		const newName = segments.pop();
		if (!newName) {
			throw new OneDriveError('Invalid move destination: empty path');
		}
		const newParentPath = segments.join('/');

		try {
			// Build the PATCH body with new name and parent reference
			const patchBody: Record<string, unknown> = {
				name: newName,
			};

			// Get the parent folder ID — we always need to set parentReference
			// to ensure the item moves to the correct location
			if (newParentPath) {
				const parentItem = await this.getItemByPath(newParentPath);
				patchBody.parentReference = { id: parentItem.id };
			} else {
				// Moving to root — get the root folder ID
				const rootEndpoint = this.buildEndpoint('');
				const rootItem = await this.getGraph<OneDriveItem>(rootEndpoint);
				patchBody.parentReference = { id: rootItem.id };
			}

			const result = await retryWithBackoff<OneDriveItem>(() =>
				this.client.api(this.getItemEndpoint(itemId)).patch(patchBody) as Promise<OneDriveItem>
			);

			logger.info(`Moved item ${itemId} to ${newPath}`);
			return result;
		} catch (error) {
			logger.error(`Failed to move item ${itemId} to ${newPath}:`, error);
			throw new OneDriveError(
				`Failed to move item: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * Download a file
	 */
	async downloadFile(itemId: string): Promise<ArrayBuffer> {
		logger.debug('Downloading file:', itemId);

		try {
			// Get file metadata first to get download URL
			const item = await this.getGraph<OneDriveItem>(this.getItemEndpoint(itemId));

			if (!item['@microsoft.graph.downloadUrl']) {
				throw new Error('No download URL available');
			}

			// Download using the direct URL (already has auth in URL)
			const downloadUrl = item['@microsoft.graph.downloadUrl'];

			// Use requestUrl for binary download (no auth header needed - it's in the URL)
			const response = await requestUrl({
				url: downloadUrl,
				method: 'GET',
				throw: false,
			});

			if (response.status < 200 || response.status >= 300) {
				throw new Error(`HTTP ${response.status}: ${response.text || 'Request failed'}`);
			}

			return response.arrayBuffer;
		} catch (error) {
			logger.error(`Failed to download file ${itemId}:`, error);
			throw new OneDriveError(
				`Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * Check if item exists at path
	 */
	async itemExists(path: string): Promise<boolean> {
		try {
			await this.getItemByPath(path);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Get changes since last delta token using OneDrive delta API.
	 * First call (no deltaLink): returns all items + deltaLink.
	 * Subsequent calls: returns only changes since the token.
	 *
	 * @param deltaLink Stored delta cursor; if undefined the call starts a fresh stream.
	 * @param remotePath Remote vault root path (Full Access mode only).
	 * @param subPath Optional path under the vault root to scope the delta to (e.g. the config directory).
	 *                When the scoped folder does not yet exist remotely the call returns an empty
	 *                result so the first sync can proceed and later create it via upload.
	 */
	async getDelta(deltaLink?: string, remotePath?: string, subPath?: string): Promise<DeltaResponse> {
		logger.debug('Getting delta changes', { hasDeltaLink: !!deltaLink, remotePath, subPath });

		const allItems: OneDriveItem[] = [];
		const cleanSubPath = subPath ? subPath.replace(/^\/+|\/+$/g, '') : undefined;

		try {
			let nextUrl: string;

			if (deltaLink) {
				// Use stored delta link for incremental changes
				nextUrl = deltaLink;
			} else if (this.isSharedDrive()) {
				// For shared drives, prepend the relative path from the shared
				// root to the vault folder (empty when vault IS the shared root)
				const relPrefix = this.relativePathInShared;
				const fullSub = relPrefix
					? (cleanSubPath ? `${relPrefix}/${cleanSubPath}` : relPrefix)
					: cleanSubPath;
				if (fullSub) {
					const encoded = encodePathForGraph(fullSub);
					nextUrl = `/drives/${this.remoteDriveId}/items/${this.remoteItemId}:/${encoded}:/delta`;
				} else {
					nextUrl = `/drives/${this.remoteDriveId}/items/${this.remoteItemId}/delta`;
				}
			} else if (this.accessMode === OneDriveAccessMode.APP_FOLDER) {
				// Scope the delta to the vault's subfolder within the app folder.
				// remotePath is the vault subfolder (e.g. "obsidian_Usumbura"),
				// subPath narrows further (e.g. the config dir). Without this the
				// query hit the whole app folder and returned sibling vaults'
				// files, corrupting the vault (see issue #97).
				const cleanRemote = remotePath ? remotePath.replace(/^\/+|\/+$/g, '') : '';
				const fullPath = [cleanRemote, cleanSubPath].filter(Boolean).join('/');
				if (fullPath) {
					const encoded = encodePathForGraph(fullPath);
					nextUrl = `/me/drive/special/approot:/${encoded}:/delta`;
				} else {
					nextUrl = '/me/drive/special/approot/delta';
				}
			} else if (remotePath) {
				const cleanPath = remotePath.replace(/^\//, '');
				const fullPath = cleanSubPath ? `${cleanPath}/${cleanSubPath}` : cleanPath;
				const encoded = encodePathForGraph(fullPath);
				nextUrl = `/me/drive/root:/${encoded}:/delta`;
			} else if (cleanSubPath) {
				const encoded = encodePathForGraph(cleanSubPath);
				nextUrl = `/me/drive/root:/${encoded}:/delta`;
			} else {
				nextUrl = '/me/drive/root/delta';
			}

			// Page through all results
			while (nextUrl) {
				const response = await this.getGraph<GraphDeltaApiResponse<OneDriveItem>>(nextUrl);

				if (response.value.length > 0) {
					allItems.push(...response.value);
				}

				if (response['@odata.nextLink']) {
					nextUrl = response['@odata.nextLink'];
				} else {
					// Final page — save the delta link for next time
					return {
						items: allItems,
						deltaLink: response['@odata.deltaLink'] || '',
					};
				}
			}
			// Loop always exits via return above; this satisfies TypeScript
			throw new Error('Unreachable: delta pagination loop exited unexpectedly');
		} catch (error) {
			// If the scoped folder does not exist yet, treat as empty so first sync can create it.
			if (cleanSubPath && !deltaLink && this.isItemNotFoundError(error)) {
				logger.info(`Delta target '${cleanSubPath}' not found remotely — treating as empty`);
				return { items: [], deltaLink: '' };
			}

			// If the delta token is invalid/expired, do a full resync
			const msg = error instanceof Error ? error.message.toLowerCase() : '';
			if (deltaLink &&
				(msg.includes('resyncrequired') || msg.includes('resync required') || msg.includes('invalidtoken'))) {
				logger.warn('Delta token expired, performing full resync');
				return this.getDelta(undefined, remotePath, subPath); // Retry without token
			}

			logger.error('Failed to get delta:', error);
			throw new OneDriveError(
				`Failed to get delta: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	private isItemNotFoundError(error: unknown): boolean {
		if (error instanceof OneDriveError) {
			if (error.statusCode === 404) return true;
			if (error.code === 'itemNotFound') return true;
		}
		// Graph SDK throws GraphError with statusCode/code properties but not as OneDriveError
		if (error && typeof error === 'object') {
			const err = error as Record<string, unknown>;
			if (err.statusCode === 404) return true;
			if (err.code === 'itemNotFound') return true;
		}
		if (error instanceof Error && /itemNotFound|404|resource could not be found/i.test(error.message)) {
			return true;
		}
		return false;
	}

	/**
	 * Get Graph client instance (for advanced operations)
	 */
	getClient(): Client {
		return this.client;
	}
}
