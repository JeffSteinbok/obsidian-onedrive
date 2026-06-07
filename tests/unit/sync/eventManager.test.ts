import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockApp, makeTFile, makeTFolder } from '../../setup';

vi.mock('../../../src/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../src/constants', () => ({
	SYNC_CONFIG: { EVENT_THROTTLE_MS: 100 },
}));

import { EventManager } from '../../../src/sync/eventManager';
import { SyncStateManager } from '../../../src/sync/syncState';
import { LocalChangeType, type FileState } from '../../../src/types';
import { shouldSyncVaultPath } from '../../../src/utils/pathUtils';

function makeFileState(path: string): FileState {
	return {
		path,
		localMtime: Date.now(),
		remoteHash: `hash-${path}`,
		size: 100,
		remoteModifiedTime: Date.now(),
	};
}

function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});

	return { promise, resolve };
}

describe('EventManager', () => {
	let eventManager: EventManager;
	let stateManager: SyncStateManager;
	let onSyncTriggered: ReturnType<typeof vi.fn> & (() => Promise<void>);
	let eventCallbacks: Record<string, Function>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('window', {
			setTimeout: globalThis.setTimeout,
			clearTimeout: globalThis.clearTimeout,
			setInterval: globalThis.setInterval,
			clearInterval: globalThis.clearInterval,
		});

		eventCallbacks = {};
		mockApp.vault.on.mockImplementation((event: string, callback: Function) => {
			eventCallbacks[event] = callback;
			return { id: `ref-${event}` };
		});

		stateManager = new SyncStateManager();
		onSyncTriggered = vi.fn().mockResolvedValue(undefined);
		eventManager = new EventManager(mockApp as any, onSyncTriggered, stateManager);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	describe('dirty file tracking', () => {
		it('adds modify events to dirty files', () => {
			eventManager.startListening();
			const file = makeTFile('test.md', 100);

			eventCallbacks.modify(file);

			expect(eventManager.getDirtyFiles()).toEqual([
				{ path: 'test.md', type: LocalChangeType.MODIFY },
			]);
		});

		it('adds create events to dirty files', () => {
			eventManager.startListening();
			const file = makeTFile('created.md', 100);

			eventCallbacks.create(file);

			expect(eventManager.getDirtyFiles()).toEqual([
				{ path: 'created.md', type: LocalChangeType.CREATE },
			]);
		});

		it('adds delete events to dirty files', () => {
			eventManager.startListening();
			const file = makeTFile('deleted.md', 100);

			eventCallbacks.delete(file);

			expect(eventManager.getDirtyFiles()).toEqual([
				{ path: 'deleted.md', type: LocalChangeType.DELETE },
			]);
		});

		it('adds rename events and removes the old path', () => {
			eventManager.startListening();
			const oldFile = makeTFile('old.md', 100);
			const renamedFile = makeTFile('new.md', 100);

			eventCallbacks.modify(oldFile);
			eventCallbacks.rename(renamedFile, 'old.md');

			expect(eventManager.getDirtyFiles()).toEqual([
				{ path: 'new.md', type: LocalChangeType.RENAME, oldPath: 'old.md' },
			]);
		});

		it('clears all dirty files', () => {
			eventManager.startListening();
			eventCallbacks.modify(makeTFile('first.md', 100));
			eventCallbacks.create(makeTFile('second.md', 100));

			eventManager.clearDirtyFiles();

			expect(eventManager.getDirtyFiles()).toEqual([]);
		});

		it('removes only specified dirty paths', () => {
			eventManager.startListening();
			eventCallbacks.modify(makeTFile('keep.md', 100));
			eventCallbacks.modify(makeTFile('remove.md', 100));

			eventManager.removeDirtyPaths(['remove.md']);

			expect(eventManager.getDirtyFiles()).toEqual([
				{ path: 'keep.md', type: LocalChangeType.MODIFY },
			]);
		});
	});

	describe('event filtering', () => {
		it('ignores files in .obsidian paths', () => {
			eventManager.startListening();
			eventCallbacks.modify(makeTFile('.obsidian/config', 100));

			expect(eventManager.getDirtyFiles()).toEqual([]);
		});

		it('allows selected plugin manifest files when opted in', () => {
			eventManager = new EventManager(mockApp as any, onSyncTriggered, stateManager, (path) =>
				shouldSyncVaultPath(path, true, false, mockApp.vault.configDir)
			);
			eventManager.startListening();

			eventCallbacks.modify(makeTFile('.obsidian/community-plugins.json', 100));

			expect(eventManager.getDirtyFiles()).toEqual([
				{ path: '.obsidian/community-plugins.json', type: LocalChangeType.MODIFY },
			]);
		});

		it('allows installed plugin manifest files when opted in', () => {
			eventManager = new EventManager(mockApp as any, onSyncTriggered, stateManager, (path) =>
				shouldSyncVaultPath(path, true, false, mockApp.vault.configDir)
			);
			eventManager.startListening();

			eventCallbacks.modify(makeTFile('.obsidian/plugins/calendar/manifest.json', 100));

			expect(eventManager.getDirtyFiles()).toEqual([
				{ path: '.obsidian/plugins/calendar/manifest.json', type: LocalChangeType.MODIFY },
			]);
		});

		it('syncs plugin binaries when plugin sync is opted in', () => {
			eventManager = new EventManager(mockApp as any, onSyncTriggered, stateManager, (path) =>
				shouldSyncVaultPath(path, true, false, mockApp.vault.configDir)
			);
			eventManager.startListening();

			eventCallbacks.modify(makeTFile('.obsidian/plugins/calendar/main.js', 100));

			expect(eventManager.getDirtyFiles()).toEqual([
				{ path: '.obsidian/plugins/calendar/main.js', type: LocalChangeType.MODIFY },
			]);
		});

		it('keeps plugin data files excluded when plugin sync is opted in', () => {
			eventManager = new EventManager(mockApp as any, onSyncTriggered, stateManager, (path) =>
				shouldSyncVaultPath(path, true, false, mockApp.vault.configDir)
			);
			eventManager.startListening();

			eventCallbacks.modify(makeTFile('.obsidian/plugins/calendar/data.json', 100));

			expect(eventManager.getDirtyFiles()).toEqual([]);
		});

		it('suppresses the first own-write event and allows the next one', () => {
			eventManager.startListening();
			const file = makeTFile('test.md', 100);

			eventManager.markOwnWrites(['test.md']);
			eventCallbacks.modify(file);
			expect(eventManager.getDirtyFiles()).toEqual([]);

			eventCallbacks.modify(file);
			expect(eventManager.getDirtyFiles()).toEqual([
				{ path: 'test.md', type: LocalChangeType.MODIFY },
			]);
		});

		it('removes own-write suppression when requested', () => {
			eventManager.startListening();
			eventManager.markOwnWrites(['test.md']);
			eventManager.removeOwnWrite('test.md');

			eventCallbacks.modify(makeTFile('test.md', 100));

			expect(eventManager.getDirtyFiles()).toEqual([
				{ path: 'test.md', type: LocalChangeType.MODIFY },
			]);
		});

		it('suppresses startup create events for known files', () => {
			eventManager.startListening();
			stateManager.setFileState('existing.md', makeFileState('existing.md'));

			eventCallbacks.create(makeTFile('existing.md', 100));

			expect(eventManager.getDirtyFiles()).toEqual([]);
		});

		it('does not suppress create events for new files', () => {
			eventManager.startListening();

			eventCallbacks.create(makeTFile('brand-new.md', 100));

			expect(eventManager.getDirtyFiles()).toEqual([
				{ path: 'brand-new.md', type: LocalChangeType.CREATE },
			]);
		});

		it('queues delete for tracked config files removed by raw events', async () => {
			const configPath = '.obsidian/app.json';
			eventManager = new EventManager(mockApp as any, onSyncTriggered, stateManager, (path) =>
				path === configPath
			);
			eventManager.startListening();
			eventManager.markInitialSyncDone();
			stateManager.setFileState(configPath, makeFileState(configPath));
			mockApp.vault.adapter.stat.mockResolvedValue(null);

			eventCallbacks.raw(configPath);
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(100);

			expect(eventManager.getDirtyFiles()).toEqual([
				{ path: configPath, type: LocalChangeType.DELETE },
			]);
			expect(onSyncTriggered).toHaveBeenCalledTimes(1);
		});

		it('ignores raw deletes for untracked config files that are already gone', async () => {
			const configPath = '.obsidian/app.json';
			eventManager = new EventManager(mockApp as any, onSyncTriggered, stateManager, (path) =>
				path === configPath
			);
			eventManager.startListening();
			eventManager.markInitialSyncDone();
			mockApp.vault.adapter.stat.mockResolvedValue(null);

			eventCallbacks.raw(configPath);
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(100);

			expect(eventManager.getDirtyFiles()).toEqual([]);
			expect(onSyncTriggered).not.toHaveBeenCalled();
		});

		it('queues modify for tracked config files changed by raw events', async () => {
			const configPath = '.obsidian/app.json';
			eventManager = new EventManager(mockApp as any, onSyncTriggered, stateManager, (path) =>
				path === configPath
			);
			eventManager.startListening();
			eventManager.markInitialSyncDone();
			stateManager.setFileState(configPath, {
				...makeFileState(configPath),
				localMtime: 100,
				size: 10,
			});
			mockApp.vault.adapter.stat.mockResolvedValue({ type: 'file', mtime: 200, size: 12, ctime: 0 });

			eventCallbacks.raw(configPath);
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(100);

			expect(eventManager.getDirtyFiles()).toEqual([
				{ path: configPath, type: LocalChangeType.MODIFY },
			]);
			expect(onSyncTriggered).toHaveBeenCalledTimes(1);
		});

		it('ignores non-TFile/TFolder events', async () => {
			eventManager.startListening();

			eventCallbacks.modify({ path: 'folder' });
			eventCallbacks.create({ path: 'folder' });
			eventCallbacks.delete({ path: 'folder' });
			eventCallbacks.rename({ path: 'folder' }, 'old-folder');
			await vi.advanceTimersByTimeAsync(1000);

			expect(eventManager.getDirtyFiles()).toEqual([]);
			expect(onSyncTriggered).not.toHaveBeenCalled();
		});
	});

	describe('TFolder events', () => {
		it('adds folder delete events to dirty files', () => {
			eventManager.startListening();
			const folder = makeTFolder('my-folder');

			eventCallbacks.delete(folder);

			expect(eventManager.getDirtyFiles()).toEqual([
				{ path: 'my-folder', type: LocalChangeType.FOLDER_DELETE },
			]);
		});

		it('adds folder create events after initial sync is done', () => {
			eventManager.startListening();
			eventManager.markInitialSyncDone();
			const folder = makeTFolder('new-folder');

			eventCallbacks.create(folder);

			expect(eventManager.getDirtyFiles()).toEqual([
				{ path: 'new-folder', type: LocalChangeType.FOLDER_CREATE },
			]);
		});

		it('suppresses folder create events before initial sync completes', () => {
			eventManager.startListening();
			const folder = makeTFolder('startup-folder');

			eventCallbacks.create(folder);

			expect(eventManager.getDirtyFiles()).toEqual([]);
		});

		it('suppresses folder create events for already-tracked folders', () => {
			eventManager.startListening();
			eventManager.markInitialSyncDone();
			stateManager.setFolderState('some-id', 'existing-folder');
			const folder = makeTFolder('existing-folder');

			eventCallbacks.create(folder);

			expect(eventManager.getDirtyFiles()).toEqual([]);
		});

		it('updates folder create path on rename (Untitled → real name)', () => {
			eventManager.startListening();
			eventManager.markInitialSyncDone();
			const untitled = makeTFolder('Untitled');
			eventCallbacks.create(untitled);

			const renamed = makeTFolder('MyFolder');
			eventCallbacks.rename(renamed, 'Untitled');

			const dirty = eventManager.getDirtyFiles();
			expect(dirty).toEqual([
				{ path: 'MyFolder', type: LocalChangeType.FOLDER_CREATE },
			]);
		});

		it('schedules sync on folder delete', async () => {
			eventManager.startListening();
			eventCallbacks.delete(makeTFolder('deleted-folder'));

			await vi.advanceTimersByTimeAsync(100);

			expect(onSyncTriggered).toHaveBeenCalledTimes(1);
		});

		it('schedules sync on folder create after initial sync', async () => {
			eventManager.startListening();
			eventManager.markInitialSyncDone();
			eventCallbacks.create(makeTFolder('new-folder'));

			await vi.advanceTimersByTimeAsync(100);

			expect(onSyncTriggered).toHaveBeenCalledTimes(1);
		});
	});

	describe('sync scheduling', () => {
		it('triggers a debounced sync after a modify event', async () => {
			eventManager.startListening();
			eventCallbacks.modify(makeTFile('test.md', 100));

			await vi.advanceTimersByTimeAsync(100);

			expect(onSyncTriggered).toHaveBeenCalledTimes(1);
		});

		it('coalesces rapid events into a single sync call', async () => {
			eventManager.startListening();

			eventCallbacks.modify(makeTFile('one.md', 100));
			eventCallbacks.modify(makeTFile('two.md', 100));
			eventCallbacks.modify(makeTFile('three.md', 100));

			await vi.advanceTimersByTimeAsync(100);

			expect(onSyncTriggered).toHaveBeenCalledTimes(1);
		});

		it('does not schedule a new sync while one is already running', async () => {
			const deferred = createDeferred();
			onSyncTriggered = vi.fn().mockImplementation(() => deferred.promise);
			eventManager = new EventManager(mockApp as any, onSyncTriggered, stateManager);
			eventManager.startListening();

			eventCallbacks.modify(makeTFile('first.md', 100));
			await vi.advanceTimersByTimeAsync(100);
			expect(onSyncTriggered).toHaveBeenCalledTimes(1);
			expect(eventManager.isSyncInProgress()).toBe(true);

			eventCallbacks.modify(makeTFile('second.md', 100));
			await vi.advanceTimersByTimeAsync(500);

			expect(onSyncTriggered).toHaveBeenCalledTimes(1);

			deferred.resolve();
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(200);

			expect(onSyncTriggered).toHaveBeenCalledTimes(1);
		});
	});

	describe('periodic sync', () => {
		it('starts periodic sync at the requested interval', async () => {
			eventManager.startPeriodicSync(1);

			await vi.advanceTimersByTimeAsync(60000);

			expect(onSyncTriggered).toHaveBeenCalledTimes(1);
		});

		it('stops periodic sync when requested', async () => {
			eventManager.startPeriodicSync(1);
			eventManager.stopPeriodicSync();

			await vi.advanceTimersByTimeAsync(60000);

			expect(onSyncTriggered).not.toHaveBeenCalled();
		});

		it('does not start periodic sync when disabled', async () => {
			eventManager.startPeriodicSync(0);

			await vi.advanceTimersByTimeAsync(180000);

			expect(onSyncTriggered).not.toHaveBeenCalled();
		});
	});

	describe('manual sync', () => {
		it('triggers sync immediately', async () => {
			await eventManager.triggerManualSync();

			expect(onSyncTriggered).toHaveBeenCalledTimes(1);
		});

		it('skips manual sync when a sync is already in progress', async () => {
			const deferred = createDeferred();
			onSyncTriggered = vi.fn().mockImplementation(() => deferred.promise);
			eventManager = new EventManager(mockApp as any, onSyncTriggered, stateManager);

			const firstSync = eventManager.triggerManualSync();
			expect(eventManager.isSyncInProgress()).toBe(true);

			await eventManager.triggerManualSync();

			expect(onSyncTriggered).toHaveBeenCalledTimes(1);

			deferred.resolve();
			await firstSync;
		});
	});

	describe('lifecycle', () => {
		it('registers all vault event handlers when listening starts', () => {
			eventManager.startListening();

			expect(mockApp.vault.on).toHaveBeenCalledTimes(5);
			expect(mockApp.vault.on).toHaveBeenNthCalledWith(1, 'modify', expect.any(Function));
			expect(mockApp.vault.on).toHaveBeenNthCalledWith(2, 'create', expect.any(Function));
			expect(mockApp.vault.on).toHaveBeenNthCalledWith(3, 'delete', expect.any(Function));
			expect(mockApp.vault.on).toHaveBeenNthCalledWith(4, 'rename', expect.any(Function));
			expect(mockApp.vault.on).toHaveBeenNthCalledWith(5, 'raw', expect.any(Function));
		});

		it('unregisters all event refs when listening stops', () => {
			eventManager.startListening();
			eventManager.stopListening();

			expect(mockApp.vault.offref).toHaveBeenCalledTimes(5);
			expect(mockApp.vault.offref).toHaveBeenNthCalledWith(1, { id: 'ref-modify' });
			expect(mockApp.vault.offref).toHaveBeenNthCalledWith(2, { id: 'ref-create' });
			expect(mockApp.vault.offref).toHaveBeenNthCalledWith(3, { id: 'ref-delete' });
			expect(mockApp.vault.offref).toHaveBeenNthCalledWith(4, { id: 'ref-rename' });
			expect(mockApp.vault.offref).toHaveBeenNthCalledWith(5, { id: 'ref-raw' });
		});

		it('reports whether a sync is in progress', async () => {
			const deferred = createDeferred();
			onSyncTriggered = vi.fn().mockImplementation(() => deferred.promise);
			eventManager = new EventManager(mockApp as any, onSyncTriggered, stateManager);

			expect(eventManager.isSyncInProgress()).toBe(false);

			const syncPromise = eventManager.triggerManualSync();
			expect(eventManager.isSyncInProgress()).toBe(true);

			deferred.resolve();
			await syncPromise;

			expect(eventManager.isSyncInProgress()).toBe(false);
		});
	});
});
