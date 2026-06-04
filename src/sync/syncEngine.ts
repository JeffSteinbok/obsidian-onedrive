/**
 * Main sync engine
 * Uses OneDrive delta API for remote changes and vault events for local changes
 */

import { App, Notice, TFile } from 'obsidian';
import { FileOperations } from '../api/fileOperations';
import { OneDriveClient } from '../api/oneDriveClient';
import { SyncStateManager } from './syncState';
import { ConflictResolver } from './conflictResolver';
import { ConflictQueue } from './conflictQueue';
import { EventManager } from './eventManager';
import {
	SyncOperation,
	SyncDirection,
	FileState,
	OneDriveItem,
	ConflictInfo,
	LocalChange,
	LocalChangeType,
	LargeDeleteWarningHandler,
	LargeDeleteDecision,
} from '../types';
import { logger } from '../utils/logger';
import {
	normalizePath,
	toOneDrivePath,
	toVaultPath,
	getParentPath,
	stripGraphPrefix,
	shouldSyncVaultPath,
} from '../utils/pathUtils';

/**
 * Main sync engine
 */
export class SyncEngine {
	// Keep a small fixed pool so new vaults sync faster without overwhelming local I/O or OneDrive.
	// Four concurrent operations is a conservative middle ground for typical vaults and avoids bursty API usage.
	private readonly maxConcurrentOperations = 4;
	private isSharedDrive: boolean;
	private remoteRootOnDrive: string;
	private static readonly DEFAULT_IGNORE_PATTERNS: string[] = [];
	private pendingVaultFolderCreates = new Map<string, Promise<void>>();

	constructor(
		private app: App,
		private fileOps: FileOperations,
		private oneDriveClient: OneDriveClient,
		private stateManager: SyncStateManager,
		private conflictResolver: ConflictResolver,
		private eventManager: EventManager,
		private remoteRoot: string = '',
		remoteRootOnDrive?: string,
		private conflictQueue?: ConflictQueue,
		private shouldSyncPath: (path: string) => boolean = (path) => shouldSyncVaultPath(path),
		private getLargeDeleteThreshold: () => number = () => 0,
		private largeDeleteWarningHandler?: LargeDeleteWarningHandler,
		private onProgress?: (message: string | undefined) => void
	) {
		this.isSharedDrive = oneDriveClient.isSharedDrive();
		// For shared drives, delta items have paths relative to the remote drive root,
		// so we need the folder name on that drive for path stripping
		this.remoteRootOnDrive = remoteRootOnDrive || remoteRoot;
	}

	private isObsidianPath(path: string): boolean {
		return normalizePath(path).startsWith('.obsidian/');
	}

	/**
	 * Perform a sync using delta API + local dirty files
	 */
	async performSync(): Promise<void> {
		logger.info('Starting sync operation');
		const progress = (msg: string | undefined) => {
			try {
				this.onProgress?.(msg);
			} catch {
				// progress reporting must never break sync
			}
		};

		try {
			progress('starting...');

			// Inventory snapshot — surfaces drift between what the plugin thinks
			// is synced (tracked state) and what's actually in the vault. A large
			// gap is the fingerprint of silent delete drops (e.g. Graph delta
			// collapse hiding deletes that happened on another device).
			const trackedCount = this.stateManager.getTrackedPaths().length;
			const vaultCount = this.app.vault.getFiles().length;
			const drift = vaultCount - trackedCount;
			logger.info(
				`Inventory: vaultFiles=${vaultCount} trackedStates=${trackedCount} drift=${drift >= 0 ? '+' : ''}${drift}`
			);
			if (Math.abs(drift) > 10 && trackedCount > 0) {
				logger.warn(
					`Inventory drift detected: vault has ${vaultCount} files but plugin tracks ${trackedCount} (${drift >= 0 ? '+' : ''}${drift}). ` +
						`If the local total is much higher, this device may hold files that were deleted on another device but the delta API never reported the deletion.`
				);
			}

			// 1. Get local changes from event manager
			const ignoreMatchers = await this.loadIgnoreMatchers();
			const allLocalChanges = this.eventManager.getDirtyFiles();
			const ignoredLocalPaths: string[] = [];
			const localChanges = allLocalChanges.filter((change) => {
				if (this.shouldIgnorePath(change.path, ignoreMatchers)) {
					ignoredLocalPaths.push(change.path);
					return false;
				}
				return true;
			});
			if (ignoredLocalPaths.length > 0) {
				this.eventManager.removeDirtyPaths(ignoredLocalPaths);
			}
			logger.info(`Local changes: ${localChanges.length} dirty files`);
			for (const change of localChanges) {
				logger.info(
					`  Local: ${change.type} ${change.path}${change.oldPath ? ` (from ${change.oldPath})` : ''}`
				);
			}

			// 2. Get remote changes via delta API
			progress('fetching remote changes...');
			const deltaLink = this.stateManager.getDeltaLink();
			// The .obsidian stream is needed if EITHER app-settings or plugin-manifest
			// sync is enabled. Probe both representative paths so the gate doesn't
			// silently miss the syncAppSettings-only case.
			const shouldSyncObsidianScope =
				this.shouldSyncPath('.obsidian/community-plugins.json') ||
				this.shouldSyncPath('.obsidian/app.json');
			const isFirstSync = this.stateManager.isFirstSync();
			logger.info(`Delta query: isFirstSync=${isFirstSync}, hasDeltaLink=${!!deltaLink}`);
			const deltaResponse = await this.oneDriveClient.getDelta(deltaLink, this.remoteRoot);
			const obsidianDeltaLink = this.stateManager.getObsidianDeltaLink();
			if (shouldSyncObsidianScope) {
				progress('fetching .obsidian changes...');
			}
			const obsidianDeltaResponse = shouldSyncObsidianScope
				? await this.oneDriveClient.getDelta(obsidianDeltaLink, this.remoteRoot, '.obsidian')
				: undefined;

			progress('planning...');

			// Log all raw delta items for debugging
			for (const item of deltaResponse.items) {
				const vaultPath = this.remotePathToVaultPath(item);
				logger.debug(
					`  Raw delta item: name=${item.name} path=${vaultPath} isFolder=${!!item.folder} isFile=${!!item.file} deleted=${!!item.deleted} parentPath=${item.parentReference?.path || 'none'}`
				);
			}

			// Update folder tracking + expand folder-delete entries into
			// per-file deletes. Microsoft Graph sends folder deletes the same
			// way it sends file deletes — only an id, no name or parent — so
			// without this pass we have no way to know which descendants are
			// gone. Tracked folder state lets us reverse-resolve the id.
			const synthesizedDeletes: OneDriveItem[] = [];
			const deletedFolderPaths: string[] = [];
			const allDeltaItems = [
				...deltaResponse.items,
				...(obsidianDeltaResponse?.items || []),
			];
			for (const item of allDeltaItems) {
				if (!item.folder) continue;
				if (item.deleted) {
					const folderPath = item.id
						? this.stateManager.getFolderPathById(item.id)
						: undefined;
					if (!folderPath) {
						logger.warn(
							`Folder delete delta entry could not be resolved to a tracked path (id=${item.id}). ` +
								`Any descendants we knew about will remain until the next reconcile.`
						);
						continue;
					}
					const descendants = this.stateManager.getFileStatesUnderFolder(folderPath);
					logger.info(
						`Folder delete: ${folderPath} (id=${item.id}) → expanding into ${descendants.length} file deletes`
					);
					deletedFolderPaths.push(folderPath);
					for (const { path, state } of descendants) {
						synthesizedDeletes.push({
							id: state.oneDriveId || `synthesized:${path}`,
							name: undefined as unknown as string,
							deleted: { state: 'deleted' },
							file: {} as any,
							parentReference: { path: '' } as any,
							// Stash the resolved path so remotePathToVaultPath
							// short-circuits without needing to consult state.
							__resolvedVaultPath: path,
						} as unknown as OneDriveItem);
					}
					this.stateManager.removeFolderState(item.id);
				} else {
					// Record/refresh the folder so future deletes can be resolved.
					const folderPath = this.remotePathToVaultPath(item);
					if (item.id && folderPath) {
						this.stateManager.setFolderState(item.id, folderPath);
					}
				}
			}

			// Filter remote changes: split general files and .obsidian-scope files by independent delta streams,
			// applying both the built-in shouldSyncPath check and user-defined .syncIgnore patterns.
			const remoteChanges = [
				...deltaResponse.items.filter((item) => {
					if (item.folder && !item.deleted) return false;
					const vaultPath = this.remotePathToVaultPath(item);
					return (
						!this.isObsidianPath(vaultPath) &&
						this.shouldSyncPath(vaultPath) &&
						!this.shouldIgnorePath(vaultPath, ignoreMatchers)
					);
				}),
				...(obsidianDeltaResponse?.items.filter((item) => {
					if (item.folder && !item.deleted) return false;
					const vaultPath = this.remotePathToVaultPath(item);
					return (
						this.isObsidianPath(vaultPath) &&
						this.shouldSyncPath(vaultPath) &&
						!this.shouldIgnorePath(vaultPath, ignoreMatchers)
					);
				}) || []),
				...synthesizedDeletes.filter((item) => {
					const vaultPath = this.remotePathToVaultPath(item);
					return (
						this.shouldSyncPath(vaultPath) &&
						!this.shouldIgnorePath(vaultPath, ignoreMatchers)
					);
				}),
			];

			const obsidianRawCount = obsidianDeltaResponse?.items.length || 0;
			const mainDeletes = deltaResponse.items.filter((i) => i.deleted).length;
			const mainFolders = deltaResponse.items.filter((i) => !!i.folder).length;
			const obsidianDeletes = obsidianDeltaResponse?.items.filter((i) => i.deleted).length || 0;
			const remoteDeletes = remoteChanges.filter((i) => i.deleted).length;
			logger.info(
				`Delta returned ${deltaResponse.items.length + obsidianRawCount} raw items ` +
					`(main: total=${deltaResponse.items.length} deletes=${mainDeletes} folders=${mainFolders}; ` +
					`obsidian: total=${obsidianRawCount} deletes=${obsidianDeletes}); ` +
					`${synthesizedDeletes.length} synthesized from folder deletes; ` +
					`${remoteChanges.length} kept after filter (${remoteDeletes} deletes)`
			);
			for (const item of remoteChanges) {
				const vaultPath = this.remotePathToVaultPath(item);
				logger.info(
					`  Remote: ${item.deleted ? 'DELETE' : 'CHANGED'} ${vaultPath} (id=${item.id})`
				);
			}

			// 3. Plan operations
			const operations = this.planOperations(localChanges, remoteChanges, isFirstSync);

			// 3b. On first sync (or post-reset), the dirty-file queue is empty so
			// the planner only sees files via the remote delta. Local files that
			// don't exist remotely would silently be skipped. Walk the vault here
			// and add UPLOAD ops for any syncable local-only files.
			if (isFirstSync) {
				const remoteCoveredPaths = new Set<string>(operations.map((op) => op.path));
				// Any file whose state was stored during planOperations (same-size
				// short-circuit) is also "covered" — local matches remote, no work.
				for (const path of this.stateManager.getTrackedPaths()) {
					remoteCoveredPaths.add(path);
				}
				let localOnlyCount = 0;
				for (const file of this.app.vault.getFiles()) {
					const path = file.path;
					if (remoteCoveredPaths.has(path)) continue;
					if (!this.shouldSyncPath(path)) continue;
					if (this.shouldIgnorePath(path, ignoreMatchers)) continue;
					if (this.conflictQueue?.hasConflict(path)) continue;
					operations.push({ path, direction: SyncDirection.UPLOAD });
					localOnlyCount++;
				}
				if (localOnlyCount > 0) {
					logger.info(
						`First-sync local enumeration: queued ${localOnlyCount} local-only file uploads`
					);
				}
			}

			logger.info(`Sync plan: ${operations.length} operations`);
			for (const op of operations) {
				logger.info(`  Op: ${op.direction} ${op.path}`);
			}

			// Circuit breaker: if a sync would delete a large number of files,
			// pause and confirm with the user before proceeding. First syncs are
			// exempt (the reconciliation logic there doesn't issue deletes).
			if (!isFirstSync) {
				const decision = await this.maybeWarnLargeDeletes(operations);
				if (decision === 'cancel' || decision === 'disable') {
					logger.warn(
						`Sync aborted by user (${decision}) due to large delete count. ` +
							`Delta cursors not advanced; the same plan will be re-evaluated next sync.`
					);
					new Notice(
						decision === 'disable'
							? 'OneDrive sync: disabled. Investigate the deletes, then re-enable the plugin.'
							: 'OneDrive sync: cancelled. The pending deletes were not applied.'
					);
					return;
				}
			}

			if (operations.length === 0) {
				if (isFirstSync && localChanges.length === 0 && remoteChanges.length === 0) {
					logger.info(
						'First sync with no local dirty files and empty remote — nothing to do. Edit or create files, then sync again.'
					);
					new Notice('OneDrive sync: No files to sync. Edit or create files first.');
				} else {
					new Notice('OneDrive sync: Everything up to date');
				}
				// Store delta link(s) and update sync time even with no changes
				this.stateManager.setDeltaLink(deltaResponse.deltaLink);
				if (obsidianDeltaResponse) {
					this.stateManager.setObsidianDeltaLink(obsidianDeltaResponse.deltaLink);
				}
				this.stateManager.setLastSyncTime(Date.now());
				return;
			}

			// 4. Execute operations
			let completed = 0;
			const downloadedPaths: string[] = [];
			const conflictedPaths: string[] = [];
			progress(`0/${operations.length} files`);
			// Single persistent notice for progress — updates in place
			const progressNotice =
				operations.length >= 5 ? new Notice(`Syncing: 0/${operations.length} files...`, 0) : null;
			await this.executeOperations(operations, (operation) => {
				completed++;

				if (operation.direction === SyncDirection.DOWNLOAD) {
					downloadedPaths.push(operation.path);
				}
				if (operation.direction === SyncDirection.CONFLICT) {
					conflictedPaths.push(operation.path);
				}

				const progressLabel = `${completed}/${operations.length} files`;
				progress(progressLabel);
				if (progressNotice) {
					progressNotice.setMessage(`Syncing: ${progressLabel}...`);
				}
			});
			// Dismiss progress notice
			progressNotice?.hide();
			progress(undefined);

			// Prune folders we just emptied via folder-delete expansion. Without
			// this the per-file deletes leave empty husk folders on disk.
			if (deletedFolderPaths.length > 0) {
				await this.pruneEmptyFolders(deletedFolderPaths);
			}

			// Clear any dirty-file entries for paths we just downloaded,
			// so they don't boomerang back as uploads on the next cycle
			if (downloadedPaths.length > 0) {
				this.eventManager.removeDirtyPaths(downloadedPaths);
			}

			// 5. Store new delta link(s) and update sync time
			this.stateManager.setDeltaLink(deltaResponse.deltaLink);
			if (obsidianDeltaResponse) {
				this.stateManager.setObsidianDeltaLink(obsidianDeltaResponse.deltaLink);
			}
			this.stateManager.setLastSyncTime(Date.now());

			// Clear dirty files only after successful sync,
			// but preserve conflicted paths so they stay dirty
			this.eventManager.clearDirtyFiles();
			for (const path of conflictedPaths) {
				this.eventManager.addDirtyFile(path, 'modify');
			}

			logger.info('Sync completed successfully');

			const syncedCount = completed - conflictedPaths.length;
			if (conflictedPaths.length > 0) {
				new Notice(
					`OneDrive sync: ${syncedCount} file${syncedCount === 1 ? '' : 's'} synced, ` +
						`${conflictedPaths.length} conflict${conflictedPaths.length === 1 ? '' : 's'} need resolution`
				);
			} else {
				new Notice(`OneDrive sync: ${syncedCount} file${syncedCount === 1 ? '' : 's'} synced`);
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : 'Unknown error';
			logger.error(`Sync failed: ${errorMsg}`, error);
			new Notice(`OneDrive sync failed: ${errorMsg}`);
			throw error;
		}
	}

	/**
	 * Classify operations and, if the planned deletes exceed the configured
	 * threshold, ask the user (via the injected handler) whether to proceed.
	 *
	 * Returns:
	 *   - 'proceed': run the sync as planned (default when no handler, no
	 *                threshold, or counts under the threshold).
	 *   - 'cancel':  abort this sync, do not advance delta cursors so the same
	 *                pending operations are re-planned next sync.
	 *   - 'disable': same as cancel; caller has also been asked to disable the
	 *                plugin via the handler.
	 */
	private async maybeWarnLargeDeletes(
		operations: SyncOperation[]
	): Promise<LargeDeleteDecision> {
		const threshold = Math.max(0, Math.floor(this.getLargeDeleteThreshold() || 0));
		if (threshold <= 0 || !this.largeDeleteWarningHandler) return 'proceed';

		const localDeletes: string[] = []; // remote-driven local deletes (data-loss risk)
		const remoteDeletes: string[] = []; // local-driven remote deletes
		for (const op of operations) {
			if (
				op.direction === SyncDirection.DOWNLOAD &&
				op.remoteState === undefined
			) {
				localDeletes.push(op.path);
			} else if (
				op.direction === SyncDirection.UPLOAD &&
				op.localState === undefined &&
				op.remoteState !== undefined
			) {
				remoteDeletes.push(op.path);
			}
		}

		const total = localDeletes.length + remoteDeletes.length;
		if (total < threshold) return 'proceed';

		logger.warn(
			`Large delete detected: ${localDeletes.length} local + ${remoteDeletes.length} remote ` +
				`(threshold ${threshold}). Asking user before proceeding.`
		);

		try {
			return await this.largeDeleteWarningHandler({
				localDeleteCount: localDeletes.length,
				remoteDeleteCount: remoteDeletes.length,
				threshold,
				sampleLocalDeletes: localDeletes.slice(0, 10),
				sampleRemoteDeletes: remoteDeletes.slice(0, 10),
			});
		} catch (err) {
			logger.error(
				`Large-delete warning handler threw; cancelling sync as a safety default: ${(err as Error)?.message || err}`
			);
			return 'cancel';
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

		// Process local changes
		for (const change of localChanges) {
			// Skip paths with pending conflicts — don't re-process until user resolves
			if (this.conflictQueue?.hasConflict(change.path)) {
				logger.debug(`Skipping ${change.path} — pending conflict`);
				remoteByPath.delete(change.path);
				continue;
			}

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
						localState: knownState,
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

			// Skip paths with pending conflicts
			if (this.conflictQueue?.hasConflict(vaultPath)) {
				logger.debug(`Skipping remote change for ${vaultPath} — pending conflict`);
				continue;
			}

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
			} else if (operation.direction === SyncDirection.CONFLICT) {
				await this.queueConflict(operation);
			}
		} catch (error) {
			logger.error(`Failed to execute operation for ${operation.path}:`, error);
			throw error;
		}
	}

	/**
	 * Execute sync operations with limited parallelism.
	 * Calls onComplete after each operation finishes successfully.
	 */
	private async executeOperations(
		operations: SyncOperation[],
		onComplete: (operation: SyncOperation) => void
	): Promise<void> {
		const parallelCount = Math.min(this.maxConcurrentOperations, operations.length);
		let nextIndex = 0;

		await Promise.all(
			Array.from({ length: parallelCount }, async () => {
				while (nextIndex < operations.length) {
					const operation = operations[nextIndex++];
					await this.executeOperation(operation);
					onComplete(operation);
				}
			})
		);
	}

	/**
	 * Queue a conflict for manual resolution.
	 * Snapshots both local and remote content.
	 */
	private async queueConflict(operation: SyncOperation): Promise<void> {
		if (!this.conflictQueue) {
			logger.warn(`No conflict queue available, skipping conflict for ${operation.path}`);
			return;
		}

		const file = this.app.vault.getAbstractFileByPath(operation.path);
		if (!(file instanceof TFile)) {
			logger.warn(`Local file not found for conflict: ${operation.path}`);
			return;
		}

		if (!operation.remoteState?.oneDriveId) {
			logger.warn(`No remote ID for conflict: ${operation.path}`);
			return;
		}

		// Snapshot both versions
		const localContent = await this.app.vault.readBinary(file);
		const remoteContent = await this.fileOps.downloadFile(operation.remoteState.oneDriveId);

		await this.conflictQueue.add(
			operation.path,
			localContent,
			remoteContent,
			file.stat.mtime,
			operation.remoteState.remoteModifiedTime,
			operation.remoteState.oneDriveId,
			operation.remoteState.remoteHash
		);
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

		const pendingCreate = this.pendingVaultFolderCreates.get(parentPath);
		if (pendingCreate) {
			await pendingCreate;
			return;
		}

		const adapter = this.app.vault.adapter;
		const createPromise = (async () => {
			if (await adapter.exists(parentPath)) return;

			try {
				await adapter.mkdir(parentPath);
			} catch (error) {
				if (!(await adapter.exists(parentPath))) {
					throw error;
				}
			}
		})();

		this.pendingVaultFolderCreates.set(parentPath, createPromise);
		try {
			await createPromise;
		} finally {
			this.pendingVaultFolderCreates.delete(parentPath);
		}
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
			await this.ensureVaultFolders(operation.path);
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
	 * Delete folders that became empty after their descendants were removed by
	 * folder-delete expansion. Walks deepest-first and cascades up: when a
	 * folder is removed, its parent is reconsidered (it too may now be empty).
	 *
	 * Only deletes folders that are actually empty — if the user has unrelated
	 * files in there (e.g. local-only, never synced), the folder is left alone.
	 */
	private async pruneEmptyFolders(folderPaths: string[]): Promise<void> {
		// Dedupe and sort deepest-first so children are pruned before parents.
		const candidates = new Set<string>(folderPaths);
		const sorted = Array.from(candidates).sort(
			(a, b) => b.split('/').length - a.split('/').length
		);

		for (const path of sorted) {
			await this.tryRemoveFolderAndAncestors(path);
		}
	}

	private async tryRemoveFolderAndAncestors(folderPath: string): Promise<void> {
		let current: string | null = folderPath;
		while (current && current !== '' && current !== '/') {
			const folder = this.app.vault.getAbstractFileByPath(current);
			if (!folder) return;
			// Only TFolder has `children`. Bail if this is a file or untyped.
			const children = (folder as unknown as { children?: unknown[] }).children;
			if (!Array.isArray(children)) return;
			if (children.length > 0) return;
			try {
				await this.app.vault.delete(folder);
				logger.debug(`Pruned empty folder ${current}`);
			} catch (error) {
				logger.warn(`Failed to prune empty folder ${current}:`, error);
				return;
			}
			const slash = current.lastIndexOf('/');
			current = slash > 0 ? current.slice(0, slash) : null;
		}
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
		// Short-circuit for synthesized items where we already know the path
		// (used by folder-delete expansion to avoid an unnecessary state lookup
		// per child).
		const stashed = (item as unknown as { __resolvedVaultPath?: string }).__resolvedVaultPath;
		if (stashed) return stashed;

		let fullPath: string;
		if (item.parentReference?.path && item.name) {
			fullPath = `${item.parentReference.path}/${item.name}`;
		} else if (item.name) {
			fullPath = item.name;
		} else {
			// Microsoft Graph delta emits deleted items with only `id` set —
			// no name, no parentReference. Reverse-resolve via tracked state
			// so deletes from other devices actually land on this one. If the
			// id isn't in state (e.g. file was never synced through this
			// device), we have to give up: returning '' keeps existing
			// callers safe.
			if (item.id) {
				const trackedPath = this.stateManager.getPathByOneDriveId(item.id);
				if (trackedPath) return trackedPath;
			}
			return '';
		}

		// Strip OneDrive API prefixes
		fullPath = stripGraphPrefix(fullPath);

		return toVaultPath(fullPath, this.remoteRootOnDrive);
	}

	private async loadIgnoreMatchers(): Promise<RegExp[]> {
		const patterns = [...SyncEngine.DEFAULT_IGNORE_PATTERNS];

		try {
			const content = await this.app.vault.adapter.read('.syncIgnore');
			if (typeof content === 'string' && content.trim().length > 0) {
				patterns.push(...this.parseSyncIgnorePatterns(content));
			}
		} catch {
			// Ignore missing or unreadable .syncIgnore files
		}

		return patterns.map((pattern) => this.patternToRegex(pattern));
	}

	private parseSyncIgnorePatterns(content: string): string[] {
		return content
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'))
			.map((line) => line.replace(/^\.\//, '').replace(/^\/+/, ''));
	}

	private patternToRegex(pattern: string): RegExp {
		let normalizedPattern = normalizePath(pattern);
		if (normalizedPattern.endsWith('/')) {
			normalizedPattern = `${normalizedPattern}**`;
		}

		const wildcardToken = '__DOUBLE_STAR__';
		const hasPathSeparator = normalizedPattern.includes('/');
		let regexPattern = normalizedPattern.replace(/\*\*/g, wildcardToken);
		regexPattern = regexPattern.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
		regexPattern = regexPattern.replace(/\*/g, '[^/]*');
		regexPattern = regexPattern.replace(new RegExp(wildcardToken, 'g'), '.*');

		if (hasPathSeparator) {
			return new RegExp(`^${regexPattern}$`);
		}

		return new RegExp(`(^|/)${regexPattern}$`);
	}

	private shouldIgnorePath(path: string, ignoreMatchers: RegExp[]): boolean {
		if (!path) return false;
		const normalizedPath = normalizePath(path).replace(/^\/+/, '');
		return ignoreMatchers.some((matcher) => matcher.test(normalizedPath));
	}
}
