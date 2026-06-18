/**
 * High-level file operations for OneDrive
 */

import { OneDriveClient } from './oneDriveClient';
import { ChunkUploader } from './chunkUpload';
import { OneDriveItem } from '../types';
import { logger } from '../utils/logger';
import { getParentPath } from '../utils/pathUtils';

/**
 * File operations manager
 */
export class FileOperations {
	private client: OneDriveClient;
	private chunkUploader: ChunkUploader;
	private pendingFolderEnsures = new Map<string, Promise<void>>();
	private skipFolderChecks: () => boolean;

	constructor(client: OneDriveClient, skipFolderChecks: () => boolean = () => true) {
		this.client = client;
		this.chunkUploader = new ChunkUploader(client);
		this.skipFolderChecks = skipFolderChecks;
	}

	/**
	 * Set the OneDrive client (used after reconnection)
	 */
	setClient(client: OneDriveClient): void {
		this.client = client;
		this.chunkUploader = new ChunkUploader(client);
	}

	/**
	 * Upload a file to OneDrive
	 */
	async uploadFile(
		remotePath: string,
		content: ArrayBuffer,
		onProgress?: (uploaded: number, total: number) => void
	): Promise<OneDriveItem> {
		logger.debug('Uploading file:', remotePath);

		// Skip folder checks if experimental setting is enabled (default: ON)
		// OneDrive auto-creates parent folders on PUT, so this is safe
		if (!this.skipFolderChecks()) {
			await this.ensureParentFolder(remotePath);
		}

		// Upload file
		return this.chunkUploader.uploadFile(remotePath, content, onProgress);
	}

	/**
	 * Download a file from OneDrive
	 */
	async downloadFile(itemId: string): Promise<ArrayBuffer> {
		logger.debug('Downloading file:', itemId);
		return this.client.downloadFile(itemId);
	}

	/**
	 * Download file by path
	 */
	async downloadFileByPath(remotePath: string): Promise<ArrayBuffer> {
		logger.debug('Downloading file by path:', remotePath);
		const item = await this.client.getItemByPath(remotePath);
		return this.downloadFile(item.id);
	}

	/**
	 * Delete a file from OneDrive
	 */
	async deleteFile(itemId: string): Promise<void> {
		logger.debug('Deleting file:', itemId);
		await this.client.deleteItem(itemId);
	}

	/**
	 * Delete file by path
	 */
	async deleteFileByPath(remotePath: string): Promise<void> {
		logger.debug('Deleting file by path:', remotePath);
		const item = await this.client.getItemByPath(remotePath);
		await this.deleteFile(item.id);
	}

	/**
	 * Move/rename a file on OneDrive using the atomic PATCH API.
	 * More efficient than delete+upload (no re-upload) and avoids duplicate files.
	 * @param itemId The OneDrive ID of the file to move
	 * @param newRemotePath The new path for the file
	 * @returns The updated file metadata
	 */
	async moveFile(itemId: string, newRemotePath: string): Promise<OneDriveItem> {
		logger.debug('Moving file:', itemId, 'to', newRemotePath);
		return this.client.moveItem(itemId, newRemotePath);
	}

	/**
	 * List all files recursively
	 */
	async listAllFiles(folderPath: string = ''): Promise<OneDriveItem[]> {
		logger.debug('Listing all files in:', folderPath);
		const allItems = await this.client.listAllItems(folderPath);

		// Filter to only files (exclude folders)
		return allItems.filter((item) => !!item.file);
	}

	/**
	 * Check if file exists
	 */
	async fileExists(remotePath: string): Promise<boolean> {
		return this.client.itemExists(remotePath);
	}

	/**
	 * Ensure parent folder exists (create if needed)
	 */
	private async ensureParentFolder(remotePath: string): Promise<void> {
		const parentPath = getParentPath(remotePath);

		if (!parentPath) {
			// File is in root, no need to create folders
			return;
		}

		// Split path into segments and create each folder
		const segments = parentPath.split('/').filter((s) => s.length > 0);
		let currentPath = '';

		for (const segment of segments) {
			const nextPath = currentPath ? `${currentPath}/${segment}` : segment;
			await this.ensureFolderExists(currentPath, segment, nextPath);
			currentPath = nextPath;
		}
	}

	/**
	 * Ensure a single remote folder exists, sharing in-flight checks/creates across parallel uploads.
	 */
	private async ensureFolderExists(
		parentPath: string,
		folderName: string,
		folderPath: string
	): Promise<void> {
		const pendingEnsure = this.pendingFolderEnsures.get(folderPath);
		if (pendingEnsure) {
			await pendingEnsure;
			return;
		}

		const ensurePromise = (async () => {
			const exists = await this.client.itemExists(folderPath);
			if (exists) {
				return;
			}

			try {
				await this.client.createFolder(parentPath, folderName);
			} catch (error) {
				if (!(await this.client.itemExists(folderPath))) {
					throw error;
				}
			}
		})();

		this.pendingFolderEnsures.set(folderPath, ensurePromise);
		try {
			await ensurePromise;
		} finally {
			this.pendingFolderEnsures.delete(folderPath);
		}
	}

	/**
	 * Create a folder on OneDrive (including any missing ancestors).
	 * Returns the OneDrive item for the created/existing folder.
	 */
	async createFolder(remotePath: string): Promise<OneDriveItem> {
		logger.debug('Creating folder:', remotePath);
		const segments = remotePath.split('/').filter((s) => s.length > 0);
		let currentPath = '';

		for (const segment of segments) {
			const parentPath = currentPath;
			const nextPath = currentPath ? `${currentPath}/${segment}` : segment;
			await this.ensureFolderExists(parentPath, segment, nextPath);
			currentPath = nextPath;
		}

		// Return the item metadata for the leaf folder
		return this.client.getItemByPath(remotePath);
	}

	/**
	 * Get file metadata
	 */
	async getFileMetadata(remotePath: string): Promise<OneDriveItem> {
		return this.client.getItemByPath(remotePath);
	}
}
