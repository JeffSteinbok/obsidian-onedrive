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
	// Reverse indexes kept in sync with fileStates/folderStates so hot-path
	// lookups (delta delete resolution, folder discovery) stay O(1) instead
	// of scanning every tracked entry.
	private oneDriveIdToPath: Map<string, string> = new Map();
	private folderPathToId: Map<string, string> = new Map();

	constructor() {
		this.state = {
			lastSyncTime: 0,
			fileStates: new Map(),
			folderStates: new Map(),
		};
	}

	/**
	 * Rebuild both reverse indexes from the primary maps.
	 */
	private rebuildIndexes(): void {
		this.oneDriveIdToPath.clear();
		this.folderPathToId.clear();
		for (const [path, state] of this.state.fileStates) {
			if (state.oneDriveId) this.oneDriveIdToPath.set(state.oneDriveId, path);
		}
		for (const [id, path] of this.state.folderStates) {
			this.folderPathToId.set(path, id);
		}
	}

	/**
	 * Load state from persisted data
	 */
	loadState(data?: {
		lastSyncTime: number;
		fileStates: Array<[string, FileState]>;
		folderStates?: Array<[string, string]>;
		deltaLink?: string;
		deltaLinkScoped?: boolean;
		obsidianDeltaLink?: string;
	}): void {
		if (!data) {
			this.state = {
				lastSyncTime: 0,
				fileStates: new Map(),
				folderStates: new Map(),
			};
			this.rebuildIndexes();
			return;
		}

		this.state = {
			lastSyncTime: data.lastSyncTime,
			fileStates: new Map(data.fileStates),
			folderStates: new Map(data.folderStates || []),
			deltaLink: data.deltaLink,
			deltaLinkScoped: data.deltaLinkScoped,
			obsidianDeltaLink: data.obsidianDeltaLink,
		};
		this.rebuildIndexes();

		logger.debug('Sync state loaded', {
			lastSyncTime: new Date(data.lastSyncTime).toISOString(),
			fileCount: this.state.fileStates.size,
			folderCount: this.state.folderStates.size,
			hasDeltaLink: !!data.deltaLink,
			deltaLinkScoped: !!data.deltaLinkScoped,
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
		deltaLinkScoped?: boolean;
		obsidianDeltaLink?: string;
	} {
		return {
			lastSyncTime: this.state.lastSyncTime,
			fileStates: Array.from(this.state.fileStates.entries()),
			folderStates: Array.from(this.state.folderStates.entries()),
			deltaLink: this.state.deltaLink,
			deltaLinkScoped: this.state.deltaLinkScoped,
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
	 * Set delta link after sync.
	 *
	 * @param deltaLink The cursor returned by the delta API.
	 * @param scoped Whether this cursor was produced by the app-folder scoped
	 *   query. Post-fix callers pass true so legacy wide cursors (which lack the
	 *   flag) can be detected and reset once. See issue #97.
	 */
	setDeltaLink(deltaLink: string, scoped = false): void {
		this.state.deltaLink = deltaLink;
		this.state.deltaLinkScoped = scoped;
	}

	/**
	 * Whether the stored main delta cursor is known to be subfolder-scoped.
	 * False for legacy cursors minted before the issue #97 fix.
	 */
	isDeltaLinkScoped(): boolean {
		return this.state.deltaLinkScoped === true;
	}

	/**
	 * Drop the main delta cursor so the next sync starts a fresh (scoped)
	 * stream. Used to retire a legacy, unscoped app-folder cursor without
	 * wiping tracked file/folder state.
	 */
	resetDeltaLink(): void {
		this.state.deltaLink = undefined;
		this.state.deltaLinkScoped = false;
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
		const previous = this.state.fileStates.get(path);
		if (
			previous?.oneDriveId &&
			previous.oneDriveId !== state.oneDriveId &&
			this.oneDriveIdToPath.get(previous.oneDriveId) === path
		) {
			this.oneDriveIdToPath.delete(previous.oneDriveId);
		}
		this.state.fileStates.set(path, state);
		if (state.oneDriveId) {
			this.oneDriveIdToPath.set(state.oneDriveId, path);
		}
	}

	/**
	 * Remove file state
	 */
	removeFileState(path: string): void {
		const previous = this.state.fileStates.get(path);
		if (previous?.oneDriveId && this.oneDriveIdToPath.get(previous.oneDriveId) === path) {
			this.oneDriveIdToPath.delete(previous.oneDriveId);
		}
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
		return this.oneDriveIdToPath.get(oneDriveId);
	}

	/**
	 * Record (or update) a folder we know about by its OneDrive id. Tracking
	 * folders lets us reverse-resolve folder-delete delta entries — which
	 * arrive with only an id, just like file deletes — into a vault path so
	 * we can synthesize per-file deletes for everything beneath that folder.
	 */
	setFolderState(oneDriveId: string, vaultPath: string): void {
		if (!oneDriveId) return;
		const previousPath = this.state.folderStates.get(oneDriveId);
		if (
			previousPath &&
			previousPath !== vaultPath &&
			this.folderPathToId.get(previousPath) === oneDriveId
		) {
			this.folderPathToId.delete(previousPath);
		}
		this.state.folderStates.set(oneDriveId, vaultPath);
		this.folderPathToId.set(vaultPath, oneDriveId);
	}

	getFolderPathById(oneDriveId: string): string | undefined {
		if (!oneDriveId) return undefined;
		return this.state.folderStates.get(oneDriveId);
	}

	removeFolderState(oneDriveId: string): void {
		const path = this.state.folderStates.get(oneDriveId);
		if (path !== undefined && this.folderPathToId.get(path) === oneDriveId) {
			this.folderPathToId.delete(path);
		}
		this.state.folderStates.delete(oneDriveId);
	}

	/**
	 * Reverse-resolve a vault folder path to its OneDrive item id.
	 */
	getFolderIdByPath(vaultPath: string): string | undefined {
		return this.folderPathToId.get(vaultPath);
	}

	/**
	 * Remove a folder state entry by its vault path.
	 */
	removeFolderStateByPath(vaultPath: string): void {
		const id = this.folderPathToId.get(vaultPath);
		if (id === undefined) return;
		this.folderPathToId.delete(vaultPath);
		this.state.folderStates.delete(id);
	}

	/**
	 * Return all folder states as [id, path] entries.
	 * Used to update child folder paths after a parent folder rename.
	 */
	getAllFolderStates(): IterableIterator<[string, string]> {
		return this.state.folderStates.entries();
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
		// Alias for clearState() - kept for backwards compatibility
		this.clearState();
	}

	/**
	 * Clear all state (delta links, file states, folder states, last sync time).
	 * Use when resetting sync or switching remote paths.
	 */
	clearState(): void {
		this.state = {
			lastSyncTime: 0,
			fileStates: new Map(),
			folderStates: new Map(),
		};
		this.rebuildIndexes();
		logger.debug('Sync state cleared');
	}

	/** Wipe all tracked file states but keep folder states and delta link. */
	clearFileStates(): void {
		this.state.fileStates.clear();
		this.oneDriveIdToPath.clear();
		logger.debug('Tracked file states cleared');
	}
}
