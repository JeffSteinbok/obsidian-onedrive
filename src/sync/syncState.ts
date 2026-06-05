/**
 * Sync state tracking and persistence
 */

import { SyncState, FileState } from '../types';
import { logger } from '../utils/logger';

/**
 * Manages sync state (last sync time, file states, delta token)
 */
export class SyncStateManager {
	private state: SyncState;

	constructor() {
		this.state = {
			lastSyncTime: 0,
			fileStates: new Map(),
			folderStates: new Map(),
		};
	}

	/**
	 * Load state from persisted data
	 */
	loadState(data?: {
		lastSyncTime: number;
		fileStates: Array<[string, FileState]>;
		folderStates?: Array<[string, string]>;
		deltaLink?: string;
		obsidianDeltaLink?: string;
	}): void {
		if (!data) {
			this.state = {
				lastSyncTime: 0,
				fileStates: new Map(),
				folderStates: new Map(),
			};
			return;
		}

		this.state = {
			lastSyncTime: data.lastSyncTime,
			fileStates: new Map(data.fileStates),
			folderStates: new Map(data.folderStates || []),
			deltaLink: data.deltaLink,
			obsidianDeltaLink: data.obsidianDeltaLink,
		};

		logger.debug('Sync state loaded', {
			lastSyncTime: new Date(data.lastSyncTime).toISOString(),
			fileCount: this.state.fileStates.size,
			folderCount: this.state.folderStates.size,
			hasDeltaLink: !!data.deltaLink,
			hasObsidianDeltaLink: !!data.obsidianDeltaLink,
		});
	}

	/**
	 * Prepare state for persistence
	 */
	prepareForSave(): {
		lastSyncTime: number;
		fileStates: Array<[string, FileState]>;
		folderStates: Array<[string, string]>;
		deltaLink?: string;
		obsidianDeltaLink?: string;
	} {
		return {
			lastSyncTime: this.state.lastSyncTime,
			fileStates: Array.from(this.state.fileStates.entries()),
			folderStates: Array.from(this.state.folderStates.entries()),
			deltaLink: this.state.deltaLink,
			obsidianDeltaLink: this.state.obsidianDeltaLink,
		};
	}

	/**
	 * Get last sync time
	 */
	getLastSyncTime(): number {
		return this.state.lastSyncTime;
	}

	/**
	 * Update last sync time
	 */
	setLastSyncTime(time: number): void {
		this.state.lastSyncTime = time;
		logger.debug('Last sync time updated:', new Date(time).toISOString());
	}

	/**
	 * Get delta link for incremental sync
	 */
	getDeltaLink(): string | undefined {
		return this.state.deltaLink;
	}

	/**
	 * Set delta link after sync
	 */
	setDeltaLink(deltaLink: string): void {
		this.state.deltaLink = deltaLink;
	}

	/**
	 * Get .obsidian delta link for incremental sync
	 */
	getObsidianDeltaLink(): string | undefined {
		return this.state.obsidianDeltaLink;
	}

	/**
	 * Set .obsidian delta link after sync
	 */
	setObsidianDeltaLink(deltaLink: string): void {
		this.state.obsidianDeltaLink = deltaLink;
	}

	/**
	 * Get file state
	 */
	getFileState(path: string): FileState | undefined {
		return this.state.fileStates.get(path);
	}

	/**
	 * Set file state
	 */
	setFileState(path: string, state: FileState): void {
		this.state.fileStates.set(path, state);
	}

	/**
	 * Remove file state
	 */
	removeFileState(path: string): void {
		this.state.fileStates.delete(path);
	}

	/**
	 * Get all file paths tracked
	 */
	getTrackedPaths(): string[] {
		return Array.from(this.state.fileStates.keys());
	}

	/**
	 * Reverse-resolve a OneDrive item id to the vault path it is currently
	 * tracked under. Microsoft Graph delta returns deleted items with only
	 * an id — no name, no parentReference — so the only way to know which
	 * local file the deletion refers to is via the id we recorded when the
	 * file was last uploaded or downloaded.
	 */
	getPathByOneDriveId(oneDriveId: string): string | undefined {
		if (!oneDriveId) return undefined;
		for (const [path, state] of this.state.fileStates) {
			if (state.oneDriveId === oneDriveId) return path;
		}
		return undefined;
	}

	/**
	 * Record (or update) a folder we know about by its OneDrive id. Tracking
	 * folders lets us reverse-resolve folder-delete delta entries — which
	 * arrive with only an id, just like file deletes — into a vault path so
	 * we can synthesize per-file deletes for everything beneath that folder.
	 */
	setFolderState(oneDriveId: string, vaultPath: string): void {
		if (!oneDriveId) return;
		this.state.folderStates.set(oneDriveId, vaultPath);
	}

	getFolderPathById(oneDriveId: string): string | undefined {
		if (!oneDriveId) return undefined;
		return this.state.folderStates.get(oneDriveId);
	}

	removeFolderState(oneDriveId: string): void {
		this.state.folderStates.delete(oneDriveId);
	}

	/**
	 * Return tracked file states whose path lives under the given folder path.
	 * Matches direct children and any deeper descendants. Used to expand a
	 * single folder-delete delta entry into per-file delete operations.
	 */
	getFileStatesUnderFolder(folderPath: string): Array<{ path: string; state: FileState }> {
		const prefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
		const results: Array<{ path: string; state: FileState }> = [];
		for (const [path, state] of this.state.fileStates) {
			if (path.startsWith(prefix)) results.push({ path, state });
		}
		return results;
	}

	/**
	 * Check if this is the first sync (no state yet)
	 */
	isFirstSync(): boolean {
		return this.state.lastSyncTime === 0;
	}

	/**
	 * Reset for a full re-scan. Clears delta cursors (main + .obsidian),
	 * fileStates and lastSyncTime so the next sync re-reads everything from
	 * server and recomputes local↔remote correspondences from scratch.
	 *
	 * Note: cleared state means etag/hash checks will not short-circuit, so
	 * size-match heuristics in the first-sync planner will be used to avoid
	 * unnecessary re-downloads.
	 */
	clearDeltaLink(): void {
		this.state = {
			lastSyncTime: 0,
			fileStates: new Map(),
			folderStates: new Map(),
		};
		logger.debug('Sync reset — cleared delta links, file states, and last sync time');
	}

	/**
	 * Clear all state
	 */
	clearState(): void {
		this.state = {
			lastSyncTime: 0,
			fileStates: new Map(),
			folderStates: new Map(),
		};
		logger.debug('Sync state cleared');
	}
}
