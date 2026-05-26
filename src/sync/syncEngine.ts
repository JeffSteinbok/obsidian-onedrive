/**
 * Main sync engine
 * Uses OneDrive delta API for remote changes and vault events for local changes
 */

import { App, Notice, TFile } from 'obsidian';
import { FileOperations } from '../api/fileOperations';
import { OneDriveClient } from '../api/oneDriveClient';
import { SyncStateManager } from './syncState';
import { ConflictResolver } from './conflictResolver';
import { EventManager } from './eventManager';
import {
	SyncOperation,
	SyncDirection,
	FileState,
	OneDriveItem,
	ConflictInfo,
	LocalChange,
	LocalChangeType,
} from '../types';
import { logger } from '../utils/logger';
import { normalizePath, toOneDrivePath, toVaultPath, getParentPath } from '../utils/pathUtils';

/**
 * Main sync engine
 */
export class SyncEngine {
	private isSharedDrive: boolean;
	private remoteRootOnDrive: string;

	constructor(
		private app: App,
		private fileOps: FileOperations,
		private oneDriveClient: OneDriveClient,
		private stateManager: SyncStateManager,
		private conflictResolver: ConflictResolver,
		private eventManager: EventManager,
		private remoteRoot: string = '',
		remoteRootOnDrive?: string
	) {
		this.isSharedDrive = oneDriveClient.isSharedDrive();
		// For shared drives, delta items have paths relative to the remote drive root,
		// so we need the folder name on that drive for path stripping
		this.remoteRootOnDrive = remoteRootOnDrive || remoteRoot;
	}

	/**
	 * Perform a sync using delta API + local dirty files
	 */
	async performSync(): Promise<void> {
		logger.info('Starting sync operation');

		try {
			// 1. Get local changes from event manager
			const localChanges = this.eventManager.getDirtyFiles();
			logger.info(`Local changes: ${localChanges.length} dirty files`);
			for (const change of localChanges) {
				logger.info(`  Local: ${change.type} ${change.path}${change.oldPath ? ` (from ${change.oldPath})` : ''}`);
			}

			// 2. Get remote changes via delta API
			const deltaLink = this.stateManager.getDeltaLink();
			const isFirstSync = this.stateManager.isFirstSync();
			logger.info(`Delta query: isFirstSync=${isFirstSync}, hasDeltaLink=${!!deltaLink}`);
			const deltaResponse = await this.oneDriveClient.getDelta(deltaLink, this.remoteRoot);

			// Log all raw delta items for debugging
			for (const item of deltaResponse.items) {
				const vaultPath = this.remotePathToVaultPath(item);
				logger.debug(`  Raw delta item: name=${item.name} path=${vaultPath} isFolder=${!!item.folder} isFile=${!!item.file} deleted=${!!item.deleted} parentPath=${item.parentReference?.path || 'none'}`);
			}

			// Filter remote changes: only files, skip .obsidian/
			const remoteChanges = deltaResponse.items.filter((item) => {
				// Include files and deleted items (deleted items won't have .file)
				if (item.folder && !item.deleted) return false;
				const vaultPath = this.remotePathToVaultPath(item);
				return !vaultPath.startsWith('.obsidian/');
			});

			logger.info(`Delta returned ${deltaResponse.items.length} total items, ${remoteChanges.length} file changes`);
			for (const item of remoteChanges) {
				const vaultPath = this.remotePathToVaultPath(item);
				logger.info(`  Remote: ${item.deleted ? 'DELETE' : 'CHANGED'} ${vaultPath} (id=${item.id})`);
			}

			// 3. Plan operations
			const operations = this.planOperations(localChanges, remoteChanges, isFirstSync);

			logger.info(`Sync plan: ${operations.length} operations`);
			for (const op of operations) {
				logger.info(`  Op: ${op.direction} ${op.path}`);
			}

			if (operations.length === 0) {
				if (isFirstSync && localChanges.length === 0 && remoteChanges.length === 0) {
					logger.info('First sync with no local dirty files and empty remote — nothing to do. Edit or create files, then sync again.');
					new Notice('OneDrive sync: No files to sync. Edit or create files first.');
				} else {
					new Notice('OneDrive sync: Everything up to date');
				}
				// Store delta link and update sync time even with no changes
				this.stateManager.setDeltaLink(deltaResponse.deltaLink);
				this.stateManager.setLastSyncTime(Date.now());
				return;
			}

			// 4. Execute operations
			let completed = 0;
			const downloadedPaths: string[] = [];
			for (const operation of operations) {
				await this.executeOperation(operation);
				completed++;

				if (operation.direction === SyncDirection.DOWNLOAD) {
					downloadedPaths.push(operation.path);
				}

				if (operations.length > 5) {
					new Notice(`Syncing: ${completed}/${operations.length} files`, 2000);
				}
			}

			// Clear any dirty-file entries for paths we just downloaded,
			// so they don't boomerang back as uploads on the next cycle
			if (downloadedPaths.length > 0) {
				this.eventManager.removeDirtyPaths(downloadedPaths);
			}

			// 5. Store new delta link and update sync time
			this.stateManager.setDeltaLink(deltaResponse.deltaLink);
			this.stateManager.setLastSyncTime(Date.now());

				// Clear dirty files only after successful sync
				this.eventManager.clearDirtyFiles();

			logger.info('Sync completed successfully');
			new Notice(`OneDrive sync: ${completed} file${completed === 1 ? '' : 's'} synced`);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : 'Unknown error';
			logger.error(`Sync failed: ${errorMsg}`, error);
			new Notice(`OneDrive sync failed: ${errorMsg}`);
			throw error;
		}
	}

	/**
	 * Plan sync operations from local changes and remote delta
	 */
	private planOperations(
		localChanges: LocalChange[],
		remoteChanges: OneDriveItem[],
		isFirstSync: boolean
	): SyncOperation[] {
		const operations: SyncOperation[] = [];

		// Build a map of remote changes by vault path
		const remoteByPath = new Map<string, OneDriveItem>();
		for (const item of remoteChanges) {
			const vaultPath = this.remotePathToVaultPath(item);
			remoteByPath.set(vaultPath, item);
		}

		// Build a set of locally changed paths
		const localChangedPaths = new Set(localChanges.map((c) => c.path));
		const localChangeMap = new Map(localChanges.map((c) => [c.path, c]));

		// Process local changes
		for (const change of localChanges) {
			const remoteItem = remoteByPath.get(change.path);

			if (change.type === LocalChangeType.DELETE) {
				// Local delete — delete from remote if it exists there
				const knownState = this.stateManager.getFileState(change.path);
				if (knownState?.oneDriveId) {
					operations.push({
						path: change.path,
						direction: SyncDirection.UPLOAD, // "upload" the deletion
						localState: undefined,
						remoteState: knownState,
					});
				}
				continue;
			}

				if (change.type === LocalChangeType.RENAME && change.oldPath) {
					// Rename: upload to new path and delete old path from remote
					const oldState = this.stateManager.getFileState(change.oldPath);
					if (oldState?.oneDriveId) {
						operations.push({
							path: change.oldPath,
							direction: SyncDirection.UPLOAD, // "upload" the deletion of old path
							localState: undefined,
							remoteState: oldState,
						});
					}
					// Upload the file at its new path
					operations.push({ path: change.path, direction: SyncDirection.UPLOAD });
					this.stateManager.removeFileState(change.oldPath);
					remoteByPath.delete(change.path);
					continue;
				}

			if (remoteItem && remoteItem.deleted) {
				// Local change + remote delete = conflict, re-upload local
				operations.push({
					path: change.path,
					direction: SyncDirection.UPLOAD,
				});
				continue;
			}

			if (remoteItem && !remoteItem.deleted) {
				// Both changed — conflict
				const knownState = this.stateManager.getFileState(change.path);
				const file = this.app.vault.getAbstractFileByPath(change.path);
				if (file instanceof TFile && knownState) {
					const conflictInfo: ConflictInfo = {
						path: change.path,
						localModifiedTime: file.stat.mtime,
						remoteModifiedTime: new Date(remoteItem.lastModifiedDateTime).getTime(),
						localSize: file.stat.size,
						remoteSize: remoteItem.size || 0,
					};
					const resolution = this.conflictResolver.resolveConflict(conflictInfo);
					operations.push({
						path: resolution.newPath || change.path,
						direction: resolution.direction,
						remoteState: this.itemToFileState(remoteItem),
					});
				} else {
					// No known state, upload local
					operations.push({ path: change.path, direction: SyncDirection.UPLOAD });
				}
				// Remove from remote map so we don't process it again
				remoteByPath.delete(change.path);
				continue;
			}

			// Local change, no remote change — upload
			operations.push({ path: change.path, direction: SyncDirection.UPLOAD });
		}

		// Process remaining remote changes (not conflicting with local)
		for (const [vaultPath, item] of remoteByPath) {
			if (localChangedPaths.has(vaultPath)) continue; // Already handled

			if (item.deleted) {
				// Remote delete — delete locally
				const file = this.app.vault.getAbstractFileByPath(vaultPath);
				if (file) {
					operations.push({
						path: vaultPath,
						direction: SyncDirection.DOWNLOAD, // "download" the deletion
						remoteState: undefined,
					});
				}
				// Clean up state
				this.stateManager.removeFileState(vaultPath);
				continue;
			}

			if (!item.file) continue; // Skip non-file items

			// On first sync, check if file already exists locally
			if (isFirstSync) {
				const file = this.app.vault.getAbstractFileByPath(vaultPath);
					if (file instanceof TFile) {
						if (file.stat.size === (item.size || 0)) {
							// Same size — likely identical, store state and skip
							this.stateManager.setFileState(vaultPath, this.itemToFileState(item));
							continue;
						}
						// File exists but different size — download remote version
						operations.push({
							path: vaultPath,
							direction: SyncDirection.DOWNLOAD,
							remoteState: this.itemToFileState(item),
						});
						continue;
					}
				}

			// Check if remote actually changed vs our stored state
			const knownState = this.stateManager.getFileState(vaultPath);
			if (knownState) {
				const remoteHash = item.file?.hashes?.quickXorHash || '';
				if (knownState.remoteHash === remoteHash) {
					// Remote hasn't actually changed — skip
					continue;
				}
			}

			// Remote change — download
			operations.push({
				path: vaultPath,
				direction: SyncDirection.DOWNLOAD,
				remoteState: this.itemToFileState(item),
			});
		}

		return operations;
	}

	/**
	 * Convert OneDriveItem to FileState
	 */
	private itemToFileState(item: OneDriveItem): FileState {
		return {
			path: this.remotePathToVaultPath(item),
			localMtime: 0,
			remoteHash: item.file?.hashes?.quickXorHash || '',
			size: item.size || 0,
			remoteModifiedTime: new Date(item.lastModifiedDateTime).getTime(),
			oneDriveId: item.id,
		};
	}

	/**
	 * Execute a sync operation
	 */
	private async executeOperation(operation: SyncOperation): Promise<void> {
		logger.debug(`Executing ${operation.direction} for ${operation.path}`);

		try {
			if (operation.direction === SyncDirection.UPLOAD) {
				if (operation.localState === undefined && operation.remoteState?.oneDriveId) {
					// This is a delete operation
					await this.fileOps.deleteFile(operation.remoteState.oneDriveId);
					this.stateManager.removeFileState(operation.path);
					logger.debug(`Deleted remote ${operation.path}`);
				} else {
					await this.uploadFile(operation);
				}
			} else if (operation.direction === SyncDirection.DOWNLOAD) {
				if (operation.remoteState === undefined) {
					// This is a remote delete — delete locally
					await this.deleteLocalFile(operation.path);
				} else {
					await this.downloadFile(operation);
				}
			}
		} catch (error) {
			logger.error(`Failed to execute operation for ${operation.path}:`, error);
			throw error;
		}
	}

	/**
	 * Upload a file to OneDrive
	 */
	private async uploadFile(operation: SyncOperation): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(operation.path);
		if (!(file instanceof TFile)) {
			logger.warn(`File not found locally: ${operation.path}`);
			return;
		}

		const content = await this.app.vault.readBinary(file);
		const remotePath = this.vaultPathToRemotePath(operation.path);
		const item = await this.fileOps.uploadFile(remotePath, content);

		this.stateManager.setFileState(operation.path, {
			path: operation.path,
			localMtime: file.stat.mtime,
			remoteHash: item.file?.hashes?.quickXorHash || '',
			size: content.byteLength,
			remoteModifiedTime: new Date(item.lastModifiedDateTime).getTime(),
			oneDriveId: item.id,
		});

		logger.debug(`Uploaded ${operation.path} successfully`);
	}

	/**
	 * Ensure parent folders exist in the vault for a given file path
	 */
	private async ensureVaultFolders(filePath: string): Promise<void> {
		const parentPath = getParentPath(filePath);
		if (!parentPath) return;

		const adapter = this.app.vault.adapter;
		if (await adapter.exists(parentPath)) return;

		await adapter.mkdir(parentPath);
	}

	/**
	 * Download a file from OneDrive
	 */
	private async downloadFile(operation: SyncOperation): Promise<void> {
		if (!operation.remoteState?.oneDriveId) {
			logger.warn(`No remote ID for ${operation.path}`);
			return;
		}

		const content = await this.fileOps.downloadFile(operation.remoteState.oneDriveId);

		await this.ensureVaultFolders(operation.path);

		// Use adapter API — works for all files including .obsidian/
		const adapter = this.app.vault.adapter;
		try {
			// Mark as our own write so event manager ignores the resulting vault events
			this.eventManager.markOwnWrites([operation.path]);
			await adapter.writeBinary(operation.path, content);
		} catch {
			const parentPath = getParentPath(operation.path);
			if (parentPath) {
				await adapter.mkdir(parentPath);
			}
			try {
				await adapter.writeBinary(operation.path, content);
			} catch (retryError) {
				// Write failed — remove from ownWritePaths so future edits aren't suppressed
				this.eventManager.removeOwnWrite(operation.path);
				throw retryError;
			}
		}

		// Get the mtime Obsidian assigned to the file
		const file = this.app.vault.getAbstractFileByPath(operation.path);
		const localMtime = file instanceof TFile ? file.stat.mtime : Date.now();

		this.stateManager.setFileState(operation.path, {
			path: operation.path,
			localMtime,
			remoteHash: operation.remoteState.remoteHash,
			size: content.byteLength,
			remoteModifiedTime: operation.remoteState.remoteModifiedTime,
			oneDriveId: operation.remoteState.oneDriveId,
		});

		logger.debug(`Downloaded ${operation.path} successfully`);
	}

	/**
	 * Delete a local file
	 */
	private async deleteLocalFile(filePath: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file) {
			this.eventManager.markOwnWrites([filePath]);
			try {
				await this.app.vault.delete(file);
			} catch (error) {
				this.eventManager.removeOwnWrite(filePath);
				throw error;
			}
			logger.debug(`Deleted local file ${filePath}`);
		}
		this.stateManager.removeFileState(filePath);
	}

	/**
	 * Convert vault path to remote OneDrive path.
	 * For shared drives, paths are relative to the shared folder (no prefix).
	 * For non-shared full-access, paths include the remote root.
	 */
	private vaultPathToRemotePath(vaultPath: string): string {
		if (this.isSharedDrive) {
			// Paths are relative to the shared folder — buildEndpoint handles the base
			return normalizePath(vaultPath);
		}
		return toOneDrivePath(vaultPath, this.remoteRoot);
	}

	/**
	 * Convert remote OneDrive path to vault path
	 */
	private remotePathToVaultPath(item: OneDriveItem): string {
		let fullPath = item.parentReference?.path
			? `${item.parentReference.path}/${item.name}`
			: item.name;

		// Strip OneDrive API prefixes
		fullPath = fullPath.replace(/^\/drive\/root:/, '');
		fullPath = fullPath.replace(/^\/drive\/special\/approot:/, '');
		fullPath = fullPath.replace(/^\/drives\/[^/]+\/root:/, '');

		return toVaultPath(fullPath, this.remoteRootOnDrive);
	}
}
