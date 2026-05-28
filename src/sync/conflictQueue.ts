/**
 * Conflict queue — stores pending conflicts for manual resolution.
 * Metadata is persisted in plugin settings; file content is stored
 * as sidecar files in the plugin data directory.
 */

import { App, TFile } from 'obsidian';
import { ConflictEntry, ConflictResolution, PersistedConflictQueue } from '../types';
import { logger } from '../utils/logger';
import { createConflictFileName, isTextExtension } from '../utils/pathUtils';
import { EventManager } from './eventManager';
import { SyncStateManager } from './syncState';

const CONFLICTS_DIR = '.obsidian/plugins/obsidian-onedrive/conflicts';

export class ConflictQueue {
	private entries: Map<string, ConflictEntry> = new Map();

	constructor(
		private app: App,
		private stateManager: SyncStateManager,
		private eventManager: EventManager
	) {}

	/**
	 * Load persisted conflict queue metadata
	 */
	load(data?: PersistedConflictQueue): void {
		this.entries.clear();
		if (!data?.entries) return;
		for (const entry of data.entries) {
			this.entries.set(entry.id, entry);
		}
		logger.debug(`Loaded ${this.entries.size} conflict queue entries`);
	}

	/**
	 * Prepare for persistence (metadata only)
	 */
	prepareForSave(): PersistedConflictQueue {
		return { entries: Array.from(this.entries.values()) };
	}

	/**
	 * Queue a new conflict. Stores local + remote content as sidecar files.
	 * If a conflict for the same path already exists, updates it.
	 */
	async add(
		path: string,
		localContent: ArrayBuffer,
		remoteContent: ArrayBuffer,
		localMtime: number,
		remoteMtime: number,
		remoteOneDriveId: string,
		remoteHash: string
	): Promise<ConflictEntry> {
		// Deduplicate by path — update existing entry
		const existing = this.getByPath(path);
		if (existing) {
			logger.info(`Updating existing conflict for ${path}`);
			await this.removeContentFiles(existing.id);
			this.entries.delete(existing.id);
		}

		const id = this.generateId();
		const isText = isTextExtension(path);
		const entry: ConflictEntry = {
			id,
			path,
			localModifiedTime: localMtime,
			remoteModifiedTime: remoteMtime,
			localSize: localContent.byteLength,
			remoteSize: remoteContent.byteLength,
			remoteOneDriveId,
			remoteHash,
			createdAt: Date.now(),
			isTextFile: isText,
		};

		// Store content as sidecar files
		const adapter = this.app.vault.adapter;
		const dir = `${CONFLICTS_DIR}/${id}`;
		await adapter.mkdir(dir);
		await adapter.writeBinary(`${dir}/current`, localContent);
		await adapter.writeBinary(`${dir}/incoming`, remoteContent);

		this.entries.set(id, entry);
		logger.info(`Queued conflict for ${path} (id=${id}, isText=${isText})`);
		return entry;
	}

	/**
	 * Read the "current" (local) content for a conflict
	 */
	async readCurrentContent(id: string): Promise<ArrayBuffer> {
		return this.app.vault.adapter.readBinary(`${CONFLICTS_DIR}/${id}/current`);
	}

	/**
	 * Read the "incoming" (remote) content for a conflict
	 */
	async readIncomingContent(id: string): Promise<ArrayBuffer> {
		return this.app.vault.adapter.readBinary(`${CONFLICTS_DIR}/${id}/incoming`);
	}

	/**
	 * Resolve a single conflict
	 */
	async resolve(id: string, resolution: ConflictResolution): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) {
			logger.warn(`Conflict ${id} not found`);
			return;
		}

		logger.info(`Resolving conflict ${id} (${entry.path}) with ${resolution}`);

		switch (resolution) {
			case ConflictResolution.ACCEPT_CURRENT:
				await this.applyCurrent(entry);
				break;
			case ConflictResolution.ACCEPT_INCOMING:
				await this.applyIncoming(entry);
				break;
			case ConflictResolution.ACCEPT_BOTH:
				await this.applyBoth(entry);
				break;
		}

		await this.removeEntry(id);
	}

	/**
	 * Resolve all conflicts with the same resolution
	 */
	async resolveAll(resolution: ConflictResolution): Promise<void> {
		const ids = Array.from(this.entries.keys());
		for (const id of ids) {
			await this.resolve(id, resolution);
		}
	}

	/**
	 * Get all pending conflict entries
	 */
	getAll(): ConflictEntry[] {
		return Array.from(this.entries.values());
	}

	/**
	 * Get entry by path
	 */
	getByPath(path: string): ConflictEntry | undefined {
		for (const entry of this.entries.values()) {
			if (entry.path === path) return entry;
		}
		return undefined;
	}

	/**
	 * Check if a path has a pending conflict
	 */
	hasConflict(path: string): boolean {
		return this.getByPath(path) !== undefined;
	}

	/**
	 * Number of pending conflicts
	 */
	get count(): number {
		return this.entries.size;
	}

	/**
	 * Accept Current Change — keep local version, mark dirty for upload
	 */
	private async applyCurrent(entry: ConflictEntry): Promise<void> {
		// Local file is already in the vault — just mark it dirty so next sync uploads it
		this.eventManager.addDirtyFile(entry.path, 'modify');
		logger.debug(`Accepted current for ${entry.path} — marked dirty for upload`);
	}

	/**
	 * Accept Incoming Change — overwrite local with remote content
	 */
	private async applyIncoming(entry: ConflictEntry): Promise<void> {
		const content = await this.readIncomingContent(entry.id);
		const adapter = this.app.vault.adapter;

		this.eventManager.markOwnWrites([entry.path]);
		await adapter.writeBinary(entry.path, content);

		// Update sync state to match remote
		const file = this.app.vault.getAbstractFileByPath(entry.path);
		const localMtime = file instanceof TFile ? file.stat.mtime : Date.now();
		this.stateManager.setFileState(entry.path, {
			path: entry.path,
			localMtime,
			remoteHash: entry.remoteHash,
			size: content.byteLength,
			remoteModifiedTime: entry.remoteModifiedTime,
			oneDriveId: entry.remoteOneDriveId,
		});

		logger.debug(`Accepted incoming for ${entry.path} — wrote remote content`);
	}

	/**
	 * Accept Both — keep local file as-is, create duplicate with remote content
	 */
	private async applyBoth(entry: ConflictEntry): Promise<void> {
		const content = await this.readIncomingContent(entry.id);
		const conflictPath = createConflictFileName(entry.path);
		const adapter = this.app.vault.adapter;

		this.eventManager.markOwnWrites([conflictPath]);
		await adapter.writeBinary(conflictPath, content);

		// Mark local file dirty for upload
		this.eventManager.addDirtyFile(entry.path, 'modify');
		// Mark conflict copy dirty for upload too
		this.eventManager.addDirtyFile(conflictPath, 'create');

		logger.debug(`Accepted both for ${entry.path} — created ${conflictPath}`);
	}

	/**
	 * Remove a conflict entry and its sidecar files
	 */
	private async removeEntry(id: string): Promise<void> {
		await this.removeContentFiles(id);
		this.entries.delete(id);
	}

	/**
	 * Clean up sidecar content files for a conflict
	 */
	private async removeContentFiles(id: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		const dir = `${CONFLICTS_DIR}/${id}`;
		try {
			if (await adapter.exists(`${dir}/current`)) await adapter.remove(`${dir}/current`);
			if (await adapter.exists(`${dir}/incoming`)) await adapter.remove(`${dir}/incoming`);
			if (await adapter.exists(dir)) await adapter.rmdir(dir, false);
		} catch (error) {
			logger.warn(`Failed to clean up conflict files for ${id}:`, error);
		}
	}

	private generateId(): string {
		return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}
}
