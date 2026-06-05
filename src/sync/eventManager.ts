/**
 * Sync manager
 * Tracks dirty files from vault events and triggers debounced sync.
 * Uses deterministic suppression (not timing) to avoid reacting to
 * our own writes or Obsidian's startup file indexing.
 */

import { App, TFile, EventRef } from 'obsidian';
import { LocalChange, LocalChangeType } from '../types';
import { SyncStateManager } from './syncState';
import { logger } from '../utils/logger';
import { SYNC_CONFIG } from '../constants';
import { shouldSyncVaultPath } from '../utils/pathUtils';

const timerApi = typeof window !== 'undefined' ? window : globalThis;

/**
 * Manages vault event listeners and sync scheduling
 */
export class EventManager {
	private eventRefs: EventRef[] = [];
	private throttleTimer?: ReturnType<typeof globalThis.setTimeout>;
	private syncTimer?: ReturnType<typeof globalThis.setInterval>;
	private isSyncing = false;
	private dirtyFiles: Map<string, LocalChange> = new Map();
	// Paths we wrote during sync — events for these are our own writes, not user edits
	private ownWritePaths: Set<string> = new Set();

	constructor(
		private app: App,
		private onSyncTriggered: () => Promise<void>,
		private stateManager: SyncStateManager,
		private shouldSyncPath: (path: string) => boolean = (path) => shouldSyncVaultPath(path)
	) {}

	private shouldIgnoreEvent(path: string): boolean {
		if (!this.shouldSyncPath(path)) return true;

		// If we wrote this path during sync, ignore the resulting event
		if (this.ownWritePaths.has(path)) {
			this.ownWritePaths.delete(path);
			logger.debug(`Ignoring own-write event for: ${path}`);
			return true;
		}

		return false;
	}

	/**
	 * Mark paths as written by us (so we ignore the resulting vault events)
	 */
	markOwnWrites(paths: string[]): void {
		for (const path of paths) {
			this.ownWritePaths.add(path);
		}
	}

	/**
	 * Remove a path from own-write suppression (e.g., if write failed)
	 */
	removeOwnWrite(path: string): void {
		this.ownWritePaths.delete(path);
	}

	/**
	 * Get dirty files without clearing them.
	 * Call clearDirtyFiles() after successful sync.
	 */
	getDirtyFiles(): LocalChange[] {
		return Array.from(this.dirtyFiles.values());
	}

	/**
	 * Clear all dirty files (call after successful sync)
	 */
	clearDirtyFiles(): void {
		this.dirtyFiles.clear();
	}

	/**
	 * Remove specific paths from the dirty set (e.g., files we just downloaded)
	 */
	removeDirtyPaths(paths: string[]): void {
		for (const path of paths) {
			this.dirtyFiles.delete(path);
		}
	}

	/**
	 * Manually add a dirty file (e.g., after conflict resolution)
	 */
	addDirtyFile(path: string, type: 'modify' | 'create'): void {
		const changeType = type === 'create' ? LocalChangeType.CREATE : LocalChangeType.MODIFY;
		this.dirtyFiles.set(path, { path, type: changeType });
	}

	/**
	 * Start listening to vault events
	 */
	startListening(): void {
		logger.info('Starting vault event listeners');

		this.eventRefs.push(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile && !this.shouldIgnoreEvent(file.path)) {
					this.dirtyFiles.set(file.path, { path: file.path, type: LocalChangeType.MODIFY });
					this.scheduleSync();
				}
			})
		);

		this.eventRefs.push(
			this.app.vault.on('create', (file) => {
				if (file instanceof TFile && !this.shouldIgnoreEvent(file.path)) {
					// If file is already tracked in sync state, this is Obsidian
					// re-indexing on startup — not a real new file
					if (this.stateManager.getFileState(file.path)) {
						logger.debug(`Ignoring startup create event for known file: ${file.path}`);
						return;
					}
					this.dirtyFiles.set(file.path, { path: file.path, type: LocalChangeType.CREATE });
					this.scheduleSync();
				}
			})
		);

		this.eventRefs.push(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile && !this.shouldIgnoreEvent(file.path)) {
					this.dirtyFiles.set(file.path, { path: file.path, type: LocalChangeType.DELETE });
					this.scheduleSync();
				}
			})
		);

		this.eventRefs.push(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && !this.shouldIgnoreEvent(file.path)) {
					this.dirtyFiles.delete(oldPath);
					this.dirtyFiles.set(file.path, {
						path: file.path,
						type: LocalChangeType.RENAME,
						oldPath,
					});
					this.scheduleSync();
				}
			})
		);

		logger.info('Event listeners registered');
	}

	/**
	 * Schedule a debounced sync (trailing edge)
	 */
	private scheduleSync(): void {
		if (this.isSyncing) return;

		if (this.throttleTimer !== undefined) {
			timerApi.clearTimeout(this.throttleTimer);
		}

		this.throttleTimer = timerApi.setTimeout(() => {
			void this.executeSync();
		}, SYNC_CONFIG.EVENT_THROTTLE_MS);
	}

	/**
	 * Start periodic sync at the given interval (minutes). 0 = disabled.
	 */
	startPeriodicSync(intervalMinutes: number): void {
		this.stopPeriodicSync();

		if (intervalMinutes <= 0) {
			logger.info('Periodic sync disabled');
			return;
		}

		const intervalMs = intervalMinutes * 60 * 1000;
		logger.info(`Starting periodic sync every ${intervalMinutes} minutes`);

		this.syncTimer = timerApi.setInterval(() => {
			if (!this.isSyncing) {
				void this.executeSync();
			}
		}, intervalMs);
	}

	/**
	 * Stop periodic sync
	 */
	stopPeriodicSync(): void {
		if (this.syncTimer !== undefined) {
			timerApi.clearInterval(this.syncTimer);
			this.syncTimer = undefined;
		}
	}

	/**
	 * Stop listening to vault events and periodic sync
	 */
	stopListening(): void {
		logger.info('Stopping event listeners');

		this.stopPeriodicSync();

		if (this.throttleTimer !== undefined) {
			timerApi.clearTimeout(this.throttleTimer);
			this.throttleTimer = undefined;
		}

		this.eventRefs.forEach((ref) => {
			this.app.vault.offref(ref);
		});
		this.eventRefs = [];

		logger.info('Event listeners stopped');
	}

	/**
	 * Execute sync operation
	 */
	private async executeSync(): Promise<void> {
		this.isSyncing = true;

		try {
			await this.onSyncTriggered();
		} catch (error) {
			logger.error('Error during sync:', error);
		} finally {
			this.isSyncing = false;
		}
	}

	/**
	 * Trigger immediate sync (manual or startup)
	 */
	async triggerManualSync(): Promise<void> {
		logger.info('Manual sync triggered');

		if (this.isSyncing) {
			logger.debug('Sync already in progress, skipping');
			return;
		}

		await this.executeSync();
	}

	/**
	 * Check if sync is currently in progress
	 */
	isSyncInProgress(): boolean {
		return this.isSyncing;
	}
}
