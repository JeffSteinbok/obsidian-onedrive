/**
 * Main sync engine
 * Uses OneDrive delta API for remote changes and vault events for local changes
 */

import { App, Notice, TFile, TFolder } from 'obsidian';
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
	DeltaResponse,
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

/** Progress callback — pass undefined to clear the status bar message. */
type ProgressFn = (message: string | undefined) => void;

/** Returned by gatherLocalChanges: filtered dirty files and the count of ignored paths. */
interface LocalChangesResult {
	localChanges: LocalChange[];
	ignoredCount: number;
}

/**
 * Returned by expandFolderDeletes: synthetic per-file delete items derived
 * from Graph folder-delete entries, plus the folder paths that were deleted.
 */
interface ExpandedFolderDeletesResult {
	synthesizedDeletes: OneDriveItem[];
	deletedFolderPaths: string[];
}

/**
 * Returned by fetchAndFilterRemoteChanges: the fully filtered set of remote
 * changes ready for planning, plus the raw delta responses (needed to store
 * delta links after sync) and any deleted folder paths for later pruning.
 */
interface RemoteChangesResult {
	remoteChanges: OneDriveItem[];
	deltaResponse: DeltaResponse;
	obsidianDeltaResponse?: DeltaResponse;
	deletedFolderPaths: string[];
}

/**
 * Returned by executeSyncOperations: counts of completed operations and
 * the paths that were downloaded or ended in conflict (needed for post-sync
 * dirty-file cleanup).
 */
interface SyncExecutionResult {
	completed: number;
	downloadedPaths: string[];
	conflictedPaths: string[];
}

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
		private configDir: string,
		private remoteRoot: string = '',
		remoteRootOnDrive?: string,
		private conflictQueue?: ConflictQueue,
		private shouldSyncPath: (path: string) => boolean = (path) => shouldSyncVaultPath(path, false, false, configDir),
		private getLargeDeleteThreshold: () => number = () => 0,
		private largeDeleteWarningHandler?: LargeDeleteWarningHandler,
		private onProgress?: (message: string | undefined) => void,
	) {
		this.isSharedDrive = oneDriveClient.isSharedDrive();
		// For shared drives, delta items have paths relative to the remote drive root,
		// so we need the folder name on that drive for path stripping
		this.remoteRootOnDrive = remoteRootOnDrive || remoteRoot;
	}

	private isObsidianPath(path: string): boolean {
		return normalizePath(path).startsWith(`${normalizePath(this.configDir).replace(/\/+$/g, '')}/`);
	}

	/**
	 * Perform a sync using delta API + local dirty files.
	 *
	 * Orchestrates five phases:
	 *   1. Gather local dirty files (gatherLocalChanges)
	 *   2. Fetch + filter remote delta changes (fetchAndFilterRemoteChanges)
	 *   3. Plan operations by diffing local vs remote (planOperations)
	 *   4. Execute uploads / downloads / deletes (executeSyncOperations)
	 *   5. Finalize — store delta cursors, clear dirty queue, notify user
	 */
	async performSync(): Promise<void> {
		logger.info('Starting sync operation');
		const progress: ProgressFn = (msg) => {
			try {
				this.onProgress?.(msg);
			} catch {
				// progress reporting must never break sync
			}
		};

		try {
			progress('starting...');

			// Phase 0: Log inventory drift (tracked state vs actual vault files)
			this.logInventoryDrift();

			// Phase 1: Collect local dirty files, filtering out .syncIgnore matches
			const ignoreMatchers = await this.loadIgnoreMatchers();
			const isFirstSync = this.stateManager.isFirstSync();
			const { localChanges } = this.gatherLocalChanges(ignoreMatchers);

			// Phase 2: Fetch remote delta changes from OneDrive, expand folder
			// deletes into per-file deletes, and filter by sync scope
			const {
				remoteChanges,
				deltaResponse,
				obsidianDeltaResponse,
				deletedFolderPaths,
			} = await this.fetchAndFilterRemoteChanges(ignoreMatchers, progress);

			// Phase 3: Diff local vs remote to produce upload/download/conflict ops
			const operations = this.planOperations(localChanges, remoteChanges, isFirstSync);

			// On first sync the dirty queue is empty, so walk the vault and add
			// uploads for any local-only files not already covered by the delta
			if (isFirstSync) {
				this.addFirstSyncUploads(operations, ignoreMatchers);
			}

			logger.info(`Sync plan: ${operations.length} operations`);
			for (const op of operations) {
				logger.info(`  Op: ${op.direction} ${op.path}`);
			}

			// Circuit breaker: if a non-first sync would delete a large number
			// of files, pause and ask the user before proceeding
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
				this.stateManager.setDeltaLink(deltaResponse.deltaLink);
				if (obsidianDeltaResponse) {
					this.stateManager.setObsidianDeltaLink(obsidianDeltaResponse.deltaLink);
				}
				this.stateManager.setLastSyncTime(Date.now());
				return;
			}

			// Phase 4: Execute all planned sync operations with progress tracking
			const { completed, downloadedPaths, conflictedPaths } = await this.executeSyncOperations(
				operations,
				progress
			);

			// Clean up empty folders left behind by folder-delete expansion
			if (deletedFolderPaths.length > 0) {
				await this.pruneEmptyFolders(deletedFolderPaths);
			}

			// Phase 5: Finalize — store delta cursors so next sync starts where
			// this one left off, clear the dirty queue, re-mark conflicts
			if (downloadedPaths.length > 0) {
				this.eventManager.removeDirtyPaths(downloadedPaths);
			}

			this.stateManager.setDeltaLink(deltaResponse.deltaLink);
			if (obsidianDeltaResponse) {
				this.stateManager.setObsidianDeltaLink(obsidianDeltaResponse.deltaLink);
			}
			this.stateManager.setLastSyncTime(Date.now());

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
	 * Log inventory drift between tracked state and actual vault files.
	 * A large gap hints at silent delete drops — e.g. Graph delta collapse
	 * hiding deletes that happened on another device.
	 */
	private logInventoryDrift(): void {
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
	}

	/**
	 * Collect local dirty files from the event manager, filtering out any
	 * that match .syncIgnore patterns. Ignored paths are removed from the
	 * dirty queue so they don't reappear on the next sync cycle.
	 */
	private gatherLocalChanges(ignoreMatchers: RegExp[]): LocalChangesResult {
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
		return {
			localChanges,
			ignoredCount: ignoredLocalPaths.length,
		};
	}

	/**
	 * Fetch remote changes via the OneDrive delta API (two streams: general
	 * files and .obsidian-scope files), expand folder deletes into per-file
	 * synthetic deletes, and filter by sync scope + .syncIgnore patterns.
	 *
	 * Returns the filtered remote changes plus the raw delta responses
	 * (needed later to store delta cursors) and deleted folder paths
	 * (needed later to prune empty local folders).
	 */
	private async fetchAndFilterRemoteChanges(
		ignoreMatchers: RegExp[],
		progress: ProgressFn
	): Promise<RemoteChangesResult> {
		progress('fetching remote changes...');
		const deltaLink = this.stateManager.getDeltaLink();
		const shouldSyncObsidianScope =
			this.shouldSyncPath(`${this.configDir}/community-plugins.json`) ||
			this.shouldSyncPath(`${this.configDir}/app.json`);
		const isFirstSync = this.stateManager.isFirstSync();
		logger.info(`Delta query: isFirstSync=${isFirstSync}, hasDeltaLink=${!!deltaLink}`);
		const deltaResponse = await this.oneDriveClient.getDelta(deltaLink, this.remoteRoot);
		const obsidianDeltaLink = this.stateManager.getObsidianDeltaLink();
		if (shouldSyncObsidianScope) {
			progress('fetching .obsidian changes...');
		}
		const obsidianDeltaResponse = shouldSyncObsidianScope
			? await this.oneDriveClient.getDelta(obsidianDeltaLink, this.remoteRoot, this.configDir)
			: undefined;

		progress('planning...');

		for (const item of deltaResponse.items) {
			const vaultPath = this.remotePathToVaultPath(item);
			logger.debug(
				`  Raw delta item: name=${item.name} path=${vaultPath} isFolder=${!!item.folder} isFile=${!!item.file} deleted=${!!item.deleted} parentPath=${item.parentReference?.path || 'none'}`
			);
		}

		const { synthesizedDeletes, deletedFolderPaths } = this.expandFolderDeletes([
			...deltaResponse.items,
			...(obsidianDeltaResponse?.items || []),
		]);
		const remoteChanges = this.filterDeltaItems(
			deltaResponse.items,
			obsidianDeltaResponse?.items || [],
			synthesizedDeletes,
			ignoreMatchers
		);

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
			logger.info(`  Remote: ${item.deleted ? 'DELETE' : 'CHANGED'} ${vaultPath} (id=${item.id})`);
		}

		return {
			remoteChanges,
			deltaResponse,
			obsidianDeltaResponse,
			deletedFolderPaths,
		};
	}

	/**
	 * Expand folder-delete delta entries into per-file synthetic deletes.
	 *
	 * Microsoft Graph sends folder deletes the same way it sends file
	 * deletes — only an id, no name or parent — so without this pass we
	 * have no way to know which descendants are gone. Tracked folder state
	 * lets us reverse-resolve the id back to a path and enumerate children.
	 */
	private expandFolderDeletes(allDeltaItems: OneDriveItem[]): ExpandedFolderDeletesResult {
		const synthesizedDeletes: OneDriveItem[] = [];
		const deletedFolderPaths: string[] = [];

		for (const item of allDeltaItems) {
			if (!item.folder) continue;
			if (item.deleted) {
				const folderPath = item.id ? this.stateManager.getFolderPathById(item.id) : undefined;
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
						name: '',
						deleted: { state: 'deleted' },
						file: { mimeType: '' },
						parentReference: { id: '', path: '' },
						lastModifiedDateTime: '',
						createdDateTime: '',
						__resolvedVaultPath: path,
					});
				}
				this.stateManager.removeFolderState(item.id);
			} else {
				const folderPath = this.remotePathToVaultPath(item);
				if (item.id && folderPath) {
					this.stateManager.setFolderState(item.id, folderPath);
				}
			}
		}

		return { synthesizedDeletes, deletedFolderPaths };
	}

	/**
	 * Filter raw delta items into the final set of remote changes.
	 *
	 * Splits general files and .obsidian-scope files by their independent
	 * delta streams, applying both the built-in shouldSyncPath check and
	 * user-defined .syncIgnore patterns. Folder items (non-deleted) are
	 * excluded — only files and deleted items pass through.
	 */
	private filterDeltaItems(
		items: OneDriveItem[],
		obsidianItems: OneDriveItem[],
		synthesizedDeletes: OneDriveItem[],
		ignoreMatchers: RegExp[]
	): OneDriveItem[] {
		return [
			...items.filter((item) => {
				if (item.folder && !item.deleted) return false;
				const vaultPath = this.remotePathToVaultPath(item);
				return (
					!this.isObsidianPath(vaultPath) &&
					this.shouldSyncPath(vaultPath) &&
					!this.shouldIgnorePath(vaultPath, ignoreMatchers)
				);
			}),
			...obsidianItems.filter((item) => {
				if (item.folder && !item.deleted) return false;
				const vaultPath = this.remotePathToVaultPath(item);
				return (
					this.isObsidianPath(vaultPath) &&
					this.shouldSyncPath(vaultPath) &&
					!this.shouldIgnorePath(vaultPath, ignoreMatchers)
				);
			}),
			...synthesizedDeletes.filter((item) => {
				const vaultPath = this.remotePathToVaultPath(item);
				return (
					this.shouldSyncPath(vaultPath) &&
					!this.shouldIgnorePath(vaultPath, ignoreMatchers)
				);
			}),
		];
	}

	/**
	 * On first sync (or post-reset), the dirty-file queue is empty so the
	 * planner only sees files via the remote delta. Local files that don't
	 * exist remotely would silently be skipped. Walk the vault and add
	 * UPLOAD ops for any syncable local-only files not already covered by
	 * the delta or tracked state.
	 *
	 * @returns The number of local-only uploads added.
	 */
	private addFirstSyncUploads(operations: SyncOperation[], ignoreMatchers: RegExp[]): number {
		const remoteCoveredPaths = new Set<string>(operations.map((op) => op.path));
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
			logger.info(`First-sync local enumeration: queued ${localOnlyCount} local-only file uploads`);
		}
		return localOnlyCount;
	}

	/**
	 * Execute all planned sync operations (uploads, downloads, deletes)
	 * with progress tracking. Shows a persistent Notice for batches of
	 * 5+ operations that updates in-place as each operation completes.
	 */
	private async executeSyncOperations(
		operations: SyncOperation[],
		progress: ProgressFn
	): Promise<SyncExecutionResult> {
		let completed = 0;
		const downloadedPaths: string[] = [];
		const conflictedPaths: string[] = [];
		progress(`0/${operations.length} files`);
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
		progressNotice?.hide();
		progress(undefined);
		return {
			completed,
			downloadedPaths,
			conflictedPaths,
		};
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
				await this.app.fileManager.trashFile(file);
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

	/**
	 * Sweep the entire vault for empty folders and prune them, deepest-first
	 * so cascades collapse in one pass. Skips folders whose path is in
	 * `keepPaths` — those exist on cloud and the user wants them preserved.
	 * Returns the number of folders actually deleted.
	 */
	private async pruneAllEmptyFolders(keepPaths: Set<string>): Promise<number> {
		const root = this.app.vault.getRoot();
		const allFolders: TFolder[] = [];
		const walk = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					allFolders.push(child);
					walk(child);
				}
			}
		};
		walk(root);
		allFolders.sort((a, b) => b.path.split('/').length - a.path.split('/').length);

		let deleted = 0;
		for (const folder of allFolders) {
			if (folder.children.length > 0) continue;
			if (keepPaths.has(folder.path)) continue;
			// Skip anything we don't sync — including the log folder, our own
			// plugin folder, and .obsidian (unless explicitly synced). Those
			// are device-local and must not be pruned by reconcile.
			if (!this.shouldSyncPath(folder.path)) continue;
			try {
				await this.app.fileManager.trashFile(folder);
				deleted++;
				logger.debug(`Reconcile: pruned empty folder ${folder.path}`);
			} catch (error) {
				logger.warn(`Reconcile: failed to prune empty folder ${folder.path}:`, error);
			}
		}
		return deleted;
	}

	private async tryRemoveFolderAndAncestors(folderPath: string): Promise<void> {
		let current: string | null = folderPath;
		while (current && current !== '' && current !== '/') {
			const folder = this.app.vault.getAbstractFileByPath(current);
			if (!folder) return;
			if (!(folder instanceof TFolder)) return;
			if (folder.children.length > 0) return;
			try {
				await this.app.fileManager.trashFile(folder);
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
		const stashed = item.__resolvedVaultPath;
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

	/**
	 * Reconcile the local vault from a full cloud listing. Treats cloud as
	 * authoritative: any local file not present in cloud is deleted; any
	 * cloud file not present locally is downloaded; size mismatches are
	 * downloaded too. Use this to recover from delta collapse, files that
	 * predate plugin installation, or any drift that Reset Sync Token
	 * can't fix (Reset is upload-biased — it re-uploads local-only files).
	 *
	 * Destructive deletes are gated by the same large-delete confirmation
	 * modal used by normal sync.
	 */
	async reconcileFromCloud(): Promise<void> {
		logger.info('Starting reconcile-from-cloud operation');
		const progress = (msg: string | undefined) => {
			try {
				this.onProgress?.(msg);
			} catch {
				// progress reporting must never break sync
			}
		};

		try {
			progress('listing cloud...');
			new Notice('Reconcile from cloud: listing OneDrive...', 6000);
			const ignoreMatchers = await this.loadIgnoreMatchers();

			// 1. Enumerate the entire remote vault. listAllItems recurses
			// /children — it returns files AND folders. We only want files
			// for diffing.
			const allRemoteItems = await this.oneDriveClient.listAllItems(this.remoteRoot);
			logger.info(`Reconcile: enumerated ${allRemoteItems.length} remote items`);

			// 2. Build vaultPath -> OneDriveItem map for everything we'd sync,
			// plus a set of folder paths that exist on cloud so we don't
			// prune local empty folders the user intentionally created on
			// another device.
			const remoteFiles = new Map<string, OneDriveItem>();
			const remoteFolders = new Set<string>();
			for (const item of allRemoteItems) {
				const vaultPath = this.remotePathToVaultPath(item);
				if (!vaultPath) continue;
				if (item.folder) {
					remoteFolders.add(vaultPath);
					continue;
				}
				if (!this.shouldSyncPath(vaultPath)) continue;
				if (this.shouldIgnorePath(vaultPath, ignoreMatchers)) continue;
				remoteFiles.set(vaultPath, item);
			}

			// 3. Snapshot local files we'd sync.
			const localFiles = this.app.vault
				.getFiles()
				.filter((f) => this.shouldSyncPath(f.path))
				.filter((f) => !this.shouldIgnorePath(f.path, ignoreMatchers));
			const localByPath = new Map<string, TFile>(localFiles.map((f) => [f.path, f]));

			// 4. Plan operations.
			const operations: SyncOperation[] = [];
			const localOnly: string[] = [];
			const remoteOnly: string[] = [];
			const sizeMismatch: string[] = [];

			for (const local of localFiles) {
				if (!remoteFiles.has(local.path)) {
					localOnly.push(local.path);
					// Encoded as a remote→local delete (download direction, no remoteState).
					operations.push({
						path: local.path,
						direction: SyncDirection.DOWNLOAD,
						remoteState: undefined,
					});
				}
			}

			for (const [path, item] of remoteFiles) {
				const local = localByPath.get(path);
				if (!local) {
					remoteOnly.push(path);
					operations.push({
						path,
						direction: SyncDirection.DOWNLOAD,
						remoteState: this.itemToFileState(item),
					});
				} else {
					const remoteSize = item.size || 0;
					if (local.stat.size !== remoteSize) {
						sizeMismatch.push(path);
						operations.push({
							path,
							direction: SyncDirection.DOWNLOAD,
							remoteState: this.itemToFileState(item),
						});
					} else {
						// Same size — assume same content, just refresh tracked state.
						this.stateManager.setFileState(path, this.itemToFileState(item));
					}
				}
			}

			logger.info(
				`Reconcile plan: ${operations.length} operations ` +
					`(localOnly=${localOnly.length} deletes, remoteOnly=${remoteOnly.length} downloads, sizeMismatch=${sizeMismatch.length} re-downloads)`
			);

			// 5. Large-delete confirmation for the destructive side.
			const threshold = this.getLargeDeleteThreshold();
			if (
				threshold > 0 &&
				localOnly.length >= threshold &&
				this.largeDeleteWarningHandler
			) {
				logger.warn(
					`Reconcile would delete ${localOnly.length} local files (threshold ${threshold}). Asking user.`
				);
				const decision = await this.largeDeleteWarningHandler({
					localDeleteCount: localOnly.length,
					remoteDeleteCount: 0,
					threshold,
					sampleLocalDeletes: localOnly.slice(0, 10),
					sampleRemoteDeletes: [],
				});
				if (decision !== 'proceed') {
					logger.info(`Reconcile cancelled by user (${operations.length} ops aborted)`);
					new Notice('Reconcile from cloud cancelled.');
					return;
				}
			}

			if (operations.length === 0) {
				logger.info('Reconcile: nothing to do — local already matches cloud');
				const pruned = await this.pruneAllEmptyFolders(remoteFolders);
				new Notice(
					pruned > 0
						? `Reconcile from cloud: already in sync. Pruned ${pruned} empty folder${pruned === 1 ? '' : 's'}.`
						: 'Reconcile from cloud: already in sync.'
				);
				return;
			}

			// 6. Execute.
			let completed = 0;
			progress(`0/${operations.length} files`);
			const progressNotice = new Notice(
				`Reconciling: 0/${operations.length} files...`,
				0
			);
			await this.executeOperations(operations, () => {
				completed++;
				const label = `${completed}/${operations.length} files`;
				progress(label);
				progressNotice.setMessage(`Reconciling: ${label}...`);
			});
			progressNotice.hide();
			progress(undefined);

			// 7. Local file event listeners may have queued dirty entries while
			// we were downloading. Clear them — we just authoritatively synced
			// from cloud, anything pending is stale.
			this.eventManager.clearDirtyFiles();

			// 7a. Sweep the entire vault for empty folders and prune them,
			// EXCEPT those that exist on cloud — those were intentionally
			// created on another device and we should keep them locally.
			const prunedCount = await this.pruneAllEmptyFolders(remoteFolders);
			if (prunedCount > 0) {
				logger.info(`Reconcile: pruned ${prunedCount} empty folder(s)`);
			}

			// 8. Advance delta cursors so the next normal sync starts clean.
			progress('advancing delta cursor...');
			try {
				const newDelta = await this.oneDriveClient.getDelta(undefined, this.remoteRoot);
				this.stateManager.setDeltaLink(newDelta.deltaLink);
				const shouldSyncObsidianScope =
					this.shouldSyncPath(`${this.configDir}/community-plugins.json`) ||
					this.shouldSyncPath(`${this.configDir}/app.json`);
				if (shouldSyncObsidianScope) {
					const newObs = await this.oneDriveClient.getDelta(
						undefined,
						this.remoteRoot,
						this.configDir
					);
					this.stateManager.setObsidianDeltaLink(newObs.deltaLink);
				}
			} catch (error) {
				logger.warn(
					'Reconcile: failed to advance delta cursor; next sync will re-enumerate via delta:',
					error
				);
			}

			this.stateManager.setLastSyncTime(Date.now());
			logger.info(`Reconcile from cloud complete: ${operations.length} operations executed`);
			new Notice(
				`Reconcile from cloud complete: ${remoteOnly.length} downloaded, ${localOnly.length} deleted, ${sizeMismatch.length} refreshed.`
			);
		} catch (error) {
			logger.error('Reconcile from cloud failed:', error);
			new Notice(`Reconcile from cloud failed: ${error}`);
			throw error;
		}
	}
}
