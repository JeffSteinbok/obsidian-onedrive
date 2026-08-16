/**
 * Sync Engine - Core synchronization logic for OneDrive ↔ Obsidian vault
 *
 * This is the heart of the plugin, orchestrating bidirectional sync between
 * the local Obsidian vault and OneDrive cloud storage.
 *
 * ## Sync Flow Overview
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                         performSync() Entry Point                       │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │                                                                         │
 * │  1. gatherLocalChanges()     ──→  Collect dirty files from EventManager │
 * │                                   + detect .obsidian config changes     │
 * │                                                                         │
 * │  2. fetchAndFilterRemoteChanges() ──→  OneDrive Delta API               │
 * │                                        (incremental change tracking)    │
 * │                                                                         │
 * │  3. planOperations()         ──→  Diff local vs remote, decide:         │
 * │                                   • UPLOAD (local → cloud)              │
 * │                                   • DOWNLOAD (cloud → local)            │
 * │                                   • CONFLICT (needs resolution)         │
 * │                                                                         │
 * │  4. executeSyncOperations()  ──→  Parallel upload/download with         │
 * │                                   concurrency limit                     │
 * │                                                                         │
 * │  5. Finalize                 ──→  Store delta cursors, clear dirty      │
 * │                                   queue, update sync state              │
 * │                                                                         │
 * └─────────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Key Concepts
 *
 * - **Delta API**: OneDrive provides incremental change tracking via delta tokens.
 *   We store the cursor after each sync to only fetch changes since last sync.
 *
 * - **Dirty Files**: Local changes are tracked by EventManager via vault events.
 *   Config files (.obsidian/) are detected by mtime/hash comparison since they
 *   don't fire standard vault events.
 *
 * - **Conflict Resolution**: When both local and remote changed, we use the
 *   configured strategy (last-write-wins, create-duplicate, or manual queue).
 *
 * - **Large Delete Protection**: If delta shows many deletes, we prompt user
 *   to confirm before applying (prevents accidental data loss).
 *
 * - **Pull-Only Mode**: Experimental mode that skips local change detection,
 *   only downloading remote changes (for read-only vaults).
 *
 * @see EventManager for local change tracking
 * @see OneDriveClient for Graph API operations
 * @see ConflictResolver for conflict handling strategies
 */

import { App, Notice, TFile, TFolder } from 'obsidian';
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
	LargeDeleteWarningHandler,
	LargeDeleteDecision,
	DeltaResponse,
	SyncEngineOptions,
	SyncEngineConflictQueue,
	NotificationLevel,
} from '../types';
import { logger } from '../utils/logger';
import { isDeferrableError } from '../utils/errors';
import { sha1HexUpper } from '../utils/contentHash';
import {
	normalizePath,
	toOneDrivePath,
	toVaultPath,
	getParentPath,
	stripGraphPrefix,
	shouldSyncVaultPath,
	getAllSyncableConfigPaths,
} from '../utils/pathUtils';
import { ProgressNotice } from '../ui/progressNotice';
import { t } from '../i18n';

/**
 * FNV-1a 32-bit hash of binary content, returned as hex string.
 * Used to detect whether config file content actually changed
 * vs Obsidian just touching the file on startup.
 */
function hashContent(data: Uint8Array): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < data.length; i++) {
		hash ^= data[i];
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Progress callback — pass undefined to clear the status bar message. */
type ProgressFn = (message: string | undefined) => void;
type OperationFailureProgressFn = () => void;

/** Returned by gatherLocalChanges: filtered dirty files, folder changes, and the count of ignored paths. */
interface LocalChangesResult {
	localChanges: LocalChange[];
	folderChanges: LocalChange[];
	ignoredCount: number;
}

/**
 * A folder that was moved/renamed on the remote (another device or the web
 * UI) and needs its local counterpart relocated to match.
 */
interface RemoteFolderMove {
	oldPath: string;
	newPath: string;
}

/**
 * Returned by expandFolderDeletes: synthetic per-file delete items derived
 * from Graph folder-delete entries, plus the folder paths that were deleted,
 * plus any folder moves/renames detected on the remote.
 */
interface ExpandedFolderDeletesResult {
	synthesizedDeletes: OneDriveItem[];
	deletedFolderPaths: string[];
	folderMoves: RemoteFolderMove[];
}

/**
 * Returned by fetchAndFilterRemoteChanges: the fully filtered set of remote
 * changes ready for planning, plus the raw delta responses (needed to store
 * delta links after sync), any deleted folder paths for later pruning, and
 * any folder moves/renames that need to be applied locally.
 */
interface RemoteChangesResult {
	remoteChanges: OneDriveItem[];
	deltaResponse: DeltaResponse;
	obsidianDeltaResponse?: DeltaResponse;
	deletedFolderPaths: string[];
	folderMoves: RemoteFolderMove[];
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
	failedPaths: string[];
	deferredPaths: string[];
}

interface SyncOperationFailure {
	operation: SyncOperation;
	error: Error;
	deferrable: boolean;
}

/**
 * Main sync engine
 */
export class SyncEngine {
	// Concurrent operations limit — overridable via experimental settings.
	// Four concurrent operations is a conservative default for typical vaults.
	private readonly maxConcurrentOperations: number;
	// Use atomic PATCH moves instead of delete+upload — more efficient and avoids duplicates.
	private readonly useAtomicMoves: boolean;
	private isSharedDrive: boolean;
	private remoteRootOnDrive: string;
	private static readonly DEFAULT_IGNORE_PATTERNS: string[] = [
		'~$*',
		'*.tmp',
		'.~lock.*#',
		'.DS_Store',
		'Thumbs.db',
		'desktop.ini',
	];
	private pendingVaultFolderCreates = new Map<string, Promise<void>>();

	// Options stored as instance properties
	private readonly remoteRoot: string;
	private readonly conflictQueue?: SyncEngineConflictQueue;
	private readonly shouldSyncPath: (path: string) => boolean;
	private readonly getLargeDeleteThreshold: () => number;
	private readonly largeDeleteWarningHandler?: LargeDeleteWarningHandler;
	private readonly onProgress?: (message: string | undefined) => void;
	private readonly getNotificationLevel: () => NotificationLevel;
	private readonly pluginVersion: string;
	private readonly isPullOnlyMode: () => boolean;
	private readonly isAppFolder: boolean;

	constructor(
		private app: App,
		private fileOps: FileOperations,
		private oneDriveClient: OneDriveClient,
		private stateManager: SyncStateManager,
		private conflictResolver: ConflictResolver,
		private eventManager: EventManager,
		private configDir: string,
		options: SyncEngineOptions = {}
	) {
		// Apply options with defaults
		this.remoteRoot = options.remoteRoot ?? '';
		this.conflictQueue = options.conflictQueue;
		this.shouldSyncPath = options.shouldSyncPath ?? ((path) => shouldSyncVaultPath(path, false, false, configDir));
		this.getLargeDeleteThreshold = options.getLargeDeleteThreshold ?? (() => 0);
		this.largeDeleteWarningHandler = options.largeDeleteWarningHandler;
		this.onProgress = options.onProgress;
		this.getNotificationLevel = options.getNotificationLevel ?? (() => 'all');
		this.pluginVersion = options.pluginVersion ?? 'unknown';
		this.maxConcurrentOperations = options.maxConcurrentOperations ?? 4;
		this.useAtomicMoves = options.useAtomicMoves ?? true;
		this.isPullOnlyMode = options.isPullOnlyMode ?? (() => false);
		this.isAppFolder = options.isAppFolder ?? false;

		this.isSharedDrive = oneDriveClient.isSharedDrive();
		// For shared drives, delta items have paths relative to the remote drive root,
		// so we need the folder name on that drive for path stripping
		this.remoteRootOnDrive = options.remoteRootOnDrive ?? this.remoteRoot;
	}

	private isObsidianPath(path: string): boolean {
		return normalizePath(path).startsWith(`${normalizePath(this.configDir).replace(/\/+$/g, '')}/`);
	}

	/**
	 * Whether happy-path notices (progress bars, "up to date", "no files to
	 * sync") should be shown. Only surfaced at the most verbose level so
	 * frequent auto-syncs don't spam the user (see issue #95).
	 */
	private shouldNotifyInfo(): boolean {
		return this.getNotificationLevel() === 'all';
	}

	/**
	 * Whether error/conflict/safety notices should be shown. Suppressed only
	 * when notifications are turned off entirely.
	 */
	private shouldNotifyError(): boolean {
		return this.getNotificationLevel() !== 'off';
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
		logger.info(`OneDrive Sync v${this.pluginVersion} — starting sync`);
		const progress: ProgressFn = (msg) => {
			try {
				this.onProgress?.(msg);
			} catch {
				// progress reporting must never break sync
			}
		};

		try {
			progress(t('progress.starting'));

			// Phase 0: Log inventory drift (tracked state vs actual vault files)
			this.logInventoryDrift();

			// Phase 1: Collect local dirty files, filtering out .syncIgnore matches
			const ignoreMatchers = await this.loadIgnoreMatchers();
			const isFirstSync = this.stateManager.isFirstSync();
			const { localChanges, folderChanges } = await this.gatherLocalChanges(ignoreMatchers);

			// Phase 2: Fetch remote delta changes from OneDrive, expand folder
			// deletes into per-file deletes, and filter by sync scope
			const { remoteChanges, deltaResponse, obsidianDeltaResponse, deletedFolderPaths, folderMoves } =
				await this.fetchAndFilterRemoteChanges(ignoreMatchers, progress);

			// Apply any folder moves/renames detected on the remote (e.g. a
			// folder reorganized on another device) before planning, so
			// descendant files are already relocated and won't be treated as
			// new downloads or left stranded in stale folders (issue #163).
			if (folderMoves.length > 0) {
				await this.applyRemoteFolderMoves(folderMoves);
			}

			// Phase 3: Diff local vs remote to produce upload/download/conflict ops
			const operations = await this.planOperations(localChanges, remoteChanges, isFirstSync);

			// On first sync the dirty queue is empty, so walk the vault and add
			// uploads for any local-only files not already covered by the delta
			if (isFirstSync) {
				await this.addFirstSyncUploads(operations, ignoreMatchers);
			}

			logger.info(`Sync plan: ${operations.length} operations`);
			for (const op of operations) {
				logger.debug(`  Op: ${op.direction} ${op.path}`);
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
					if (this.shouldNotifyError()) {
						new Notice(
							decision === 'disable'
								? t('notices.sync.disabledAfterLargeDelete')
								: t('notices.sync.cancelledAfterLargeDelete')
						);
					}
					return;
				}
			}

			if (operations.length === 0) {
				if (isFirstSync && localChanges.length === 0 && remoteChanges.length === 0) {
					logger.info(
						'First sync with no local dirty files and empty remote — nothing to do. Edit or create files, then sync again.'
					);
					if (this.shouldNotifyInfo()) {
						new Notice(t('notices.sync.noFilesToSync'));
					}
				} else if (folderChanges.length === 0 && deletedFolderPaths.length === 0) {
					logger.info('Everything up to date — no operations needed');
				}
				if (folderChanges.length === 0 && deletedFolderPaths.length === 0) {
					this.stateManager.setDeltaLink(deltaResponse.deltaLink, true);
					if (obsidianDeltaResponse) {
						this.stateManager.setObsidianDeltaLink(obsidianDeltaResponse.deltaLink);
					}
					this.stateManager.setLastSyncTime(Date.now());
					this.eventManager.markInitialSyncDone();
					return;
				}
			}

			// Phase 4: Execute all planned sync operations with progress tracking
			const { completed, downloadedPaths, conflictedPaths, failedPaths, deferredPaths } = await this.executeSyncOperations(
				operations,
				progress
			);

			// Clean up empty folders left behind by folder-delete expansion
			if (deletedFolderPaths.length > 0) {
				await this.deleteCloudDeletedFolders(deletedFolderPaths);
			}

			// Process explicit folder creates/deletes from vault events
			await this.processFolderChanges(folderChanges);

			// Prune remote config folders (.obsidian/plugins/*) left empty
			// after local-driven file deletes. Config folders don't fire
			// TFolder vault events, so processFolderChanges won't catch them.
			await this.pruneEmptyRemoteConfigFolders(operations);

			// Phase 5: Finalize — store delta cursors so next sync starts where
			// this one left off, clear the dirty queue, re-mark conflicts
			if (downloadedPaths.length > 0) {
				this.eventManager.removeDirtyPaths(downloadedPaths);
			}

			this.stateManager.setDeltaLink(deltaResponse.deltaLink, true);
			if (obsidianDeltaResponse) {
				this.stateManager.setObsidianDeltaLink(obsidianDeltaResponse.deltaLink);
			}
			this.stateManager.setLastSyncTime(Date.now());

			if (failedPaths.length === 0 && conflictedPaths.length === 0) {
				this.eventManager.clearDirtyFiles();
			} else {
				const failedPathSet = new Set(failedPaths);
				const conflictPathSet = new Set(conflictedPaths);
				const successfulOperationPaths = operations
					.filter((operation) => !failedPathSet.has(operation.path) && !conflictPathSet.has(operation.path))
					.map((operation) => operation.path);
				const completedFolderPaths = folderChanges.map((change) => change.path);
				const cleanPaths = Array.from(new Set([
					...successfulOperationPaths,
					...completedFolderPaths,
				]));
				if (cleanPaths.length > 0) {
					this.eventManager.removeDirtyPaths(cleanPaths);
				}
				for (const path of failedPaths) {
					this.eventManager.addDirtyFile(path, 'modify');
				}
				for (const path of conflictedPaths) {
					this.eventManager.addDirtyFile(path, 'modify');
				}
			}

			logger.debug('Sync operations finished');
			this.eventManager.markInitialSyncDone();

			const syncedCount = completed - conflictedPaths.length;
			if (failedPaths.length > 0 && this.shouldNotifyError()) {
				const retryCount = failedPaths.length;
				const lockedCount = deferredPaths.length;
				new Notice(
					t('notices.sync.completedWithDeferred', {
						syncedCount,
						fileLabel: t(syncedCount === 1 ? 'notices.sync.file' : 'notices.sync.files'),
						retryCount,
						retryLabel: t(retryCount === 1 ? 'notices.sync.file' : 'notices.sync.files'),
						lockedCount,
					})
				);
			}
			if (conflictedPaths.length > 0 && this.shouldNotifyError()) {
				new Notice(
					t('notices.sync.conflictsNeedResolution', {
						syncedCount,
						fileLabel: t(syncedCount === 1 ? 'notices.sync.file' : 'notices.sync.files'),
						conflictCount: conflictedPaths.length,
						conflictLabel: t(
							conflictedPaths.length === 1 ? 'notices.sync.conflict' : 'notices.sync.conflicts'
						),
					})
				);
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : t('notices.common.unknownError');
			logger.error(`Sync failed: ${errorMsg}`, error);
			if (this.shouldNotifyError()) {
				new Notice(t('notices.sync.engineFailed', { message: errorMsg }));
			}
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
	 *
	 * In pull-only mode, returns empty changes (local edits are not uploaded).
	 */
	private async gatherLocalChanges(ignoreMatchers: RegExp[]): Promise<LocalChangesResult> {
		// In pull-only mode, skip all local change detection — we only download
		if (this.isPullOnlyMode()) {
			logger.info('Pull-only mode: skipping local change detection');
			// Clear any dirty files that accumulated (they won't be uploaded)
			// but don't delete them — they'll be picked up if mode changes to bidirectional
			return {
				localChanges: [],
				folderChanges: [],
				ignoredCount: 0,
			};
		}

		const allLocalChanges = this.eventManager.getDirtyFiles();
		const ignoredLocalPaths: string[] = [];
		const folderChanges: LocalChange[] = [];
		const localChanges = allLocalChanges.filter((change) => {
			if (this.shouldIgnorePath(change.path, ignoreMatchers)) {
				ignoredLocalPaths.push(change.path);
				return false;
			}
			// Separate folder operations from file operations
			if (
				change.type === LocalChangeType.FOLDER_CREATE ||
					change.type === LocalChangeType.FOLDER_DELETE ||
					change.type === LocalChangeType.FOLDER_RENAME
				) {
					folderChanges.push(change);
					return false;
				}
				return true;
		});
		if (ignoredLocalPaths.length > 0) {
			this.eventManager.removeDirtyPaths(ignoredLocalPaths);
		}

		// Config files inside .obsidian/ don't fire vault events (they
		// aren't TFile instances). Detect changes by comparing their
		// current mtime/size against tracked sync state. Pass the dirty
		// snapshot we already took so both phases see the same queue.
		const dirtyPaths = new Set(allLocalChanges.map((change) => change.path));
		const configChanges = await this.detectConfigFileChanges(ignoreMatchers, dirtyPaths);
		localChanges.push(...configChanges);

		logger.info(
			`Local changes: ${localChanges.length} dirty files (${configChanges.length} config), ${folderChanges.length} folder operations`
		);
		for (const change of localChanges) {
			logger.debug(
				`  Local: ${change.type} ${change.path}${change.oldPath ? ` (from ${change.oldPath})` : ''}`
			);
		}
		for (const change of folderChanges) {
			logger.debug(`  Local folder: ${change.type} ${change.path}`);
		}

		const discoveredFolderCreates = this.discoverUntrackedLocalFolders(ignoreMatchers, folderChanges);
		if (discoveredFolderCreates.length > 0) {
			folderChanges.push(...discoveredFolderCreates);
			logger.info(
				`Local folder discovery: queued ${discoveredFolderCreates.length} existing untracked folder creates`
			);
			for (const change of discoveredFolderCreates) {
				logger.debug(`  Local folder discovered: ${change.type} ${change.path}`);
			}
		}

		return {
			localChanges,
			folderChanges,
			ignoredCount: ignoredLocalPaths.length,
		};
	}

	private discoverUntrackedLocalFolders(
		ignoreMatchers: RegExp[],
		existingFolderChanges: LocalChange[]
	): LocalChange[] {
		const pendingFolderPaths = new Set(existingFolderChanges.map((change) => change.path));
		const configDir = normalizePath(this.configDir).replace(/\/+$/, '');
		const discovered: LocalChange[] = [];
		const root = this.app.vault.getRoot();

		const traverseFolderTree = (folder: TFolder): void => {
			for (const child of folder.children) {
				if (!(child instanceof TFolder)) continue;

				const path = normalizePath(child.path);

				if (path === configDir || path.startsWith(`${configDir}/`)) {
					continue;
				}

				if (
					!pendingFolderPaths.has(path) &&
					!this.stateManager.getFolderIdByPath(path) &&
					this.shouldSyncPath(path) &&
					!this.shouldIgnorePath(path, ignoreMatchers)
				) {
					discovered.push({ path, type: LocalChangeType.FOLDER_CREATE });
					pendingFolderPaths.add(path);
				}

				traverseFolderTree(child);
			}
		};

		traverseFolderTree(root);

		return discovered;
	}

	/**
	 * Detect local changes to .obsidian/ config files by comparing their
	 * current mtime/size against the last-synced state. Returns synthetic
	 * LocalChange entries for any files that changed or were deleted.
	 *
	 * @param dirtyPaths Paths already queued by vault events (snapshot taken
	 *   by the caller) — checked as a Set so large config sets stay O(1) per path.
	 */
	private async detectConfigFileChanges(
		ignoreMatchers: RegExp[],
		dirtyPaths: Set<string>
	): Promise<LocalChange[]> {
		const adapter = this.app.vault.adapter;
		const changes: LocalChange[] = [];

		// Gather all syncable config paths (fixed + installed plugins)
		const allConfigPaths = await getAllSyncableConfigPaths(
			this.configDir,
			adapter,
			(path) => this.shouldSyncPath(path)
		);

		const checkedPaths = new Set<string>();

		for (const path of allConfigPaths) {
			checkedPaths.add(path);
			if (!this.shouldSyncPath(path)) continue;
			if (this.shouldIgnorePath(path, ignoreMatchers)) continue;
			// Skip paths already queued by vault events
			if (dirtyPaths.has(path)) continue;
			// Skip paths we just wrote during a previous download
			if (this.eventManager.isOwnWrite(path)) continue;

			const trackedState = this.stateManager.getFileState(path);

			try {
				const stat = await adapter.stat(path);
				if (stat && stat.type === 'file') {
					// File exists locally
					if (!trackedState) {
						changes.push({ path, type: LocalChangeType.CREATE });
					} else if (stat.mtime !== trackedState.localMtime || stat.size !== trackedState.size) {
						// Mtime or size changed — read content and compare hash
						// to avoid false positives from Obsidian touching files on startup
						const content = await adapter.readBinary(path);
						const hash = hashContent(new Uint8Array(content));
						if (hash !== trackedState.localContentHash) {
							if (!trackedState.localContentHash) {
								// Hash was never stored (e.g. after reconcile) —
								// backfill it without treating as a change
								logger.debug(`Config file hash backfilled: ${path} (${hash})`);
								this.stateManager.setFileState(path, {
									...trackedState,
									localMtime: stat.mtime,
									size: stat.size,
									localContentHash: hash,
								});
							} else {
								logger.debug(
									`Config file content changed: ${path} (hash ${trackedState.localContentHash} → ${hash})`
								);
								changes.push({ path, type: LocalChangeType.MODIFY });
							}
						} else {
							// Content unchanged — just update tracked mtime
							logger.debug(`Config file mtime changed but content unchanged: ${path}`);
							this.stateManager.setFileState(path, {
								...trackedState,
								localMtime: stat.mtime,
								size: stat.size,
							});
						}
					}
				} else if (trackedState) {
					// File was tracked but no longer exists → local delete
					changes.push({ path, type: LocalChangeType.DELETE });
				}
			} catch {
				// stat failed — if tracked, treat as delete
				if (trackedState) {
					changes.push({ path, type: LocalChangeType.DELETE });
				}
			}
		}

		// Check tracked plugin paths whose folders were deleted — these
		// won't appear in allConfigPaths because getInstalledPluginSyncPaths
		// only lists currently-existing folders.
		const pluginPrefix = `${this.configDir}/plugins/`;
		for (const path of this.stateManager.getTrackedPaths()) {
			if (!path.startsWith(pluginPrefix)) continue;
			if (checkedPaths.has(path)) continue;
			if (!this.shouldSyncPath(path)) continue;
			if (this.shouldIgnorePath(path, ignoreMatchers)) continue;
			if (dirtyPaths.has(path)) continue;

			try {
				const stat = await adapter.stat(path);
				if (!stat || stat.type !== 'file') {
					logger.info(`Tracked plugin file no longer exists: ${path}`);
					changes.push({ path, type: LocalChangeType.DELETE });
				}
			} catch {
				logger.info(`Tracked plugin file no longer exists: ${path}`);
				changes.push({ path, type: LocalChangeType.DELETE });
			}
		}

		return changes;
	}

	/**
	 * Retire a legacy app-folder delta cursor that predates the issue #97 fix.
	 *
	 * Before the fix the app-folder delta query ignored the vault subfolder and
	 * streamed the entire app folder, so a stored cursor could keep returning
	 * sibling vaults' files (which then got nested into this vault). Such cursors
	 * lack the `deltaLinkScoped` flag. When we detect one in app-folder mode with
	 * a subfolder configured, drop it so the next fetch builds a fresh, properly
	 * scoped cursor. Tracked file/folder state is left intact.
	 */
	private retireLegacyUnscopedDeltaLink(): void {
		if (!this.isAppFolder) return;
		if (!this.remoteRoot) return; // no subfolder → wide query was already correct
		if (!this.stateManager.getDeltaLink()) return;
		if (this.stateManager.isDeltaLinkScoped()) return;
		logger.warn(
			'Retiring legacy unscoped app-folder delta cursor (issue #97); ' +
				'next sync will rebuild a subfolder-scoped cursor.'
		);
		this.stateManager.resetDeltaLink();
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
		progress(t('progress.fetchingRemoteChanges'));
		this.retireLegacyUnscopedDeltaLink();
		const deltaLink = this.stateManager.getDeltaLink();
		const shouldSyncObsidianScope =
			this.shouldSyncPath(`${this.configDir}/community-plugins.json`) ||
			this.shouldSyncPath(`${this.configDir}/app.json`);
		const isFirstSync = this.stateManager.isFirstSync();
		logger.info(`Delta query: isFirstSync=${isFirstSync}, hasDeltaLink=${!!deltaLink}`);
		const obsidianDeltaLink = this.stateManager.getObsidianDeltaLink();
		// The two delta streams are independent — fetch them in parallel
		const [deltaResponse, obsidianDeltaResponse] = await Promise.all([
			this.oneDriveClient.getDelta(deltaLink, this.remoteRoot),
			shouldSyncObsidianScope
				? this.oneDriveClient.getDelta(obsidianDeltaLink, this.remoteRoot, this.configDir)
				: Promise.resolve(undefined),
		]);

		progress(t('progress.planning'));

		for (const item of deltaResponse.items) {
			const vaultPath = this.remotePathToVaultPath(item);
			logger.debug(
				`  Raw delta item: name=${item.name} path=${vaultPath} isFolder=${!!item.folder} isFile=${!!item.file} deleted=${!!item.deleted} parentPath=${item.parentReference?.path || 'none'}`
			);
		}

		const { synthesizedDeletes, deletedFolderPaths, folderMoves } = this.expandFolderDeletes([
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
			logger.debug(`  Remote: ${item.deleted ? 'DELETE' : 'CHANGED'} ${vaultPath} (id=${item.id})`);
		}

		return {
			remoteChanges,
			deltaResponse,
			obsidianDeltaResponse,
			deletedFolderPaths,
			folderMoves,
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
		const folderMoves: RemoteFolderMove[] = [];

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
					const previousPath = this.stateManager.getFolderPathById(item.id);
					if (previousPath && previousPath !== folderPath) {
						logger.info(`Folder move detected: ${previousPath} → ${folderPath} (id=${item.id})`);
						folderMoves.push({ oldPath: previousPath, newPath: folderPath });
					}
					this.stateManager.setFolderState(item.id, folderPath);
				}
			}
		}

		return { synthesizedDeletes, deletedFolderPaths, folderMoves };
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
				return this.shouldSyncPath(vaultPath) && !this.shouldIgnorePath(vaultPath, ignoreMatchers);
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
	private async addFirstSyncUploads(
		operations: SyncOperation[],
		ignoreMatchers: RegExp[]
	): Promise<number> {
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

		// Also enumerate config files that vault.getFiles() misses
		const adapter = this.app.vault.adapter;
		const configPaths = await getAllSyncableConfigPaths(
			this.configDir,
			adapter,
			(path) => this.shouldSyncPath(path)
		);
		for (const path of configPaths) {
			if (remoteCoveredPaths.has(path)) continue;
			if (!this.shouldSyncPath(path)) continue;
			if (this.shouldIgnorePath(path, ignoreMatchers)) continue;
			try {
				const stat = await adapter.stat(path);
				if (stat && stat.type === 'file') {
					operations.push({ path, direction: SyncDirection.UPLOAD });
					localOnlyCount++;
				}
			} catch {
				// file doesn't exist, skip
			}
		}

		if (localOnlyCount > 0) {
			logger.info(`First-sync local enumeration: queued ${localOnlyCount} local-only file uploads`);
		}
		return localOnlyCount;
	}

	/**
	 * Execute all planned sync operations (uploads, downloads, deletes)
	 * with progress tracking. Shows a progress-bar Notice for batches of
	 * 5+ operations that updates in-place as each operation completes.
	 */
	private async executeSyncOperations(
		operations: SyncOperation[],
		progress: ProgressFn
	): Promise<SyncExecutionResult> {
		let completed = 0;
		let finished = 0;
		const downloadedPaths: string[] = [];
		const conflictedPaths: string[] = [];
		progress(t('progress.files', { completed: 0, total: operations.length }));
		const progressNotice =
			operations.length >= 5 && this.shouldNotifyInfo()
				? new ProgressNotice(t('progress.syncing'), operations.length)
				: null;
		const updateProgress = () => {
			const progressLabel = t('progress.files', { completed: finished, total: operations.length });
			progress(progressLabel);
			if (progressNotice) {
				progressNotice.update(finished, t('progress.syncing'));
			}
		};
		const failures = await this.executeOperations(operations, (operation) => {
			completed++;
			finished++;

			if (operation.direction === SyncDirection.DOWNLOAD) {
				downloadedPaths.push(operation.path);
			}
			if (operation.direction === SyncDirection.CONFLICT) {
				conflictedPaths.push(operation.path);
			}

			updateProgress();
		}, () => {
			finished++;
			updateProgress();
		});
		progressNotice?.hide();
		progress(undefined);
		return {
			completed,
			downloadedPaths,
			conflictedPaths,
			failedPaths: failures.map((failure) => failure.operation.path),
			deferredPaths: failures
				.filter((failure) => failure.deferrable)
				.map((failure) => failure.operation.path),
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
	private async maybeWarnLargeDeletes(operations: SyncOperation[]): Promise<LargeDeleteDecision> {
		const threshold = Math.max(0, Math.floor(this.getLargeDeleteThreshold() || 0));
		if (threshold <= 0 || !this.largeDeleteWarningHandler) return 'proceed';

		const localDeletes: string[] = []; // remote-driven local deletes (data-loss risk)
		const remoteDeletes: string[] = []; // local-driven remote deletes
		for (const op of operations) {
			if (op.direction === SyncDirection.DOWNLOAD && op.remoteState === undefined) {
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
	private async planOperations(
		localChanges: LocalChange[],
		remoteChanges: OneDriveItem[],
		isFirstSync: boolean
	): Promise<SyncOperation[]> {
		const operations: SyncOperation[] = [];

		// Build a map of remote changes by vault path
		const remoteByPath = new Map<string, OneDriveItem>();
		for (const item of remoteChanges) {
			const vaultPath = this.remotePathToVaultPath(item);
			remoteByPath.set(vaultPath, item);
		}

		// Build a set of locally changed paths. On first sync, ignore CREATE
		// events for paths that already exist remotely; startup indexing can
		// queue these as "local creates", but treating them as local-wins would
		// overwrite cloud mtimes by re-uploading unchanged files.
		const localChangedPaths = new Set(
			localChanges
				.filter((change) => {
					if (!isFirstSync || change.type !== LocalChangeType.CREATE) return true;
					const remoteItem = remoteByPath.get(change.path);
					return !remoteItem || !!remoteItem.deleted;
				})
				.map((c) => c.path)
		);

		// Process local changes
		for (const change of localChanges) {
			// Skip paths with pending conflicts — don't re-process until user resolves
			if (this.conflictQueue?.hasConflict(change.path)) {
				logger.debug(`Skipping ${change.path} — pending conflict`);
				remoteByPath.delete(change.path);
				continue;
			}

			const remoteItem = remoteByPath.get(change.path);
			if (isFirstSync && change.type === LocalChangeType.CREATE && remoteItem && !remoteItem.deleted) {
				// Ignore startup CREATE noise and let the remote-pass first-sync
				// logic decide via size match / download.
				continue;
			}

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
				// Rename/move operation
				logger.info(`Processing rename: ${change.oldPath} → ${change.path}`);
				const oldState = this.stateManager.getFileState(change.oldPath);

				// The delta may still report the pre-rename item at the OLD path —
				// an echo of our own earlier upload that carries the SAME OneDrive
				// ID we're about to move/re-upload. It isn't matched by any local
				// change (the local change is keyed to the NEW path), so the remote
				// pass below would plan a download and recreate a phantom file
				// linked to the same remote item. Deleting that phantom then deletes
				// the renamed file from OneDrive too (issue #138). Drop the stale
				// echo from the remote worklist when the IDs match.
				const staleOldRemote = remoteByPath.get(change.oldPath);
				if (
					staleOldRemote &&
					!staleOldRemote.deleted &&
					oldState?.oneDriveId &&
					staleOldRemote.id === oldState.oneDriveId
				) {
					logger.debug(
						`Rename: dropping stale remote echo of ${change.oldPath} ` +
						`(same OneDrive ID ${oldState.oneDriveId})`
					);
					remoteByPath.delete(change.oldPath);
				}

				if (this.useAtomicMoves && oldState?.oneDriveId) {
					// Use atomic move via OneDrive PATCH API — more efficient (no re-upload)
					// and avoids duplicate files if something goes wrong
					logger.debug(`Rename: using atomic move for ${change.oldPath} (OneDrive ID: ${oldState.oneDriveId})`);
					operations.push({
						path: change.path,
						direction: SyncDirection.MOVE,
						moveFromId: oldState.oneDriveId,
						remoteState: oldState,
					});
					this.stateManager.removeFileState(change.oldPath);
					remoteByPath.delete(change.path);
					continue;
				}

				// Fallback: delete old + upload new (legacy behavior)
				if (oldState?.oneDriveId) {
					logger.debug(`Rename: scheduling delete of old path ${change.oldPath} (OneDrive ID: ${oldState.oneDriveId})`);
					operations.push({
						path: change.oldPath,
						direction: SyncDirection.UPLOAD, // "upload" the deletion of old path
						localState: undefined,
						remoteState: oldState,
					});
				} else {
					// No tracked state for old path — we can't delete it from OneDrive.
					// This can happen if the file was never synced, or if sync state was lost.
					// Log a warning so users can investigate if duplicates appear.
					logger.warn(
						`Rename: no tracked state for old path ${change.oldPath} — cannot delete from OneDrive. ` +
						`This may result in a duplicate file on OneDrive if the old path exists there.`
					);
				}
				// Upload the file at its new path
				logger.debug(`Rename: scheduling upload to new path ${change.path}`);
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
				// Both local and remote show changes — but check if remote actually changed content
				const knownState = this.stateManager.getFileState(change.path);
				const file = this.app.vault.getAbstractFileByPath(change.path);

				// Check if the remote content actually changed by comparing hashes.
				// The delta API reports our own upload as a "change" (new mtime), but if
				// the hash matches what we stored, the content is the same — just upload.
				const remoteHash = remoteItem.file?.hashes?.quickXorHash || '';
				if (knownState && knownState.remoteHash === remoteHash) {
					logger.debug(
						`Remote hash unchanged for ${change.path} — uploading local (no real conflict)`
					);
					operations.push({
						path: change.path,
						direction: SyncDirection.UPLOAD,
						localState: knownState,
						remoteState: this.itemToFileState(remoteItem),
					});
				} else if (file instanceof TFile && knownState) {
					// Remote content genuinely changed — real conflict
					const conflictInfo: ConflictInfo = {
						path: change.path,
						localModifiedTime: file.stat.mtime,
						remoteModifiedTime: new Date(remoteItem.lastModifiedDateTime).getTime(),
						localSize: file.stat.size,
						remoteSize: remoteItem.size || 0,
					};
					const resolution = this.conflictResolver.resolveConflict(conflictInfo);
					const remoteState = this.itemToFileState(remoteItem);
					switch (resolution.kind) {
						case 'duplicate':
							// CREATE_DUPLICATE: preserve the remote version under a
							// new dated name, then converge the base path by
							// uploading the local version. Without this converging
							// upload the base file keeps its stale tracked hash, so
							// it is re-detected as a conflict on every subsequent
							// sync and a fresh dated copy is spawned each cycle —
							// the runaway duplication in #128.
							operations.push({
								path: resolution.duplicatePath,
								direction: SyncDirection.DOWNLOAD,
								remoteState,
							});
							operations.push({
								path: change.path,
								direction: SyncDirection.UPLOAD,
								localState: knownState,
								remoteState,
							});
							break;
						case 'converge':
							operations.push({
								path: change.path,
								direction: resolution.direction,
								localState: knownState,
								remoteState,
							});
							break;
						case 'manual':
							operations.push({
								path: change.path,
								direction: SyncDirection.CONFLICT,
								localState: knownState,
								remoteState,
							});
							break;
					}
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
				// Remote delete — delete locally (vault files or config files via adapter)
				const file = this.app.vault.getAbstractFileByPath(vaultPath);
				const isTracked = this.stateManager.getFileState(vaultPath);
				if (file || isTracked) {
					operations.push({
						path: vaultPath,
						direction: SyncDirection.DOWNLOAD, // "download" the deletion
						remoteState: undefined,
					});
				}
				// Clean up tracked state regardless — the remote copy is gone
				this.stateManager.removeFileState(vaultPath);
				continue;
			}

			if (!item.file) continue; // Skip non-file items

			// On first sync, check if file already exists locally
			if (isFirstSync) {
				const file = this.app.vault.getAbstractFileByPath(vaultPath);
				if (file instanceof TFile) {
					if (file.stat.size === (item.size || 0)) {
						// Same size — verify content via hash when the remote item
						// carries one (same-size-different-content would otherwise
						// silently never sync). Falls back to trusting the size
						// match when no hash is available.
						const matches = await this.localContentMatchesRemote(vaultPath, item);
						if (matches !== false) {
							this.stateManager.setFileState(vaultPath, this.itemToFileState(item));
							continue;
						}
					}
					// File exists but content differs — download remote version
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
	 * Verify a local file's content against the remote item's sha1Hash.
	 * Returns true/false when a comparison was possible, or undefined when
	 * it wasn't (no remote hash, unreadable file, or no WebCrypto) so the
	 * caller can fall back to the size heuristic.
	 */
	private async localContentMatchesRemote(
		path: string,
		item: OneDriveItem
	): Promise<boolean | undefined> {
		const remoteSha1 = item.file?.hashes?.sha1Hash;
		if (!remoteSha1) return undefined;
		try {
			const content = await this.app.vault.adapter.readBinary(path);
			const localSha1 = await sha1HexUpper(content);
			if (!localSha1) return undefined;
			const matches = localSha1 === remoteSha1.toUpperCase();
			if (!matches) {
				logger.info(`Same-size content mismatch detected via sha1 for ${path}`);
			}
			return matches;
		} catch {
			return undefined;
		}
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
			} else if (operation.direction === SyncDirection.MOVE) {
				// Atomic move/rename using OneDrive's PATCH API
				if (!operation.moveFromId) {
					throw new Error('MOVE operation requires moveFromId');
				}
				const remotePath = this.vaultPathToRemotePath(operation.path);
				logger.info(`Moving item to ${remotePath}`);
				const movedItem = await this.fileOps.moveFile(operation.moveFromId, remotePath);

				// Update state with new path and item metadata
				const localFile = this.app.vault.getAbstractFileByPath(operation.path);
				const localMtime = localFile instanceof TFile ? localFile.stat.mtime : 0;
				this.stateManager.setFileState(operation.path, {
					path: operation.path,
					localMtime,
					remoteHash: movedItem.file?.hashes?.quickXorHash || '',
					size: movedItem.size || 0,
					remoteModifiedTime: new Date(movedItem.lastModifiedDateTime).getTime(),
					oneDriveId: movedItem.id,
				});
				logger.debug(`Moved remote file to ${operation.path}`);
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
		onComplete: (operation: SyncOperation) => void,
		onFailure?: OperationFailureProgressFn
	): Promise<SyncOperationFailure[]> {
		const parallelCount = Math.min(this.maxConcurrentOperations, operations.length);
		let nextIndex = 0;
		const failures: SyncOperationFailure[] = [];

		await Promise.all(
			Array.from({ length: parallelCount }, async () => {
				while (nextIndex < operations.length) {
					const operation = operations[nextIndex++];
					try {
						await this.executeOperation(operation);
						onComplete(operation);
					} catch (error) {
						const normalizedError =
							error instanceof Error ? error : new Error(String(error));
						const failure: SyncOperationFailure = {
							operation,
							error: normalizedError,
							deferrable: isDeferrableError(normalizedError),
						};
						failures.push(failure);
						if (failure.deferrable) {
							logger.warn(
								`Deferred ${operation.direction} for ${operation.path}; will retry next sync:`,
								normalizedError
							);
						} else {
							logger.error(
								`Failed ${operation.direction} for ${operation.path}; continuing sync:`,
								normalizedError
							);
						}
						// Failure details are returned to the caller; the callback is
						// only for per-operation progress bookkeeping.
						onFailure?.();
					}
				}
			})
		);

		return failures;
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

		if (!operation.remoteState?.oneDriveId) {
			logger.warn(`No remote ID for conflict: ${operation.path}`);
			return;
		}

		// Read local content — TFile for vault files, adapter for config files
		let localContent: ArrayBuffer;
		let localMtime: number;
		const file = this.app.vault.getAbstractFileByPath(operation.path);
		if (file instanceof TFile) {
			localContent = await this.app.vault.readBinary(file);
			localMtime = file.stat.mtime;
		} else {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(operation.path))) {
				logger.warn(`Local file not found for conflict: ${operation.path}`);
				return;
			}
			localContent = await adapter.readBinary(operation.path);
			const stat = await adapter.stat(operation.path);
			localMtime = stat?.mtime ?? Date.now();
		}

		// Snapshot both versions
		const remoteContent = await this.fileOps.downloadFile(operation.remoteState.oneDriveId);

		await this.conflictQueue.add(
			operation.path,
			localContent,
			remoteContent,
			localMtime,
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
		let content: ArrayBuffer;
		let localMtime: number;

		if (file instanceof TFile) {
			content = await this.app.vault.readBinary(file);
			localMtime = file.stat.mtime;
		} else {
			// Config files aren't TFile — read via adapter
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(operation.path))) {
				// File was deleted between planning and execution — treat as
				// a local delete: remove the remote copy if we have an ID,
				// then clean up tracked state.
				logger.warn(`File vanished before upload: ${operation.path} — converting to remote delete`);
				const knownState = this.stateManager.getFileState(operation.path);
				if (knownState?.oneDriveId) {
					try {
						await this.fileOps.deleteFile(knownState.oneDriveId);
						logger.debug(`Deleted remote ${operation.path} (vanished locally)`);
					} catch (deleteError) {
						logger.warn(
							`Could not delete remote ${operation.path} after local vanish:`,
							deleteError
						);
					}
				}
				this.stateManager.removeFileState(operation.path);
				return;
			}
			content = await adapter.readBinary(operation.path);
			const stat = await adapter.stat(operation.path);
			localMtime = stat?.mtime ?? Date.now();
		}

		const remotePath = this.vaultPathToRemotePath(operation.path);
		const item = await this.fileOps.uploadFile(remotePath, content);

		this.stateManager.setFileState(operation.path, {
			path: operation.path,
			localMtime,
			remoteHash: item.file?.hashes?.quickXorHash || '',
			size: content.byteLength,
			remoteModifiedTime: new Date(item.lastModifiedDateTime).getTime(),
			oneDriveId: item.id,
			localContentHash: !(file instanceof TFile) ? hashContent(new Uint8Array(content)) : undefined,
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
		let localMtime: number;
		if (file instanceof TFile) {
			localMtime = file.stat.mtime;
		} else {
			const stat = await this.app.vault.adapter.stat(operation.path);
			localMtime = stat?.mtime ?? Date.now();
		}

		this.stateManager.setFileState(operation.path, {
			path: operation.path,
			localMtime,
			remoteHash: operation.remoteState.remoteHash,
			size: content.byteLength,
			remoteModifiedTime: operation.remoteState.remoteModifiedTime,
			oneDriveId: operation.remoteState.oneDriveId,
			localContentHash: !(file instanceof TFile) ? hashContent(new Uint8Array(content)) : undefined,
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
		} else {
			// Config files aren't in the vault index — delete via adapter
			const adapter = this.app.vault.adapter;
			if (await adapter.exists(filePath)) {
				this.eventManager.markOwnWrites([filePath]);
				try {
					await adapter.remove(filePath);
				} catch (error) {
					this.eventManager.removeOwnWrite(filePath);
					throw error;
				}
				logger.debug(`Deleted local config file ${filePath}`);
			}
		}
			this.stateManager.removeFileState(filePath);
		}

		/**
		 * Delete local folders that the cloud explicitly told us were deleted,
		 * but only if they are empty after processing file deletions.
		 * Does NOT walk up to ancestor folders.
		 */
		private async deleteCloudDeletedFolders(folderPaths: string[]): Promise<void> {
		// Dedupe and sort deepest-first so children are removed before parents.
		const candidates = new Set<string>(folderPaths);
		const sorted = Array.from(candidates).sort((a, b) => b.split('/').length - a.split('/').length);

		for (const path of sorted) {
			const folder = this.app.vault.getAbstractFileByPath(path);
			if (folder && folder instanceof TFolder) {
				if (folder.children.length > 0) {
					logger.debug(
						`Skipping cloud-deleted folder ${path} — still has ${folder.children.length} local children`
					);
					continue;
				}
				try {
					await this.app.fileManager.trashFile(folder);
					logger.debug(`Deleted local folder (cloud-deleted): ${path}`);
				} catch (error) {
					logger.warn(`Failed to delete local folder ${path}:`, error);
				}
			} else {
				// Config folders aren't in the vault index — delete via adapter
				const adapter = this.app.vault.adapter;
				try {
					if (await adapter.exists(path)) {
						const listing = await adapter.list(path);
						if (listing.files.length > 0 || listing.folders.length > 0) {
							logger.debug(
								`Skipping cloud-deleted config folder ${path} — still has local children`
							);
							continue;
						}
						await adapter.rmdir(path, false);
						logger.debug(`Deleted local config folder (cloud-deleted): ${path}`);
					}
				} catch (error) {
					logger.warn(`Failed to delete local config folder ${path}:`, error);
				}
			}
		}
	}

	/**
	 * Prune remote config folders (.obsidian/) left empty after local-driven
	 * file deletes. Config folders don't fire TFolder vault events, so
	 * processFolderChanges won't catch them. Only applies to .obsidian/ paths.
	 */
	private async pruneEmptyRemoteConfigFolders(operations: SyncOperation[]): Promise<void> {
		const configPrefix = `${normalizePath(this.configDir).replace(/\/+$/g, '')}/`;
		const candidateFolders = new Set<string>();
		for (const op of operations) {
			if (
				op.direction === SyncDirection.UPLOAD &&
				op.localState === undefined &&
				op.remoteState?.oneDriveId
			) {
				const parent = getParentPath(op.path);
				if (parent && parent.startsWith(configPrefix)) {
					candidateFolders.add(parent);
				}
			}
		}

		if (candidateFolders.size === 0) return;

		const sorted = Array.from(candidateFolders).sort(
			(a, b) => b.split('/').length - a.split('/').length
		);

		const adapter = this.app.vault.adapter;
		for (const folderPath of sorted) {
			try {
				const stat = await adapter.stat(folderPath);
				if (stat) continue;
			} catch {
				// stat threw — folder is gone
			}

			const folderId = this.stateManager.getFolderIdByPath(folderPath);
			if (!folderId) continue;

			try {
				await this.fileOps.deleteFile(folderId);
				this.stateManager.removeFolderStateByPath(folderPath);
				logger.info(`Deleted remote config folder (local folder gone): ${folderPath}`);
			} catch (error) {
				logger.warn(`Failed to delete remote config folder ${folderPath}:`, error);
			}
		}
	}

	/**
	 * Process explicit folder create/delete/rename events from the vault.
	 * Creates, deletes, or renames remote folders to match user intent.
	 */
	private async processFolderChanges(folderChanges: LocalChange[]): Promise<void> {
		if (folderChanges.length === 0) return;

		// Sort creates shallowest-first, deletes deepest-first
		const creates = folderChanges
			.filter((c) => c.type === LocalChangeType.FOLDER_CREATE)
			.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
		const deletes = folderChanges
			.filter((c) => c.type === LocalChangeType.FOLDER_DELETE)
			.sort((a, b) => b.path.split('/').length - a.path.split('/').length);
		const renames = folderChanges
			.filter((c) => c.type === LocalChangeType.FOLDER_RENAME && c.oldPath);

		// Process folder renames first — they might affect child file paths
		for (const change of renames) {
			const oldPath = change.oldPath!;
			const folderId = this.stateManager.getFolderIdByPath(oldPath);
			if (folderId) {
				try {
					const remotePath = this.vaultPathToRemotePath(change.path);
					logger.info(`Renaming remote folder: ${oldPath} → ${change.path}`);
					const movedItem = await this.fileOps.moveFile(folderId, remotePath);
					// Update folder state with new path
					this.stateManager.removeFolderStateByPath(oldPath);
					this.stateManager.setFolderState(movedItem.id, change.path);
					// Update file states for all children under the old path
					this.updateChildPathsAfterFolderRename(oldPath, change.path);
					logger.info(`Renamed remote folder: ${oldPath} → ${change.path}`);
				} catch (error) {
					logger.error(`Failed to rename remote folder ${oldPath} → ${change.path}:`, error);
				}
			} else {
				// Folder not tracked — may need to create it at the new path
				logger.warn(
					`Folder rename: no tracked state for ${oldPath} — ` +
					`creating folder at new path ${change.path} instead`
				);
				try {
					const remotePath = this.vaultPathToRemotePath(change.path);
					const item = await this.fileOps.createFolder(remotePath);
					this.stateManager.setFolderState(item.id, change.path);
					logger.info(`Created remote folder (from rename): ${change.path}`);
				} catch (error) {
					logger.warn(`Failed to create remote folder ${change.path}:`, error);
				}
			}
		}

		for (const change of creates) {
			try {
				const remotePath = this.vaultPathToRemotePath(change.path);
				const item = await this.fileOps.createFolder(remotePath);
				this.stateManager.setFolderState(item.id, change.path);
				logger.info(`Created remote folder: ${change.path}`);
			} catch (error) {
				logger.warn(`Failed to create remote folder ${change.path}:`, error);
			}
		}

		for (const change of deletes) {
			const folderId = this.stateManager.getFolderIdByPath(change.path);
			if (folderId) {
				try {
					await this.fileOps.deleteFile(folderId);
					this.stateManager.removeFolderStateByPath(change.path);
					logger.info(`Deleted remote folder: ${change.path}`);
				} catch (error) {
					logger.warn(`Failed to delete remote folder ${change.path}:`, error);
				}
			} else {
				// Folder not tracked (created before folder tracking existed) — look up by path
				try {
					const remotePath = this.vaultPathToRemotePath(change.path);
					await this.fileOps.deleteFileByPath(remotePath);
					logger.info(`Deleted remote folder (by path): ${change.path}`);
				} catch (error) {
					// 404 is fine — folder may not exist remotely
					logger.debug(
						`Could not delete remote folder by path ${change.path}: ${error instanceof Error ? error.message : error}`
					);
				}
			}
		}
	}

	/**
	 * Apply folder moves/renames detected on the remote (delta reported a
	 * folder at a new path we already had tracked under an old one) to the
	 * local vault, so other devices' local folder structure stays in sync
	 * without waiting for a full reconcile (issue #163).
	 *
	 * Processed shallowest-first so a parent move happens before any nested
	 * child move that landed in the same delta batch.
	 */
	private async applyRemoteFolderMoves(folderMoves: RemoteFolderMove[]): Promise<void> {
		const sorted = [...folderMoves].sort(
			(a, b) => a.oldPath.split('/').length - b.oldPath.split('/').length
		);

		for (const { oldPath, newPath } of sorted) {
			if (!oldPath || !newPath || oldPath === newPath) continue;

			const folder = this.app.vault.getAbstractFileByPath(oldPath);
			if (!(folder instanceof TFolder)) {
				// Nothing locally to move (e.g. this device never synced the
				// old folder) — the descendant files will simply be
				// downloaded to their new locations as normal remote changes.
				logger.debug(`Remote folder move ${oldPath} → ${newPath}: no local folder to move`);
				continue;
			}

			// Suppress the vault events this rename fires — both for the
			// folder itself (old and new path) and every tracked descendant
			// file (Obsidian's vault.rename recursively renames folder
			// contents) — so this doesn't get queued as a conflicting local
			// change.
			const oldPrefix = oldPath.endsWith('/') ? oldPath : `${oldPath}/`;
			const newPrefix = newPath.endsWith('/') ? newPath : `${newPath}/`;
			const descendants = this.stateManager.getFileStatesUnderFolder(oldPath);
			const ownWritePaths = [oldPath, newPath];
			for (const { path } of descendants) {
				ownWritePaths.push(path, newPrefix + path.slice(oldPrefix.length));
			}
			this.eventManager.markOwnWrites(ownWritePaths);

			try {
				await this.app.vault.rename(folder, newPath);
				this.updateChildPathsAfterFolderRename(oldPath, newPath);
				logger.info(`Applied remote folder move locally: ${oldPath} → ${newPath}`);
			} catch (error) {
				for (const path of ownWritePaths) {
					this.eventManager.removeOwnWrite(path);
				}
				logger.warn(
					`Failed to apply remote folder move ${oldPath} → ${newPath}: ${error instanceof Error ? error.message : error}`
				);
			}
		}
	}

	/**
	 * After renaming a folder on OneDrive, update all tracked file states
	 * that were under the old folder path to use the new folder path.
	 * This keeps local state in sync so subsequent syncs don't create duplicates.
	 */
	private updateChildPathsAfterFolderRename(oldFolderPath: string, newFolderPath: string): void {
		const oldPrefix = oldFolderPath.endsWith('/') ? oldFolderPath : `${oldFolderPath}/`;
		const newPrefix = newFolderPath.endsWith('/') ? newFolderPath : `${newFolderPath}/`;

		// Update file states
		const childFiles = this.stateManager.getFileStatesUnderFolder(oldFolderPath);
		for (const { path, state } of childFiles) {
			const newPath = newPrefix + path.slice(oldPrefix.length);
			this.stateManager.removeFileState(path);
			this.stateManager.setFileState(newPath, {
				...state,
				path: newPath,
			});
			logger.debug(`Updated file state path: ${path} → ${newPath}`);
		}

		// Update child folder states - collect first to avoid mutating while iterating
		const folderUpdates: Array<{ id: string; oldPath: string; newPath: string }> = [];
		for (const [id, folderPath] of this.stateManager.getAllFolderStates()) {
			if (folderPath.startsWith(oldPrefix)) {
				const newPath = newPrefix + folderPath.slice(oldPrefix.length);
				folderUpdates.push({ id, oldPath: folderPath, newPath });
			}
		}
		for (const { id, oldPath, newPath } of folderUpdates) {
			this.stateManager.removeFolderState(id);
			this.stateManager.setFolderState(id, newPath);
			logger.debug(`Updated folder state path: ${oldPath} → ${newPath}`);
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
		fullPath = this.realignRemoteRoot(fullPath);

		return toVaultPath(fullPath, this.remoteRootOnDrive);
	}

	private realignRemoteRoot(fullPath: string): string {
		const normalizedPath = normalizePath(fullPath);
		const normalizedRoot = normalizePath(this.remoteRootOnDrive);
		if (!normalizedRoot || normalizedPath.startsWith(normalizedRoot)) {
			return normalizedPath;
		}

		const rootSegments = normalizedRoot.split('/').filter((segment) => segment.length > 0);
		const rootName = rootSegments[rootSegments.length - 1];
		if (!rootName) {
			return normalizedPath;
		}

		const marker = `/${rootName}`;
		const markerIndex = normalizedPath.indexOf(marker);
		if (markerIndex < 0) {
			return normalizedPath;
		}

		const candidateRoot = normalizedPath.substring(0, markerIndex + marker.length);
		if (!candidateRoot || candidateRoot === normalizedRoot) {
			return normalizedPath;
		}

		logger.warn(
			`Adjusting remote root path from '${this.remoteRootOnDrive}' to '${candidateRoot}' based on delta item path`
		);
		this.remoteRootOnDrive = candidateRoot;
		return normalizedPath;
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
			progress(t('progress.listingCloud'));
			new Notice(t('notices.reconcile.listing'), 6000);
			const ignoreMatchers = await this.loadIgnoreMatchers();

			// 1. Enumerate the entire remote vault. listAllItems recurses
			// /children — it returns files AND folders. We only want files
			// for diffing.
			const allRemoteItems = await this.oneDriveClient.listAllItems(this.remoteRoot);
			logger.info(`Reconcile: enumerated ${allRemoteItems.length} remote items`);

			// 2. Build vaultPath -> OneDriveItem map for everything we'd sync.
			const remoteFiles = new Map<string, OneDriveItem>();
			for (const item of allRemoteItems) {
				const vaultPath = this.remotePathToVaultPath(item);
				if (!vaultPath) continue;
				if (item.folder) continue;
				if (!this.shouldSyncPath(vaultPath)) continue;
				if (this.shouldIgnorePath(vaultPath, ignoreMatchers)) continue;
				remoteFiles.set(vaultPath, item);
			}

			// 3. Snapshot local files we'd sync.
			const localFiles = this.app.vault
				.getFiles()
				.filter((f) => this.shouldSyncPath(f.path))
				.filter((f) => !this.shouldIgnorePath(f.path, ignoreMatchers));
			const localByPath = new Map<string, { path: string; size: number }>(
				localFiles.map((f) => [f.path, { path: f.path, size: f.stat.size }])
			);

			// Config files aren't in vault.getFiles() — add them via adapter
			const adapter = this.app.vault.adapter;
			const configPaths = await getAllSyncableConfigPaths(
				this.configDir,
				adapter,
				(path) => this.shouldSyncPath(path)
			);
			for (const path of configPaths) {
				if (localByPath.has(path)) continue;
				if (!this.shouldSyncPath(path)) continue;
				if (this.shouldIgnorePath(path, ignoreMatchers)) continue;
				try {
					const stat = await adapter.stat(path);
					if (stat && stat.type === 'file') {
						localByPath.set(path, { path, size: stat.size });
					}
				} catch {
					// file doesn't exist, skip
				}
			}

			// 4. Wipe tracked file states so ghosts from previously-deleted
			//    files don't survive the reconcile. Fresh state is rebuilt
			//    below from the cloud listing + operation execution.
			this.stateManager.clearFileStates();

			// 5. Plan operations.
			const operations: SyncOperation[] = [];
			const localOnly: string[] = [];
			const remoteOnly: string[] = [];
			const sizeMismatch: string[] = [];

			for (const [path] of localByPath) {
				if (!remoteFiles.has(path)) {
					localOnly.push(path);
					// Encoded as a remote→local delete (download direction, no remoteState).
					operations.push({
						path,
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
					// Same-size files are verified via sha1 when the remote item
					// carries a hash; without one we assume same content.
					const contentMatches =
						local.size === remoteSize
							? await this.localContentMatchesRemote(path, item)
							: false;
					if (contentMatches === false) {
						sizeMismatch.push(path);
						operations.push({
							path,
							direction: SyncDirection.DOWNLOAD,
							remoteState: this.itemToFileState(item),
						});
					} else {
						// Content matches (or no hash to compare) — refresh tracked state.
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
			if (threshold > 0 && localOnly.length >= threshold && this.largeDeleteWarningHandler) {
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
					new Notice(t('notices.reconcile.cancelled'));
					return;
				}
			}

			if (operations.length === 0) {
				logger.info('Reconcile: nothing to do — local already matches cloud');
				new Notice(t('notices.reconcile.alreadyInSync'));
				return;
			}

			// 6. Execute.
			let completed = 0;
			progress(t('progress.files', { completed: 0, total: operations.length }));
			const progressNotice = new ProgressNotice(t('progress.reconciling'), operations.length);
			const failures = await this.executeOperations(operations, () => {
				completed++;
				const label = t('progress.files', { completed, total: operations.length });
				progress(label);
				progressNotice.update(completed, t('progress.reconciling'));
			});
			progressNotice.hide();
			progress(undefined);
			if (failures.length > 0) {
				throw new Error(`Reconcile failed for ${failures.length} operation(s)`);
			}

			// 7. Local file event listeners may have queued dirty entries while
			// we were downloading. Clear them — we just authoritatively synced
			// from cloud, anything pending is stale.
			this.eventManager.clearDirtyFiles();

			// 8. Advance delta cursors so the next normal sync starts clean.
			progress(t('progress.advancingDeltaCursor'));
			try {
				const shouldSyncObsidianScope =
					this.shouldSyncPath(`${this.configDir}/community-plugins.json`) ||
					this.shouldSyncPath(`${this.configDir}/app.json`);
				// The two delta streams are independent — fetch them in parallel
				const [newDelta, newObs] = await Promise.all([
					this.oneDriveClient.getDelta(undefined, this.remoteRoot),
					shouldSyncObsidianScope
						? this.oneDriveClient.getDelta(undefined, this.remoteRoot, this.configDir)
						: Promise.resolve(undefined),
				]);
				this.stateManager.setDeltaLink(newDelta.deltaLink, true);
				if (newObs) {
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
				t('notices.reconcile.complete', {
					downloaded: remoteOnly.length,
					deleted: localOnly.length,
					refreshed: sizeMismatch.length,
				})
			);
		} catch (error) {
			logger.error('Reconcile from cloud failed:', error);
			new Notice(t('notices.reconcile.failed', { message: String(error) }));
			throw error;
		}
	}
}
