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
		};
	}

	/**
	 * Load state from persisted data
	 */
	loadState(data?: {
		lastSyncTime: number;
		fileStates: Array<[string, FileState]>;
		deltaLink?: string;
		obsidianDeltaLink?: string;
	}): void {
		if (!data) {
			this.state = {
				lastSyncTime: 0,
				fileStates: new Map(),
			};
			return;
		}

		this.state = {
			lastSyncTime: data.lastSyncTime,
			fileStates: new Map(data.fileStates),
			deltaLink: data.deltaLink,
			obsidianDeltaLink: data.obsidianDeltaLink,
		};

		logger.debug('Sync state loaded', {
			lastSyncTime: new Date(data.lastSyncTime).toISOString(),
			fileCount: this.state.fileStates.size,
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
		deltaLink?: string;
		obsidianDeltaLink?: string;
	} {
		return {
			lastSyncTime: this.state.lastSyncTime,
			fileStates: Array.from(this.state.fileStates.entries()),
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
	 * Check if this is the first sync (no state yet)
	 */
	isFirstSync(): boolean {
		return this.state.lastSyncTime === 0;
	}

	/**
	 * Clear all state
	 */
	clearState(): void {
		this.state = {
			lastSyncTime: 0,
			fileStates: new Map(),
		};
		logger.debug('Sync state cleared');
	}
}
