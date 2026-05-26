/**
 * Microsoft Graph client wrapper for OneDrive operations
 */

import { Client } from '@microsoft/microsoft-graph-client';
import { OneDriveAuthProvider } from '../auth/authProvider';
import { OneDriveItem, OneDriveUser, OneDriveError, OneDriveAccessMode, DeltaResponse } from '../types';
import { logger } from '../utils/logger';
import { retryWithBackoff } from '../utils/retry';

/**
 * OneDrive client for interacting with Microsoft Graph API
 */
export class OneDriveClient {
	private client: Client;
	private authProvider: OneDriveAuthProvider;
	private accessMode: OneDriveAccessMode;

	constructor(authProvider: OneDriveAuthProvider, accessMode: OneDriveAccessMode = OneDriveAccessMode.APP_FOLDER) {
		this.authProvider = authProvider;
		this.accessMode = accessMode;
		this.client = Client.initWithMiddleware({
			authProvider: this.authProvider,
		});
		logger.debug('OneDrive client initialized with mode:', accessMode);
	}

	/**
	 * Get the correct drive endpoint based on access mode
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
			const response = await retryWithBackoff(() => this.client.api('/me').get());

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
	 * Get item by path
	 */
	async getItemByPath(path: string): Promise<OneDriveItem> {
		logger.debug('Getting item by path:', path);

		try {
			const encodedPath = encodeURIComponent(path);
			const endpoint = this.getDriveEndpoint(encodedPath);
			const response = await retryWithBackoff(() =>
				this.client.api(endpoint).get()
			);

			return response as OneDriveItem;
		} catch (error) {
			logger.error(`Failed to get item at path ${path}:`, error);
			throw new OneDriveError(
				`Failed to get item: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * List items in a folder
	 */
	async listFolder(folderPath: string = ''): Promise<OneDriveItem[]> {
		logger.debug('Listing folder:', folderPath);

		try {
			let apiPath: string;
			if (folderPath === '' || folderPath === '/') {
				// List root
				if (this.accessMode === OneDriveAccessMode.APP_FOLDER) {
					apiPath = '/me/drive/special/approot/children';
				} else {
					apiPath = '/me/drive/root/children';
				}
			} else {
				const encodedPath = encodeURIComponent(folderPath);
				apiPath = `${this.getDriveEndpoint(encodedPath)}:/children`;
			}

			const response = await retryWithBackoff(() => this.client.api(apiPath).get());

			return response.value as OneDriveItem[];
		} catch (error) {
			logger.error(`Failed to list folder ${folderPath}:`, error);
			throw new OneDriveError(
				`Failed to list folder: ${error instanceof Error ? error.message : 'Unknown error'}`
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
			let apiPath: string;
			if (folderPath === '' || folderPath === '/') {
				if (this.accessMode === OneDriveAccessMode.APP_FOLDER) {
					apiPath = '/me/drive/special/approot/children';
				} else {
					apiPath = '/me/drive/root/children';
				}
			} else {
				const encodedPath = encodeURIComponent(folderPath);
				apiPath = `${this.getDriveEndpoint(encodedPath)}:/children`;
			}

			const response = await retryWithBackoff(() =>
				this.client.api(apiPath).post({
					name: folderName,
					folder: {},
					'@microsoft.graph.conflictBehavior': 'fail',
				})
			);

			return response as OneDriveItem;
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
			await retryWithBackoff(() => this.client.api(`/me/drive/items/${itemId}`).delete());
			logger.debug('Item deleted successfully');
		} catch (error) {
			logger.error(`Failed to delete item ${itemId}:`, error);
			throw new OneDriveError(
				`Failed to delete item: ${error instanceof Error ? error.message : 'Unknown error'}`
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
			const item: OneDriveItem = await retryWithBackoff(() =>
				this.client.api(`/me/drive/items/${itemId}`).get()
			);

			if (!item['@microsoft.graph.downloadUrl']) {
				throw new Error('No download URL available');
			}

			// Download using the direct URL (already has auth in URL)
			const downloadUrl = item['@microsoft.graph.downloadUrl'];

			// Use fetch for binary download (no auth header needed - it's in the URL)
			const response = await fetch(downloadUrl);

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			return await response.arrayBuffer();
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
	 */
	async getDelta(deltaLink?: string, remotePath?: string): Promise<DeltaResponse> {
		logger.debug('Getting delta changes', { hasDeltaLink: !!deltaLink, remotePath });

		const allItems: OneDriveItem[] = [];

		try {
			let nextUrl: string;

			if (deltaLink) {
				// Use stored delta link for incremental changes
				nextUrl = deltaLink;
			} else {
				// Initial sync — scope to the correct folder
				if (this.accessMode === OneDriveAccessMode.APP_FOLDER) {
					nextUrl = '/me/drive/special/approot/delta';
				} else if (remotePath) {
					// Scope delta to just the sync folder, not entire OneDrive
					const encodedPath = remotePath.replace(/^\//, '');
					nextUrl = `/me/drive/root:/${encodedPath}:/delta`;
				} else {
					nextUrl = '/me/drive/root/delta';
				}
			}

			// Page through all results
			while (nextUrl) {
				const response = await retryWithBackoff(() =>
					this.client.api(nextUrl).get()
				);

				if (response.value) {
					allItems.push(...(response.value as OneDriveItem[]));
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

			return { items: allItems, deltaLink: '' };
		} catch (error) {
			// If the delta token is invalid/expired, do a full resync
			if (deltaLink && error instanceof Error &&
				(error.message.includes('resyncRequired') || error.message.includes('invalidToken'))) {
				logger.warn('Delta token expired, performing full resync');
				return this.getDelta(); // Retry without token
			}

			logger.error('Failed to get delta:', error);
			throw new OneDriveError(
				`Failed to get delta: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * Get Graph client instance (for advanced operations)
	 */
	getClient(): Client {
		return this.client;
	}
}
