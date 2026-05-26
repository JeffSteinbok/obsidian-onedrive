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

/**
 * Manages vault event listeners and sync scheduling
 */
export class EventManager {
private eventRefs: EventRef[] = [];
private throttleTimer?: NodeJS.Timeout;
private syncTimer?: number;
private isSyncing = false;
private dirtyFiles: Map<string, LocalChange> = new Map();
// Paths we wrote during sync — events for these are our own writes, not user edits
private ownWritePaths: Set<string> = new Set();

constructor(
private app: App,
private onSyncTriggered: () => Promise<void>,
private stateManager: SyncStateManager
) {}

private shouldIgnoreEvent(path: string): boolean {
if (path.startsWith('.obsidian/')) return true;

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
 * Get and clear dirty files since last sync
 */
getDirtyFiles(): LocalChange[] {
const changes = Array.from(this.dirtyFiles.values());
this.dirtyFiles.clear();
return changes;
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

if (this.throttleTimer) {
clearTimeout(this.throttleTimer);
}

this.throttleTimer = setTimeout(() => {
this.executeSync();
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

this.syncTimer = window.setInterval(() => {
if (!this.isSyncing) {
this.executeSync();
}
}, intervalMs);
}

/**
 * Stop periodic sync
 */
stopPeriodicSync(): void {
if (this.syncTimer !== undefined) {
window.clearInterval(this.syncTimer);
this.syncTimer = undefined;
}
}

/**
 * Stop listening to vault events and periodic sync
 */
stopListening(): void {
logger.info('Stopping event listeners');

this.stopPeriodicSync();

if (this.throttleTimer) {
clearTimeout(this.throttleTimer);
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
