import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		setDebugMode: vi.fn(),
		enableFileLogging: vi.fn(),
		setVaultLogHook: vi.fn(),
	},
}));

vi.mock('obsidian', async () => {
	const actual = await vi.importActual<typeof import('obsidian')>('obsidian');

	class TrackingNotice extends actual.Notice {
		static calls: Array<[string, number | undefined]> = [];
		declare timeout?: number;

		constructor(message: string, timeout?: number) {
			super(message, timeout);
			this.timeout = timeout;
			TrackingNotice.calls.push([message, timeout]);
		}

		setMessage(message: string | DocumentFragment): this {
			super.setMessage(message);
			TrackingNotice.calls.push([String(message), this.timeout]);
			return this;
		}

		hide() {
			TrackingNotice.calls.push(['__hide__', this.timeout]);
			super.hide();
		}
	}

	return {
		...actual,
		Notice: TrackingNotice,
	};
});

import { Notice, TFile } from 'obsidian';
import '../../setup';
import { mockApp, makeTFile, makeTFolder } from '../../setup';
import { SyncEngine } from '../../../src/sync/syncEngine';
import { SyncStateManager } from '../../../src/sync/syncState';
import { ConflictResolver } from '../../../src/sync/conflictResolver';
import { shouldSyncVaultPath } from '../../../src/utils/pathUtils';
import {
	ConflictResolutionStrategy,
	LocalChangeType,
	OneDriveError,
	OneDriveItem,
	SyncDirection,
} from '../../../src/types';

function makeRemoteItem(
	overrides: Partial<OneDriveItem> & { id: string; name: string }
): OneDriveItem {
	return {
		lastModifiedDateTime: new Date().toISOString(),
		createdDateTime: new Date().toISOString(),
		...overrides,
	};
}

function makeRemoteFile(
	vaultPath: string,
	overrides: Partial<OneDriveItem> & { id?: string; name?: string } = {}
): OneDriveItem {
	const parts = vaultPath.split('/');
	const name = overrides.name ?? parts.pop() ?? vaultPath;
	const parent = parts.join('/');

	return makeRemoteItem({
		id: overrides.id ?? `${vaultPath}-id`,
		name,
		size: overrides.size ?? 100,
		file: overrides.file ?? {
			mimeType: 'text/plain',
			hashes: { quickXorHash: `${vaultPath}-hash` },
		},
		parentReference: overrides.parentReference ?? {
			id: 'parent-id',
			path: parent ? `/drive/root:/remote/root/${parent}` : '/drive/root:/remote/root',
		},
		...overrides,
	});
}

function makeRemoteDelete(vaultPath: string, overrides: Partial<OneDriveItem> = {}): OneDriveItem {
	const parts = vaultPath.split('/');
	const name = parts.pop() ?? vaultPath;
	const parent = parts.join('/');

	return makeRemoteItem({
		id: overrides.id ?? `${vaultPath}-id`,
		name,
		deleted: { state: 'deleted' },
		parentReference: overrides.parentReference ?? {
			id: 'parent-id',
			path: parent ? `/drive/root:/remote/root/${parent}` : '/drive/root:/remote/root',
		},
		...overrides,
	});
}

function hashContent(data: Uint8Array): string {
	let hash = 0x811c9dc5;
	for (const byte of data) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

describe('SyncEngine', () => {
	let syncEngine: SyncEngine;
	let mockFileOps: { uploadFile: Mock; downloadFile: Mock; deleteFile: Mock; moveFile: Mock; createFolder: Mock };
	let mockClient: { getDelta: Mock; isSharedDrive: Mock };
	let stateManager: SyncStateManager;
	let conflictResolver: ConflictResolver;
	let mockEventManager: {
		getDirtyFiles: Mock;
		clearDirtyFiles: Mock;
		removeDirtyPaths: Mock;
		addDirtyFile: Mock;
		markOwnWrites: Mock;
		removeOwnWrite: Mock;
		isOwnWrite: Mock;
		markInitialSyncDone: Mock;
	};
	type TrackingNoticeClass = typeof Notice & { calls: Array<[string, number | undefined]> };
	const trackingNotice = Notice as TrackingNoticeClass;

	beforeEach(() => {
		trackingNotice.calls.length = 0;

		mockApp.vault.getAbstractFileByPath.mockReset();
		mockApp.vault.readBinary.mockReset().mockResolvedValue(new ArrayBuffer(10));
		mockApp.fileManager.trashFile.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.exists.mockReset().mockResolvedValue(true);
		mockApp.vault.adapter.read.mockReset().mockRejectedValue(new Error('missing .syncIgnore'));
		mockApp.vault.adapter.mkdir.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.writeBinary.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.stat.mockReset().mockResolvedValue(null);
		mockApp.vault.adapter.list.mockReset().mockResolvedValue({ files: [], folders: [] });
		mockApp.vault.getRoot.mockReset().mockReturnValue({ path: '', children: [] });

		mockFileOps = {
			uploadFile: vi.fn().mockResolvedValue(
				makeRemoteItem({
					id: 'uploaded-id',
					name: 'test.md',
					file: { mimeType: 'text/plain', hashes: { quickXorHash: 'hash123' } },
				})
			),
			downloadFile: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
			deleteFile: vi.fn().mockResolvedValue(undefined),
			moveFile: vi.fn().mockResolvedValue(
				makeRemoteItem({
					id: 'moved-id',
					name: 'moved.md',
					file: { mimeType: 'text/plain', hashes: { quickXorHash: 'hash123' } },
				})
			),
			createFolder: vi.fn().mockResolvedValue(
				makeRemoteItem({
					id: 'folder-id',
					name: 'folder',
					folder: {},
				})
			),
		};

		stateManager = new SyncStateManager();
		conflictResolver = new ConflictResolver(ConflictResolutionStrategy.LAST_WRITE_WINS);

		mockEventManager = {
			getDirtyFiles: vi.fn().mockReturnValue([]),
			clearDirtyFiles: vi.fn(),
			removeDirtyPaths: vi.fn(),
			addDirtyFile: vi.fn(),
			markOwnWrites: vi.fn(),
			removeOwnWrite: vi.fn(),
			isOwnWrite: vi.fn().mockReturnValue(false),
			markInitialSyncDone: vi.fn(),
		};

		mockClient = {
			getDelta: vi.fn().mockResolvedValue({ items: [], deltaLink: 'delta-link-1' }),
			isSharedDrive: vi.fn().mockReturnValue(false),
		};

		syncEngine = new SyncEngine(
			mockApp as any,
			mockFileOps as any,
			mockClient as any,
			stateManager,
			conflictResolver,
			mockEventManager as any,
			'.obsidian',
			{ remoteRoot: '/remote/root' }
		);
	});

	it('does not perform any operations when there are no changes', async () => {
		stateManager.setLastSyncTime(Date.now());

		await syncEngine.performSync();

		expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
		expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
		expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
		expect(stateManager.getDeltaLink()).toBe('delta-link-1');
	});

	it('uploads locally modified files', async () => {
		stateManager.setLastSyncTime(Date.now());
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/test.md', type: LocalChangeType.MODIFY },
		]);
		const localFile = makeTFile('notes/test.md', 100, Date.now());
		expect(localFile).toBeInstanceOf(TFile);
		mockApp.vault.getAbstractFileByPath.mockReturnValue(localFile);

		await syncEngine.performSync();

		expect(mockFileOps.uploadFile).toHaveBeenCalledWith(
			'/remote/root/notes/test.md',
			expect.any(ArrayBuffer)
		);
		expect(stateManager.getFileState('notes/test.md')).toMatchObject({
			path: 'notes/test.md',
			localMtime: localFile.stat.mtime,
			remoteHash: 'hash123',
			oneDriveId: 'uploaded-id',
		});
	});

	it('deletes remote files for local deletes', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('old.md', {
			path: 'old.md',
			localMtime: 1,
			remoteHash: 'old-hash',
			size: 12,
			remoteModifiedTime: 2,
			oneDriveId: 'remote-old-id',
		});
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'old.md', type: LocalChangeType.DELETE },
		]);

		await syncEngine.performSync();

		expect(mockFileOps.deleteFile).toHaveBeenCalledWith('remote-old-id');
		expect(stateManager.getFileState('old.md')).toBeUndefined();
	});

	it('creates remote folders for existing untracked empty folders', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setDeltaLink('prev-delta');
		const root = makeTFolder('');
		const notesFolder = makeTFolder('notes');
		const childFolder = makeTFolder('notes/empty-child');
		notesFolder.children = [childFolder];
		root.children = [notesFolder];
		mockApp.vault.getRoot.mockReturnValue(root);

		mockFileOps.createFolder = vi
			.fn()
			.mockImplementation(async (remotePath: string) =>
				makeRemoteItem({
					id: `${remotePath}-id`,
					name: remotePath.split('/').pop() ?? remotePath,
					folder: { childCount: 0 },
				})
			);

		await syncEngine.performSync();

		expect(mockFileOps.createFolder).toHaveBeenCalledTimes(2);
		expect(mockFileOps.createFolder).toHaveBeenNthCalledWith(1, '/remote/root/notes');
		expect(mockFileOps.createFolder).toHaveBeenNthCalledWith(2, '/remote/root/notes/empty-child');
		expect(stateManager.getFolderIdByPath('notes')).toBe('/remote/root/notes-id');
		expect(stateManager.getFolderIdByPath('notes/empty-child')).toBe(
			'/remote/root/notes/empty-child-id'
		);
	});

	it('handles local renames by using atomic move API', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('old.md', {
			path: 'old.md',
			localMtime: 1,
			remoteHash: 'old-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'old-remote-id',
		});
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'new.md', type: LocalChangeType.RENAME, oldPath: 'old.md' },
		]);
		mockApp.vault.getAbstractFileByPath.mockReturnValue(makeTFile('new.md', 10, Date.now()));

		await syncEngine.performSync();

		// With atomic moves enabled (default), should use moveFile instead of delete+upload
		expect(mockFileOps.moveFile).toHaveBeenCalledWith('old-remote-id', '/remote/root/new.md');
		expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
		expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
		expect(stateManager.getFileState('old.md')).toBeUndefined();
		expect(stateManager.getFileState('new.md')).toBeDefined();
	});

	it('does not re-download the old path when the delta echoes the pre-rename item (issue #138)', async () => {
		// Repro: a freshly-created "Untitled.md" was uploaded on a prior sync.
		// The user renames it before the next sync. That sync sees both a local
		// RENAME (old.md → new.md) AND a delta that still reports the OLD path as
		// changed — an echo of our own upload carrying the SAME OneDrive ID.
		// The old path must NOT be pulled back down as a phantom file linked to
		// the same remote item.
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('old.md', {
			path: 'old.md',
			localMtime: 1,
			remoteHash: 'old-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'shared-remote-id',
		});
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'new.md', type: LocalChangeType.RENAME, oldPath: 'old.md' },
		]);
		// Delta still reports old.md as a live change, sharing the moved item's ID.
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteFile('old.md', { id: 'shared-remote-id' })],
			deltaLink: 'delta-link-echo',
		});
		mockApp.vault.getAbstractFileByPath.mockReturnValue(makeTFile('new.md', 10, Date.now()));

		await syncEngine.performSync();

		// Atomic move should still happen for the rename...
		expect(mockFileOps.moveFile).toHaveBeenCalledWith('shared-remote-id', '/remote/root/new.md');
		// ...but the stale echo of the old path must NOT be downloaded.
		expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
		expect(mockApp.vault.adapter.writeBinary).not.toHaveBeenCalled();
		expect(stateManager.getFileState('old.md')).toBeUndefined();
	});

	it('downloads remote changes', async () => {
		stateManager.setLastSyncTime(Date.now());
		const downloadedFile = makeTFile('notes/remote.md', 10, Date.now());
		mockClient.getDelta.mockResolvedValue({
			items: [
				makeRemoteFile('notes/remote.md', {
					id: 'remote-file-id',
					parentReference: { id: 'parent-id', path: '/drive/root:/remote/root/notes' },
					name: 'remote.md',
					file: { mimeType: 'text/plain', hashes: { quickXorHash: 'remote-hash' } },
				}),
			],
			deltaLink: 'delta-link-2',
		});
		mockApp.vault.getAbstractFileByPath.mockReturnValue(downloadedFile);

		await syncEngine.performSync();

		expect(mockFileOps.downloadFile).toHaveBeenCalledWith('remote-file-id');
		expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
			'notes/remote.md',
			expect.any(ArrayBuffer)
		);
		expect(mockEventManager.markOwnWrites).toHaveBeenCalledWith(['notes/remote.md']);
		expect(stateManager.getFileState('notes/remote.md')).toMatchObject({
			path: 'notes/remote.md',
			remoteHash: 'remote-hash',
			oneDriveId: 'remote-file-id',
		});
	});

	it('realigns localized app-folder delta paths to the vault root', async () => {
		stateManager.setLastSyncTime(Date.now());
		syncEngine = new SyncEngine(
			mockApp as any,
			mockFileOps as any,
			mockClient as any,
			stateManager,
			conflictResolver,
			mockEventManager as any,
			'.obsidian',
			{ remoteRoot: '', remoteRootOnDrive: '/Apps/ObsidianOneDrive' }
		);
		mockApp.vault.adapter.exists.mockResolvedValue(false);
		mockClient.getDelta.mockResolvedValue({
			items: [
				makeRemoteFile('Development/Remotething/Remotething ideas.md', {
					id: 'remote-idea-id',
					parentReference: {
						id: 'parent-id',
						path: '/drive/root:/Aplikacje/ObsidianOneDrive/Development/Remotething',
					},
				}),
			],
			deltaLink: 'delta-link-localized',
		});

		await syncEngine.performSync();

		expect(mockApp.vault.adapter.mkdir).toHaveBeenCalledWith('Development/Remotething');
		expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
			'Development/Remotething/Remotething ideas.md',
			expect.any(ArrayBuffer)
		);
		expect(stateManager.getFileState('Development/Remotething/Remotething ideas.md')).toMatchObject({
			path: 'Development/Remotething/Remotething ideas.md',
			oneDriveId: 'remote-idea-id',
		});
	});

	// Issue #97: a legacy (unscoped) app-folder cursor is retired once so the
	// next fetch rebuilds a subfolder-scoped one.
	it('retires a legacy unscoped app-folder delta cursor', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setDeltaLink('legacy-wide-cursor'); // no scoped flag
		syncEngine = new SyncEngine(
			mockApp as any,
			mockFileOps as any,
			mockClient as any,
			stateManager,
			conflictResolver,
			mockEventManager as any,
			'.obsidian',
			{
				remoteRoot: 'vault_a',
				remoteRootOnDrive: '/Applications/ObsidianOneDrive/vault_a',
				isAppFolder: true,
			}
		);
		mockClient.getDelta.mockResolvedValue({ items: [], deltaLink: 'fresh-scoped-cursor' });

		await syncEngine.performSync();

		// Fetch was made WITHOUT the legacy cursor (forcing a fresh scoped query)...
		expect(mockClient.getDelta).toHaveBeenCalledWith(undefined, 'vault_a');
		// ...and the newly stored cursor is flagged scoped.
		expect(stateManager.getDeltaLink()).toBe('fresh-scoped-cursor');
		expect(stateManager.isDeltaLinkScoped()).toBe(true);
	});

	// A scoped cursor is used as-is, not reset.
	it('keeps a scoped app-folder delta cursor', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setDeltaLink('already-scoped', true);
		syncEngine = new SyncEngine(
			mockApp as any,
			mockFileOps as any,
			mockClient as any,
			stateManager,
			conflictResolver,
			mockEventManager as any,
			'.obsidian',
			{
				remoteRoot: 'vault_a',
				remoteRootOnDrive: '/Applications/ObsidianOneDrive/vault_a',
				isAppFolder: true,
			}
		);
		mockClient.getDelta.mockResolvedValue({ items: [], deltaLink: 'next-scoped' });

		await syncEngine.performSync();

		expect(mockClient.getDelta).toHaveBeenCalledWith('already-scoped', 'vault_a');
	});

	it('ignores remote .obsidian plugin files by default', async () => {
		stateManager.setLastSyncTime(Date.now());
		mockClient.getDelta.mockResolvedValue({
			items: [
				makeRemoteFile('.obsidian/community-plugins.json', {
					id: 'community-id',
					parentReference: { id: 'parent-id', path: '/drive/root:/remote/root/.obsidian' },
					name: 'community-plugins.json',
				}),
			],
			deltaLink: 'delta-link-2',
		});

		await syncEngine.performSync();

		expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
		expect(stateManager.getFileState('.obsidian/community-plugins.json')).toBeUndefined();
	});

	it('downloads installed plugin manifest files when opted in', async () => {
		stateManager.setLastSyncTime(Date.now());
		syncEngine = new SyncEngine(
			mockApp as any,
			mockFileOps as any,
			mockClient as any,
			stateManager,
			conflictResolver,
			mockEventManager as any,
			'.obsidian',
			{
				remoteRoot: '/remote/root',
				shouldSyncPath: (path) => shouldSyncVaultPath(path, true, false, '.obsidian'),
			}
		);
		const downloadedFile = makeTFile('.obsidian/plugins/calendar/manifest.json', 10, Date.now());
		mockClient.getDelta.mockResolvedValue({
			items: [
				makeRemoteFile('.obsidian/plugins/calendar/manifest.json', {
					id: 'plugin-manifest-id',
					parentReference: {
						id: 'parent-id',
						path: '/drive/root:/remote/root/.obsidian/plugins/calendar',
					},
					name: 'manifest.json',
					file: { mimeType: 'application/json', hashes: { quickXorHash: 'plugin-manifest-hash' } },
				}),
			],
			deltaLink: 'delta-link-2',
		});
		mockApp.vault.getAbstractFileByPath.mockReturnValue(downloadedFile);

		await syncEngine.performSync();

		expect(mockFileOps.downloadFile).toHaveBeenCalledWith('plugin-manifest-id');
		expect(stateManager.getFileState('.obsidian/plugins/calendar/manifest.json')).toMatchObject({
			path: '.obsidian/plugins/calendar/manifest.json',
			remoteHash: 'plugin-manifest-hash',
			oneDriveId: 'plugin-manifest-id',
		});
	});

	it('deletes local files for remote deletes', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('old.md', {
			path: 'old.md',
			localMtime: 1,
			remoteHash: 'old-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'remote-delete-id',
		});
		const localFile = makeTFile('old.md', 10, Date.now());
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteDelete('old.md', { id: 'remote-delete-id' })],
			deltaLink: 'delta-link-2',
		});
		mockApp.vault.getAbstractFileByPath.mockReturnValue(localFile);

		await syncEngine.performSync();

		expect(mockApp.fileManager.trashFile).toHaveBeenCalledWith(localFile);
		expect(mockEventManager.markOwnWrites).toHaveBeenCalledWith(['old.md']);
		expect(stateManager.getFileState('old.md')).toBeUndefined();
	});

	it('uploads when both sides changed and the local file is newer', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('notes/test.md', {
			path: 'notes/test.md',
			localMtime: 50,
			remoteHash: 'known-hash',
			size: 50,
			remoteModifiedTime: 100,
			oneDriveId: 'remote-id',
		});
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/test.md', type: LocalChangeType.MODIFY },
		]);
		const localMtime = Date.now();
		mockApp.vault.getAbstractFileByPath.mockReturnValue(
			makeTFile('notes/test.md', 100, localMtime)
		);
		mockClient.getDelta.mockResolvedValue({
			items: [
				makeRemoteFile('notes/test.md', {
					id: 'remote-id',
					lastModifiedDateTime: new Date(localMtime - 60_000).toISOString(),
				}),
			],
			deltaLink: 'delta-link-2',
		});

		await syncEngine.performSync();

		expect(mockFileOps.uploadFile).toHaveBeenCalledWith(
			'/remote/root/notes/test.md',
			expect.any(ArrayBuffer)
		);
		expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
	});

	it('downloads when both sides changed and the remote file is newer', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('notes/test.md', {
			path: 'notes/test.md',
			localMtime: 50,
			remoteHash: 'known-hash',
			size: 50,
			remoteModifiedTime: 100,
			oneDriveId: 'remote-id',
		});
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/test.md', type: LocalChangeType.MODIFY },
		]);
		const localFile = makeTFile('notes/test.md', 100, Date.now() - 60_000);
		mockApp.vault.getAbstractFileByPath.mockReturnValue(localFile);
		mockClient.getDelta.mockResolvedValue({
			items: [
				makeRemoteFile('notes/test.md', {
					id: 'remote-id',
					lastModifiedDateTime: new Date(Date.now()).toISOString(),
				}),
			],
			deltaLink: 'delta-link-2',
		});

		await syncEngine.performSync();

		expect(mockFileOps.downloadFile).toHaveBeenCalledWith('remote-id');
		expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
	});

	it('uploads (not downloads) when both sides changed but remote hash matches stored hash', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('notes/test.md', {
			path: 'notes/test.md',
			localMtime: 50,
			remoteHash: 'same-hash', // Stored hash
			size: 50,
			remoteModifiedTime: 100,
			oneDriveId: 'remote-id',
		});
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/test.md', type: LocalChangeType.MODIFY },
		]);
		const localFile = makeTFile('notes/test.md', 100, Date.now() - 60_000);
		mockApp.vault.getAbstractFileByPath.mockReturnValue(localFile);
		// Remote returns same hash — this is our own upload echoing back
		mockClient.getDelta.mockResolvedValue({
			items: [
				makeRemoteFile('notes/test.md', {
					id: 'remote-id',
					lastModifiedDateTime: new Date(Date.now()).toISOString(), // Remote is "newer"
					file: { hashes: { quickXorHash: 'same-hash' } }, // Same hash
				}),
			],
			deltaLink: 'delta-link-2',
		});

		await syncEngine.performSync();

		// Should upload local (no real conflict) even though remote mtime is newer
		expect(mockFileOps.uploadFile).toHaveBeenCalledWith(
			'/remote/root/notes/test.md',
			expect.any(ArrayBuffer)
		);
		expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
	});

	it('creates a duplicate conflict file when configured to do so', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('notes/test.md', {
			path: 'notes/test.md',
			localMtime: 50,
			remoteHash: 'known-hash',
			size: 50,
			remoteModifiedTime: 100,
			oneDriveId: 'remote-id',
		});
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/test.md', type: LocalChangeType.MODIFY },
		]);
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteFile('notes/test.md', { id: 'remote-id' })],
			deltaLink: 'delta-link-2',
		});
		mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
			path === 'notes/test.md'
				? makeTFile('notes/test.md', 100, Date.now())
				: makeTFile(path, 10, Date.now())
		);

		const duplicateEngine = new SyncEngine(
			mockApp as any,
			mockFileOps as any,
			mockClient as any,
			stateManager,
			new ConflictResolver(ConflictResolutionStrategy.CREATE_DUPLICATE),
			mockEventManager as any,
			'.obsidian',
			{ remoteRoot: '/remote/root' }
		);

		await duplicateEngine.performSync();

		expect(mockFileOps.downloadFile).toHaveBeenCalledWith('remote-id');
		expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
			expect.stringContaining(' (conflict '),
			expect.any(ArrayBuffer)
		);
		// The base file must be converged (local uploaded) so the conflict
		// clears — otherwise it re-fires every sync and spawns a new copy
		// each cycle (issue #128).
		expect(mockFileOps.uploadFile).toHaveBeenCalledWith(
			expect.stringContaining('test.md'),
			expect.anything()
		);
	});

	it('does not spawn a new duplicate on the next sync after a create-duplicate conflict (issue #128)', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('notes/test.md', {
			path: 'notes/test.md',
			localMtime: 50,
			remoteHash: 'known-hash',
			size: 50,
			remoteModifiedTime: 100,
			oneDriveId: 'remote-id',
		});
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/test.md', type: LocalChangeType.MODIFY },
		]);
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteFile('notes/test.md', { id: 'remote-id' })],
			deltaLink: 'delta-link-2',
		});
		mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
			path === 'notes/test.md'
				? makeTFile('notes/test.md', 100, Date.now())
				: makeTFile(path, 10, Date.now())
		);

		const duplicateEngine = new SyncEngine(
			mockApp as any,
			mockFileOps as any,
			mockClient as any,
			stateManager,
			new ConflictResolver(ConflictResolutionStrategy.CREATE_DUPLICATE),
			mockEventManager as any,
			'.obsidian',
			{ remoteRoot: '/remote/root' }
		);

		await duplicateEngine.performSync();
		const copiesAfterFirst = mockApp.vault.adapter.writeBinary.mock.calls.filter(
			(call: unknown[]) => typeof call[0] === 'string' && call[0].includes(' (conflict ')
		).length;
		expect(copiesAfterFirst).toBe(1);

		// Second sync: the converging upload set the base file's tracked hash to
		// the uploaded value ('hash123'); the next delta reports that same hash,
		// so it is not a real conflict and no new copy is made.
		mockApp.vault.adapter.writeBinary.mockClear();
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/test.md', type: LocalChangeType.MODIFY },
		]);
		mockClient.getDelta.mockResolvedValue({
			items: [
				makeRemoteFile('notes/test.md', {
					id: 'remote-id',
					file: { mimeType: 'text/plain', hashes: { quickXorHash: 'hash123' } },
				}),
			],
			deltaLink: 'delta-link-3',
		});

		await duplicateEngine.performSync();
		const newCopies = mockApp.vault.adapter.writeBinary.mock.calls.filter(
			(call: unknown[]) => typeof call[0] === 'string' && call[0].includes(' (conflict ')
		).length;
		expect(newCopies).toBe(0);
	});

	it('re-uploads local changes when the remote file was deleted', async () => {
		stateManager.setLastSyncTime(Date.now());
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/test.md', type: LocalChangeType.MODIFY },
		]);
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteDelete('notes/test.md', { id: 'remote-id' })],
			deltaLink: 'delta-link-2',
		});
		mockApp.vault.getAbstractFileByPath.mockReturnValue(
			makeTFile('notes/test.md', 100, Date.now())
		);

		await syncEngine.performSync();

		expect(mockFileOps.uploadFile).toHaveBeenCalledWith(
			'/remote/root/notes/test.md',
			expect.any(ArrayBuffer)
		);
	});

	it('skips downloading same-size files on first sync and stores state only', async () => {
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteFile('notes/test.md', { id: 'remote-id', size: 100 })],
			deltaLink: 'delta-link-2',
		});
		mockApp.vault.getAbstractFileByPath.mockReturnValue(
			makeTFile('notes/test.md', 100, Date.now())
		);

		await syncEngine.performSync();

		expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
		expect(stateManager.getFileState('notes/test.md')).toMatchObject({
			path: 'notes/test.md',
			oneDriveId: 'remote-id',
			size: 100,
		});
	});

	it('downloads different-size files on first sync', async () => {
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteFile('notes/test.md', { id: 'remote-id', size: 100 })],
			deltaLink: 'delta-link-2',
		});
		mockApp.vault.getAbstractFileByPath.mockReturnValue(makeTFile('notes/test.md', 50, Date.now()));

		await syncEngine.performSync();

		expect(mockFileOps.downloadFile).toHaveBeenCalledWith('remote-id');
	});

	it('skips unchanged remote files when the hash matches stored state', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('notes/test.md', {
			path: 'notes/test.md',
			localMtime: 1,
			remoteHash: 'abc',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'remote-id',
		});
		mockClient.getDelta.mockResolvedValue({
			items: [
				makeRemoteFile('notes/test.md', {
					id: 'remote-id',
					file: { mimeType: 'text/plain', hashes: { quickXorHash: 'abc' } },
				}),
			],
			deltaLink: 'delta-link-2',
		});

		await syncEngine.performSync();

		expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
	});

	it('filters .obsidian files out of delta results', async () => {
		stateManager.setLastSyncTime(Date.now());
		mockClient.getDelta.mockResolvedValue({
			items: [
				makeRemoteItem({
					id: 'obsidian-id',
					name: 'config',
					size: 25,
					file: { mimeType: 'application/json', hashes: { quickXorHash: 'obsidian-hash' } },
					parentReference: { id: 'parent-id', path: '/drive/root:/remote/root/.obsidian' },
				}),
			],
			deltaLink: 'delta-link-2',
		});

		await syncEngine.performSync();

		expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
		expect(mockApp.vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	it('uses a separate delta token stream for .obsidian scope when enabled', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setDeltaLink('main-delta-old');
		stateManager.setObsidianDeltaLink('obsidian-delta-old');
		syncEngine = new SyncEngine(
			mockApp as any,
			mockFileOps as any,
			mockClient as any,
			stateManager,
			conflictResolver,
			mockEventManager as any,
			'.obsidian',
			{
				remoteRoot: '/remote/root',
				shouldSyncPath: (path) => shouldSyncVaultPath(path, true, false, '.obsidian'),
			}
		);
		mockClient.getDelta
			.mockResolvedValueOnce({
				items: [makeRemoteFile('notes/test.md', { id: 'remote-main-id' })],
				deltaLink: 'main-delta-new',
			})
			.mockResolvedValueOnce({
				items: [makeRemoteFile('.obsidian/community-plugins.json', { id: 'remote-obsidian-id' })],
				deltaLink: 'obsidian-delta-new',
			});
		mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
			makeTFile(path, 10, Date.now())
		);

		await syncEngine.performSync();

		expect(mockClient.getDelta).toHaveBeenNthCalledWith(1, 'main-delta-old', '/remote/root');
		expect(mockClient.getDelta).toHaveBeenNthCalledWith(2, 'obsidian-delta-old', '/remote/root', '.obsidian');
		expect(stateManager.getDeltaLink()).toBe('main-delta-new');
		expect(stateManager.getObsidianDeltaLink()).toBe('obsidian-delta-new');
	});

	it('preserves the .obsidian delta token when .obsidian scope is disabled', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setObsidianDeltaLink('obsidian-delta-existing');
		mockClient.getDelta.mockResolvedValue({ items: [], deltaLink: 'main-delta-new' });

		await syncEngine.performSync();

		expect(mockClient.getDelta).toHaveBeenCalledTimes(1);
		expect(stateManager.getDeltaLink()).toBe('main-delta-new');
		expect(stateManager.getObsidianDeltaLink()).toBe('obsidian-delta-existing');
	});

	it('runs the .obsidian delta stream when only syncAppSettings is enabled', async () => {
		stateManager.setLastSyncTime(Date.now());
		syncEngine = new SyncEngine(
			mockApp as any,
			mockFileOps as any,
			mockClient as any,
			stateManager,
			conflictResolver,
			mockEventManager as any,
			'.obsidian',
			{
				remoteRoot: '/remote/root',
				// syncPluginManifests=false, syncAppSettings=true
				shouldSyncPath: (path) => shouldSyncVaultPath(path, false, true, '.obsidian'),
			}
		);
		mockClient.getDelta
			.mockResolvedValueOnce({ items: [], deltaLink: 'main-delta-new' })
			.mockResolvedValueOnce({ items: [], deltaLink: 'obsidian-delta-new' });

		await syncEngine.performSync();

		expect(mockClient.getDelta).toHaveBeenCalledTimes(2);
		expect(mockClient.getDelta).toHaveBeenNthCalledWith(2, undefined, '/remote/root', '.obsidian');
		expect(stateManager.getObsidianDeltaLink()).toBe('obsidian-delta-new');
	});

	it('filters remote changes using .syncIgnore patterns', async () => {
		stateManager.setLastSyncTime(Date.now());
		mockApp.vault.adapter.read.mockResolvedValue('private/\n*.tmp');
		mockClient.getDelta.mockResolvedValue({
			items: [
				makeRemoteFile('private/secret.md', { id: 'private-id' }),
				makeRemoteFile('private/sub/secret.md', { id: 'private-nested-id' }),
				makeRemoteFile('notes/draft.tmp', { id: 'tmp-id' }),
				makeRemoteFile('notes/keep.md', { id: 'keep-id' }),
			],
			deltaLink: 'delta-link-2',
		});
		mockApp.vault.getAbstractFileByPath.mockReturnValue(makeTFile('notes/keep.md', 10, Date.now()));

		await syncEngine.performSync();

		expect(mockFileOps.downloadFile).toHaveBeenCalledTimes(1);
		expect(mockFileOps.downloadFile).toHaveBeenCalledWith('keep-id');
		expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith('notes/keep.md', expect.any(ArrayBuffer));
	});

	it('filters deeply nested .obsidian paths from remote changes', async () => {
		stateManager.setLastSyncTime(Date.now());
		// .syncIgnore is empty; .obsidian/** exclusion is built-in
		mockApp.vault.adapter.read.mockResolvedValue('');
		mockClient.getDelta.mockResolvedValue({
			items: [
				makeRemoteFile('.obsidian/plugins/foo/main.js', { id: 'plugin-id' }),
				makeRemoteFile('.obsidian/workspace.json', { id: 'workspace-id' }),
				makeRemoteFile('notes/keep.md', { id: 'keep-id' }),
			],
			deltaLink: 'delta-link-3',
		});
		mockApp.vault.getAbstractFileByPath.mockReturnValue(makeTFile('notes/keep.md', 10, Date.now()));

		await syncEngine.performSync();

		expect(mockFileOps.downloadFile).toHaveBeenCalledTimes(1);
		expect(mockFileOps.downloadFile).toHaveBeenCalledWith('keep-id');
	});

	it('removes ignored local dirty paths based on .syncIgnore', async () => {
		stateManager.setLastSyncTime(Date.now());
		mockApp.vault.adapter.read.mockResolvedValue('private/');
		mockEventManager.getDirtyFiles.mockReturnValue([{ path: 'private/local.md', type: LocalChangeType.MODIFY }]);

		await syncEngine.performSync();

		expect(mockEventManager.removeDirtyPaths).toHaveBeenCalledWith(['private/local.md']);
		expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
	});

	it('ignores default temporary file patterns for local changes', async () => {
		stateManager.setLastSyncTime(Date.now());
		const ignoredPaths = [
			'~$anything.docx',
			'~$foo.pptx',
			'A/B/~$foo.xlsx',
			'something.tmp',
			'A/B/something.tmp',
			'.~lock.file.odt#',
			'.DS_Store',
			'A/.DS_Store',
			'Thumbs.db',
			'A/Thumbs.db',
			'desktop.ini',
			'A/B/desktop.ini',
		];
		mockEventManager.getDirtyFiles.mockReturnValue(
			ignoredPaths.map((path) => ({ path, type: LocalChangeType.MODIFY }))
		);

		await syncEngine.performSync();

		expect(mockEventManager.removeDirtyPaths).toHaveBeenCalledWith(ignoredPaths);
		expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
	});

	it('does not ignore normal files that resemble temporary patterns', async () => {
		stateManager.setLastSyncTime(Date.now());
		const normalPaths = ['Notes.md', 'A/B/report.docx', 'photo.png', 'weird~$name.md', 'data.tmpl'];
		mockEventManager.getDirtyFiles.mockReturnValue(
			normalPaths.map((path) => ({ path, type: LocalChangeType.MODIFY }))
		);
		mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
			makeTFile(path, 100, Date.now())
		);

		await syncEngine.performSync();

		expect(mockEventManager.removeDirtyPaths).not.toHaveBeenCalled();
		expect(mockFileOps.uploadFile.mock.calls.map((call) => call[0]).sort()).toEqual(
			normalPaths.map((path) => `/remote/root/${path}`).sort()
		);
	});

	it('filters default temporary file patterns from remote changes and deletes', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('Thumbs.db', {
			path: 'Thumbs.db',
			localMtime: 1,
			remoteHash: 'thumbs-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'thumbs-id',
		});
		mockClient.getDelta.mockResolvedValue({
			items: [
				makeRemoteFile('~$anything.docx', { id: 'office-docx-id' }),
				makeRemoteFile('~$foo.pptx', { id: 'office-pptx-id' }),
				makeRemoteFile('A/B/~$foo.xlsx', { id: 'office-xlsx-id' }),
				makeRemoteFile('something.tmp', { id: 'tmp-root-id' }),
				makeRemoteFile('A/B/something.tmp', { id: 'tmp-nested-id' }),
				makeRemoteFile('.~lock.file.odt#', { id: 'libreoffice-lock-id' }),
				makeRemoteFile('.DS_Store', { id: 'ds-store-root-id' }),
				makeRemoteFile('A/.DS_Store', { id: 'ds-store-id' }),
				makeRemoteDelete('Thumbs.db', { id: 'thumbs-id' }),
				makeRemoteFile('A/Thumbs.db', { id: 'thumbs-nested-id' }),
				makeRemoteFile('desktop.ini', { id: 'desktop-ini-root-id' }),
				makeRemoteFile('A/B/desktop.ini', { id: 'desktop-ini-id' }),
				makeRemoteFile('keep.md', { id: 'keep-id' }),
			],
			deltaLink: 'delta-link-2',
		});
		mockApp.vault.getAbstractFileByPath.mockReturnValue(makeTFile('keep.md', 10, Date.now()));

		await syncEngine.performSync();

		expect(mockFileOps.downloadFile).toHaveBeenCalledTimes(1);
		expect(mockFileOps.downloadFile).toHaveBeenCalledWith('keep-id');
		expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
	});

	it('throws and shows an error notice when sync fails', async () => {
		mockClient.getDelta.mockRejectedValue(new Error('delta failed'));

		await expect(syncEngine.performSync()).rejects.toThrow('delta failed');
		expect(trackingNotice.calls).toContainEqual(['OneDrive sync failed: delta failed', undefined]);
	});

	it('clears dirty files after a successful sync', async () => {
		stateManager.setLastSyncTime(Date.now());
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/test.md', type: LocalChangeType.MODIFY },
		]);
		mockApp.vault.getAbstractFileByPath.mockReturnValue(
			makeTFile('notes/test.md', 100, Date.now())
		);

		await syncEngine.performSync();

		expect(mockEventManager.clearDirtyFiles).toHaveBeenCalledTimes(1);
	});

	it('continues after one generic operation failure and persists sync progress', async () => {
		stateManager.setLastSyncTime(Date.now());
		mockClient.getDelta.mockResolvedValue({ items: [], deltaLink: 'delta-link-2' });
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/fails.md', type: LocalChangeType.MODIFY },
			{ path: 'notes/succeeds.md', type: LocalChangeType.MODIFY },
		]);
		mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
			makeTFile(path, 100, Date.now())
		);
		mockFileOps.uploadFile.mockImplementation(async (remotePath: string) => {
			if (remotePath.endsWith('/notes/fails.md')) {
				throw new Error('single upload failed');
			}
			return makeRemoteItem({
				id: 'succeeds-id',
				name: 'succeeds.md',
				file: { mimeType: 'text/plain', hashes: { quickXorHash: 'succeeds-hash' } },
			});
		});

		await syncEngine.performSync();

		expect(mockFileOps.uploadFile).toHaveBeenCalledTimes(2);
		expect(stateManager.getDeltaLink()).toBe('delta-link-2');
		expect(stateManager.getLastSyncTime()).toBeGreaterThan(0);
		expect(stateManager.getFileState('notes/succeeds.md')).toMatchObject({
			oneDriveId: 'succeeds-id',
		});
		expect(stateManager.getFileState('notes/fails.md')).toBeUndefined();
		expect(mockEventManager.clearDirtyFiles).not.toHaveBeenCalled();
		expect(mockEventManager.removeDirtyPaths).toHaveBeenCalledWith(['notes/succeeds.md']);
		expect(mockEventManager.addDirtyFile).toHaveBeenCalledWith('notes/fails.md', 'modify');
	});

	it.each([423, 501])('defers HTTP %s failures without aborting the sync', async (statusCode) => {
		stateManager.setLastSyncTime(Date.now());
		mockClient.getDelta.mockResolvedValue({ items: [], deltaLink: `delta-link-${statusCode}` });
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/locked.docx', type: LocalChangeType.MODIFY },
			{ path: 'notes/ok.md', type: LocalChangeType.MODIFY },
		]);
		mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
			makeTFile(path, 100, Date.now())
		);
		mockFileOps.uploadFile.mockImplementation(async (remotePath: string) => {
			if (remotePath.endsWith('/notes/locked.docx')) {
				throw new OneDriveError(`HTTP ${statusCode}`, 'transient', statusCode);
			}
			return makeRemoteItem({
				id: 'ok-id',
				name: 'ok.md',
				file: { mimeType: 'text/plain', hashes: { quickXorHash: 'ok-hash' } },
			});
		});

		await syncEngine.performSync();

		expect(stateManager.getDeltaLink()).toBe(`delta-link-${statusCode}`);
		expect(stateManager.getFileState('notes/ok.md')).toMatchObject({ oneDriveId: 'ok-id' });
		expect(stateManager.getFileState('notes/locked.docx')).toBeUndefined();
		expect(mockEventManager.addDirtyFile).toHaveBeenCalledWith('notes/locked.docx', 'modify');
		expect(trackingNotice.calls).toContainEqual([
			'OneDrive sync: 1 file synced; 1 file will retry automatically (1 locked/deferred)',
			undefined,
		]);
	});

	it('eventually syncs a locked file on a later run after advancing the delta cursor', async () => {
		stateManager.setLastSyncTime(Date.now());
		mockClient.getDelta
			.mockResolvedValueOnce({ items: [], deltaLink: 'delta-link-after-locked' })
			.mockResolvedValueOnce({ items: [], deltaLink: 'delta-link-after-success' });
		mockEventManager.getDirtyFiles
			.mockReturnValueOnce([
				{ path: 'notes/locked.docx', type: LocalChangeType.MODIFY },
				{ path: 'notes/other.md', type: LocalChangeType.MODIFY },
			])
			.mockReturnValueOnce([{ path: 'notes/locked.docx', type: LocalChangeType.MODIFY }]);
		mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
			makeTFile(path, 100, Date.now())
		);
		mockFileOps.uploadFile.mockImplementation(async (remotePath: string) => {
			if (remotePath.endsWith('/notes/locked.docx')) {
				throw new OneDriveError('Locked', 'locked', 423);
			}
			return makeRemoteItem({
				id: 'other-id',
				name: 'other.md',
				file: { mimeType: 'text/plain', hashes: { quickXorHash: 'other-hash' } },
			});
		});

		await syncEngine.performSync();

		expect(stateManager.getDeltaLink()).toBe('delta-link-after-locked');
		expect(stateManager.getFileState('notes/locked.docx')).toBeUndefined();
		expect(mockEventManager.addDirtyFile).toHaveBeenCalledWith('notes/locked.docx', 'modify');

		mockFileOps.uploadFile.mockImplementation(async (remotePath: string) =>
			makeRemoteItem({
				id: remotePath.endsWith('/notes/locked.docx') ? 'locked-id' : 'other-id',
				name: remotePath.split('/').pop() ?? 'uploaded.md',
				file: { mimeType: 'text/plain', hashes: { quickXorHash: 'uploaded-hash' } },
			})
		);

		await syncEngine.performSync();

		expect(stateManager.getDeltaLink()).toBe('delta-link-after-success');
		expect(stateManager.getFileState('notes/locked.docx')).toMatchObject({
			oneDriveId: 'locked-id',
			remoteHash: 'uploaded-hash',
		});
		expect(mockEventManager.clearDirtyFiles).toHaveBeenCalledTimes(1);
	});

	it('collects multiple operation failures while completing the remaining operations', async () => {
		stateManager.setLastSyncTime(Date.now());
		mockClient.getDelta.mockResolvedValue({ items: [], deltaLink: 'delta-link-multi' });
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/fails-a.md', type: LocalChangeType.MODIFY },
			{ path: 'notes/ok-a.md', type: LocalChangeType.MODIFY },
			{ path: 'notes/fails-b.md', type: LocalChangeType.MODIFY },
			{ path: 'notes/ok-b.md', type: LocalChangeType.MODIFY },
		]);
		mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
			makeTFile(path, 100, Date.now())
		);
		mockFileOps.uploadFile.mockImplementation(async (remotePath: string) => {
			const name = remotePath.split('/').pop() ?? remotePath;
			if (name.startsWith('fails-')) {
				throw new Error(`${name} failed`);
			}
			return makeRemoteItem({
				id: `${name}-id`,
				name,
				file: { mimeType: 'text/plain', hashes: { quickXorHash: `${name}-hash` } },
			});
		});

		await syncEngine.performSync();

		expect(mockFileOps.uploadFile).toHaveBeenCalledTimes(4);
		expect(stateManager.getDeltaLink()).toBe('delta-link-multi');
		expect(stateManager.getFileState('notes/ok-a.md')).toBeDefined();
		expect(stateManager.getFileState('notes/ok-b.md')).toBeDefined();
		expect(stateManager.getFileState('notes/fails-a.md')).toBeUndefined();
		expect(stateManager.getFileState('notes/fails-b.md')).toBeUndefined();
		expect(mockEventManager.addDirtyFile).toHaveBeenCalledWith('notes/fails-a.md', 'modify');
		expect(mockEventManager.addDirtyFile).toHaveBeenCalledWith('notes/fails-b.md', 'modify');
		expect(trackingNotice.calls).toContainEqual([
			'OneDrive sync: 2 files synced; 2 files will retry automatically (0 locked/deferred)',
			undefined,
		]);
	});

	it('backfills missing config file hashes without generating a modify change', async () => {
		const configPath = '.obsidian/app.json';
		const content = new TextEncoder().encode('{"theme":"moonstone"}');
		const expectedHash = hashContent(content);

		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState(configPath, {
			path: configPath,
			localMtime: 100,
			remoteHash: 'remote-hash',
			size: 10,
			remoteModifiedTime: 200,
			oneDriveId: 'config-id',
			localContentHash: undefined,
		});
		syncEngine = new SyncEngine(
			mockApp as any,
			mockFileOps as any,
			mockClient as any,
			stateManager,
			conflictResolver,
			mockEventManager as any,
			'.obsidian',
			{
				remoteRoot: '/remote/root',
				shouldSyncPath: (path) => path === configPath,
			}
		);
		mockApp.vault.adapter.stat.mockImplementation(async (path: string) =>
			path === configPath
				? { type: 'file', mtime: 300, size: content.byteLength, ctime: 0 }
				: null
		);
		mockApp.vault.adapter.readBinary.mockImplementation(async (path: string) =>
			path === configPath ? content.buffer.slice(0) : new ArrayBuffer(0)
		);

		await syncEngine.performSync();

		expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
		expect(stateManager.getFileState(configPath)).toMatchObject({
			path: configPath,
			localMtime: 300,
			size: content.byteLength,
			localContentHash: expectedHash,
		});
	});

	it('uploads config files when the stored hash differs from the current content hash', async () => {
		const configPath = '.obsidian/app.json';
		const content = new TextEncoder().encode('{"theme":"ember"}');
		const expectedHash = hashContent(content);

		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState(configPath, {
			path: configPath,
			localMtime: 100,
			remoteHash: 'remote-hash',
			size: 10,
			remoteModifiedTime: 200,
			oneDriveId: 'config-id',
			localContentHash: 'previous-hash',
		});
		syncEngine = new SyncEngine(
			mockApp as any,
			mockFileOps as any,
			mockClient as any,
			stateManager,
			conflictResolver,
			mockEventManager as any,
			'.obsidian',
			{
				remoteRoot: '/remote/root',
				shouldSyncPath: (path) => path === configPath,
			}
		);
		mockApp.vault.adapter.stat.mockImplementation(async (path: string) =>
			path === configPath
				? { type: 'file', mtime: 300, size: content.byteLength, ctime: 0 }
				: null
		);
		mockApp.vault.adapter.readBinary.mockImplementation(async (path: string) =>
			path === configPath ? content.buffer.slice(0) : new ArrayBuffer(0)
		);

		await syncEngine.performSync();

		expect(mockFileOps.uploadFile).toHaveBeenCalledWith(
			'/remote/root/.obsidian/app.json',
			expect.any(ArrayBuffer)
		);
		expect(stateManager.getFileState(configPath)).toMatchObject({
			path: configPath,
			localContentHash: expectedHash,
		});
	});

	it('updates tracked mtime without uploading when a config file hash still matches', async () => {
		const configPath = '.obsidian/app.json';
		const content = new TextEncoder().encode('{"theme":"moonstone"}');
		const expectedHash = hashContent(content);

		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState(configPath, {
			path: configPath,
			localMtime: 100,
			remoteHash: 'remote-hash',
			size: 10,
			remoteModifiedTime: 200,
			oneDriveId: 'config-id',
			localContentHash: expectedHash,
		});
		syncEngine = new SyncEngine(
			mockApp as any,
			mockFileOps as any,
			mockClient as any,
			stateManager,
			conflictResolver,
			mockEventManager as any,
			'.obsidian',
			{
				remoteRoot: '/remote/root',
				shouldSyncPath: (path) => path === configPath,
			}
		);
		mockApp.vault.adapter.stat.mockImplementation(async (path: string) =>
			path === configPath
				? { type: 'file', mtime: 350, size: content.byteLength, ctime: 0 }
				: null
		);
		mockApp.vault.adapter.readBinary.mockImplementation(async (path: string) =>
			path === configPath ? content.buffer.slice(0) : new ArrayBuffer(0)
		);

		await syncEngine.performSync();

		expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
		expect(stateManager.getFileState(configPath)).toMatchObject({
			path: configPath,
			localMtime: 350,
			size: content.byteLength,
			localContentHash: expectedHash,
		});
	});

	it('clearDeltaLink resets delta cursors, file states, and lastSyncTime', () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setDeltaLink('main-delta');
		stateManager.setObsidianDeltaLink('obsidian-delta');
		stateManager.setFileState('notes/keep.md', {
			path: 'notes/keep.md',
			localMtime: 1,
			remoteHash: 'abc',
			size: 10,
			remoteModifiedTime: 1,
			oneDriveId: 'id-1',
		});

		stateManager.clearDeltaLink();

		expect(stateManager.getDeltaLink()).toBeUndefined();
		expect(stateManager.getObsidianDeltaLink()).toBeUndefined();
		expect(stateManager.getFileState('notes/keep.md')).toBeUndefined();
		expect(stateManager.isFirstSync()).toBe(true);
	});

	it('removes downloaded paths from the dirty set', async () => {
		stateManager.setLastSyncTime(Date.now());
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteFile('notes/test.md', { id: 'remote-id' })],
			deltaLink: 'delta-link-2',
		});
		mockApp.vault.getAbstractFileByPath.mockReturnValue(makeTFile('notes/test.md', 10, Date.now()));

		await syncEngine.performSync();

		expect(mockEventManager.removeDirtyPaths).toHaveBeenCalledWith(['notes/test.md']);
	});

	it('shows a persistent progress notice for five or more operations', async () => {
		stateManager.setLastSyncTime(Date.now());
		const changes = Array.from({ length: 5 }, (_, index) => ({
			path: `notes/file-${index}.md`,
			type: LocalChangeType.MODIFY,
		}));
		mockEventManager.getDirtyFiles.mockReturnValue(changes);
		mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
			makeTFile(path, 10, Date.now())
		);

		await syncEngine.performSync();

		expect(trackingNotice.calls).toContainEqual(['Syncing: 0/5 files...', 0]);
	});

	describe('notification level', () => {
		function makeEngineWithLevel(level: 'all' | 'errors' | 'off') {
			return new SyncEngine(
				mockApp as any,
				mockFileOps as any,
				mockClient as any,
				stateManager,
				conflictResolver,
				mockEventManager as any,
				'.obsidian',
				{ remoteRoot: '/remote/root', getNotificationLevel: () => level }
			);
		}

		function seedFiveModifies() {
			stateManager.setLastSyncTime(Date.now());
			const changes = Array.from({ length: 5 }, (_, index) => ({
				path: `notes/file-${index}.md`,
				type: LocalChangeType.MODIFY,
			}));
			mockEventManager.getDirtyFiles.mockReturnValue(changes);
			mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
				makeTFile(path, 10, Date.now())
			);
		}

		it("suppresses the happy-path progress notice at 'errors' level", async () => {
			seedFiveModifies();

			await makeEngineWithLevel('errors').performSync();

			expect(trackingNotice.calls).not.toContainEqual(['Syncing: 0/5 files...', 0]);
		});

		it("shows the progress notice at 'all' level", async () => {
			seedFiveModifies();

			await makeEngineWithLevel('all').performSync();

			expect(trackingNotice.calls).toContainEqual(['Syncing: 0/5 files...', 0]);
		});

		it("still shows the error notice at 'errors' level when sync fails", async () => {
			mockClient.getDelta.mockRejectedValue(new Error('delta failed'));

			await expect(makeEngineWithLevel('errors').performSync()).rejects.toThrow('delta failed');
			expect(trackingNotice.calls).toContainEqual(['OneDrive sync failed: delta failed', undefined]);
		});

		it("suppresses even error notices at 'off' level", async () => {
			mockClient.getDelta.mockRejectedValue(new Error('delta failed'));

			await expect(makeEngineWithLevel('off').performSync()).rejects.toThrow('delta failed');
			expect(trackingNotice.calls).not.toContainEqual([
				'OneDrive sync failed: delta failed',
				undefined,
			]);
		});
	});

	it('runs multiple sync operations in parallel', async () => {
		stateManager.setLastSyncTime(Date.now());
		const changes = Array.from({ length: 3 }, (_, index) => ({
			path: `notes/file-${index}.md`,
			type: LocalChangeType.MODIFY,
		}));
		const pendingUploads = new Map<string, () => void>();
		let resolveAllUploadsStarted!: () => void;
		const allUploadsStarted = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error('Timed out waiting for uploads to start')),
				1000
			);
			resolveAllUploadsStarted = () => {
				clearTimeout(timeout);
				resolve();
			};
		});
		let activeUploads = 0;
		let maxActiveUploads = 0;

		mockEventManager.getDirtyFiles.mockReturnValue(changes);
		mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
			makeTFile(path, 10, Date.now())
		);
		mockFileOps.uploadFile.mockImplementation(
			(remotePath: string) =>
				new Promise((resolve) => {
					activeUploads++;
					maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
					pendingUploads.set(remotePath, () => {
						activeUploads--;
						resolve(
							makeRemoteItem({
								id: `${remotePath}-id`,
								name: remotePath.split('/').pop() ?? remotePath,
								file: { mimeType: 'text/plain', hashes: { quickXorHash: `${remotePath}-hash` } },
							})
						);
					});
					if (pendingUploads.size === changes.length) {
						resolveAllUploadsStarted();
					}
				})
		);

		const syncPromise = syncEngine.performSync();

		await allUploadsStarted;
		expect(pendingUploads.size).toBe(3);
		expect(maxActiveUploads).toBeGreaterThan(1);

		for (const resolveUpload of pendingUploads.values()) {
			resolveUpload();
		}

		await syncPromise;
	});

	it('handles folder renames using atomic move API', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFolderState('old-folder-id', 'old-folder');
		stateManager.setFileState('old-folder/test.md', {
			path: 'old-folder/test.md',
			localMtime: 1,
			remoteHash: 'hash',
			size: 100,
			remoteModifiedTime: 1,
			oneDriveId: 'file-id',
		});
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'new-folder', type: LocalChangeType.FOLDER_RENAME, oldPath: 'old-folder' },
		]);
		mockFileOps.moveFile.mockResolvedValue(
			makeRemoteItem({
				id: 'old-folder-id',
				name: 'new-folder',
				folder: {},
			})
		);

		await syncEngine.performSync();

		expect(mockFileOps.moveFile).toHaveBeenCalledWith('old-folder-id', '/remote/root/new-folder');
		// Old folder state should be removed
		expect(stateManager.getFolderIdByPath('old-folder')).toBeUndefined();
		// New folder state should be set
		expect(stateManager.getFolderIdByPath('new-folder')).toBe('old-folder-id');
		// Child file state should be updated to new path
		expect(stateManager.getFileState('old-folder/test.md')).toBeUndefined();
		expect(stateManager.getFileState('new-folder/test.md')).toBeDefined();
	});

	it('creates folder at new path when folder rename has no tracked state', async () => {
		// Create fresh stateManager to ensure isolation
		const freshStateManager = new SyncStateManager();
		freshStateManager.setLastSyncTime(Date.now());
		
		// Reset getRoot to return empty folder tree (may be polluted by previous tests)
		const emptyRoot = { path: '', children: [] };
		mockApp.vault.getRoot.mockReturnValue(emptyRoot);
		
		// No folder state for 'untitled' - simulates untracked folder
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'MyFolder', type: LocalChangeType.FOLDER_RENAME, oldPath: 'Untitled' },
		]);
		// Reset and re-mock createFolder to capture the returned item
		const createFolderMock = vi.fn().mockResolvedValue(
			makeRemoteItem({
				id: 'new-folder-id',
				name: 'MyFolder',
				folder: {},
			})
		);
		const testFileOps = {
			...mockFileOps,
			createFolder: createFolderMock,
		};

		// Create a new SyncEngine with fresh state
		const freshSyncEngine = new SyncEngine(
			mockApp as any,
			testFileOps as any,
			mockClient as any,
			freshStateManager,
			conflictResolver,
			mockEventManager as any,
			'.obsidian',
			{ remoteRoot: '/remote/root' }
		);

		await freshSyncEngine.performSync();

		expect(mockFileOps.moveFile).not.toHaveBeenCalled();
		expect(createFolderMock).toHaveBeenCalledWith('/remote/root/MyFolder');
		expect(freshStateManager.getFolderIdByPath('MyFolder')).toBe('new-folder-id');
	});
});


describe('SyncEngine large-delete circuit breaker', () => {
	let stateManager: SyncStateManager;
	let conflictResolver: ConflictResolver;
	let mockFileOps: any;
	let mockClient: any;
	let mockEventManager: any;

	beforeEach(() => {
		stateManager = new SyncStateManager();
		conflictResolver = new ConflictResolver(ConflictResolutionStrategy.LAST_WRITE_WINS);
		mockFileOps = {
			uploadFile: vi.fn().mockResolvedValue({ id: 'uploaded-id', size: 100 }),
			downloadFile: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
			deleteFile: vi.fn().mockResolvedValue(undefined),
			moveFile: vi.fn().mockResolvedValue({ id: 'moved-id', size: 100 }),
		};
		mockClient = {
			getDelta: vi.fn().mockResolvedValue({ items: [], deltaLink: 'delta-link-1' }),
			isSharedDrive: vi.fn().mockReturnValue(false),
		};
		mockEventManager = {
			getDirtyFiles: vi.fn().mockReturnValue([]),
			clearDirtyFiles: vi.fn(),
			addDirtyFile: vi.fn(),
			removeDirtyPaths: vi.fn(),
			markOwnWrites: vi.fn(),
			isOwnWrite: vi.fn().mockReturnValue(false),
			markInitialSyncDone: vi.fn(),
		};
	});

	function makeEngine(threshold: number, handler?: any) {
		return new SyncEngine(
			mockApp as any,
			mockFileOps,
			mockClient,
			stateManager,
			conflictResolver,
			mockEventManager,
			'.obsidian',
			{
				remoteRoot: '/remote/root',
				shouldSyncPath: () => true,
				getLargeDeleteThreshold: () => threshold,
				largeDeleteWarningHandler: handler,
			}
		);
	}

	function seedDeletes(remoteDeleteCount: number) {
		// Establish state so the engine knows the files existed; not first sync.
		stateManager.setLastSyncTime(Date.now());
		stateManager.setDeltaLink('prev-delta');
		const deletes = Array.from({ length: remoteDeleteCount }, (_, i) =>
			makeRemoteDelete(`notes/gone-${i}.md`, { id: `gone-${i}-id` })
		);
		for (let i = 0; i < remoteDeleteCount; i++) {
			const path = `notes/gone-${i}.md`;
			stateManager.setFileState(path, {
				path,
				localMtime: 1,
				remoteHash: 'h',
				size: 10,
				remoteModifiedTime: 1,
				oneDriveId: `gone-${i}-id`,
			});
			(mockApp.vault.getAbstractFileByPath as Mock).mockImplementation((p: string) =>
				p.startsWith('notes/gone-') ? makeTFile(p, 10, Date.now()) : null
			);
		}
		mockClient.getDelta.mockResolvedValue({ items: deletes, deltaLink: 'next-delta' });
	}

	it('does not warn when delete count is below the threshold', async () => {
		const handler = vi.fn();
		const engine = makeEngine(10, handler);
		seedDeletes(3);

		await engine.performSync();

		expect(handler).not.toHaveBeenCalled();
		expect(mockApp.fileManager.trashFile).toHaveBeenCalled();
		expect(stateManager.getDeltaLink()).toBe('next-delta');
	});

	it('does not warn when threshold is 0 (disabled)', async () => {
		const handler = vi.fn();
		const engine = makeEngine(0, handler);
		seedDeletes(50);

		await engine.performSync();

		expect(handler).not.toHaveBeenCalled();
		expect(mockApp.fileManager.trashFile).toHaveBeenCalled();
	});

	it('asks the handler when delete count meets the threshold and proceeds on "proceed"', async () => {
		const handler = vi.fn().mockResolvedValue('proceed');
		const engine = makeEngine(5, handler);
		seedDeletes(7);

		await engine.performSync();

		expect(handler).toHaveBeenCalledTimes(1);
		const info = handler.mock.calls[0][0];
		expect(info.localDeleteCount).toBe(7);
		expect(info.remoteDeleteCount).toBe(0);
		expect(info.sampleLocalDeletes).toHaveLength(7);
		expect(mockApp.fileManager.trashFile).toHaveBeenCalledTimes(7);
		expect(stateManager.getDeltaLink()).toBe('next-delta');
	});

	it('aborts without advancing the delta cursor when the user cancels', async () => {
		const handler = vi.fn().mockResolvedValue('cancel');
		const engine = makeEngine(5, handler);
		seedDeletes(7);

		await engine.performSync();

		expect(handler).toHaveBeenCalledTimes(1);
		expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
		// Cursor still points at the pre-sync value so the user gets re-prompted next time.
		expect(stateManager.getDeltaLink()).toBe('prev-delta');
	});

	it('aborts without advancing the delta cursor when the user picks "disable"', async () => {
		const handler = vi.fn().mockResolvedValue('disable');
		const engine = makeEngine(5, handler);
		seedDeletes(7);

		await engine.performSync();

		expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
		expect(stateManager.getDeltaLink()).toBe('prev-delta');
	});

	it('skips the warning on first sync even when many files would be touched', async () => {
		const handler = vi.fn();
		const engine = makeEngine(5, handler);
		// First sync: no prior deltaLink, no prior lastSyncTime.
		const deletes = Array.from({ length: 10 }, (_, i) =>
			makeRemoteDelete(`notes/gone-${i}.md`, { id: `gone-${i}-id` })
		);
		mockClient.getDelta.mockResolvedValue({ items: deletes, deltaLink: 'first-delta' });

		await engine.performSync();

		expect(handler).not.toHaveBeenCalled();
	});
});


describe('SyncEngine first-sync local vault enumeration', () => {
	let stateManager: SyncStateManager;
	let conflictResolver: ConflictResolver;
	let mockFileOps: any;
	let mockClient: any;
	let mockEventManager: any;

	beforeEach(() => {
		stateManager = new SyncStateManager();
		conflictResolver = new ConflictResolver(ConflictResolutionStrategy.LAST_WRITE_WINS);
		mockFileOps = {
			uploadFile: vi.fn().mockResolvedValue({ id: 'uploaded-id', size: 100 }),
			downloadFile: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
			deleteFile: vi.fn().mockResolvedValue(undefined),
			moveFile: vi.fn().mockResolvedValue({ id: 'moved-id', size: 100 }),
		};
		mockClient = {
			getDelta: vi.fn().mockResolvedValue({ items: [], deltaLink: 'first-delta' }),
			isSharedDrive: vi.fn().mockReturnValue(false),
		};
		mockEventManager = {
			getDirtyFiles: vi.fn().mockReturnValue([]),
			clearDirtyFiles: vi.fn(),
			addDirtyFile: vi.fn(),
			removeDirtyPaths: vi.fn(),
			markOwnWrites: vi.fn(),
			isOwnWrite: vi.fn().mockReturnValue(false),
			markInitialSyncDone: vi.fn(),
		};
	});

	function makeEngine() {
		return new SyncEngine(
			mockApp as any,
			mockFileOps,
			mockClient,
			stateManager,
			conflictResolver,
			mockEventManager,
			'.obsidian',
			{ remoteRoot: '/remote/root' }
		);
	}

	it('uploads local-only files on first sync even when the dirty queue is empty', async () => {
		// Phone has notes that OneDrive has never seen — empty remote delta.
		const localFiles = [
			makeTFile('notes/keep.md', 10, Date.now()),
			makeTFile('Home/idea.md', 20, Date.now()),
		];
		(mockApp.vault.getFiles as Mock).mockReturnValue(localFiles);
		(mockApp.vault.getAbstractFileByPath as Mock).mockImplementation(
			(p: string) => localFiles.find((f) => f.path === p) ?? null
		);

		await makeEngine().performSync();

		const uploadedPaths = mockFileOps.uploadFile.mock.calls.map((c: any[]) => c[0]).sort();
		expect(uploadedPaths).toEqual(['/remote/root/Home/idea.md', '/remote/root/notes/keep.md']);
	});

	it('does not duplicate uploads for files already matched by remote on first sync', async () => {
		const localFiles = [
			makeTFile('notes/keep.md', 100, Date.now()), // same size as remote — should size-match
			makeTFile('notes/local-only.md', 50, Date.now()),
		];
		(mockApp.vault.getFiles as Mock).mockReturnValue(localFiles);
		(mockApp.vault.getAbstractFileByPath as Mock).mockImplementation(
			(p: string) => localFiles.find((f) => f.path === p) ?? null
		);
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteFile('notes/keep.md', { id: 'remote-keep', size: 100 })],
			deltaLink: 'first-delta',
		});

		await makeEngine().performSync();

		const uploadedPaths = mockFileOps.uploadFile.mock.calls.map((c: any[]) => c[0]);
		expect(uploadedPaths).toEqual(['/remote/root/notes/local-only.md']);
	});

	it('ignores first-sync create events for files that already exist remotely', async () => {
		const localFiles = [makeTFile('notes/keep.md', 100, Date.now())];
		(mockApp.vault.getFiles as Mock).mockReturnValue(localFiles);
		(mockApp.vault.getAbstractFileByPath as Mock).mockImplementation(
			(p: string) => localFiles.find((f) => f.path === p) ?? null
		);
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/keep.md', type: LocalChangeType.CREATE },
		]);
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteFile('notes/keep.md', { id: 'remote-keep', size: 100 })],
			deltaLink: 'first-delta',
		});

		await makeEngine().performSync();

		expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
		expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
		expect(stateManager.getFileState('notes/keep.md')).toBeDefined();
	});

	// Sibling-case 1: remote item is deleted — the CREATE dirty entry must NOT be
	// suppressed; the file should be re-uploaded so it reappears in OneDrive.
	it('does not suppress first-sync create events when the remote item is deleted', async () => {
		const localFiles = [makeTFile('notes/revived.md', 50, Date.now())];
		(mockApp.vault.getFiles as Mock).mockReturnValue(localFiles);
		(mockApp.vault.getAbstractFileByPath as Mock).mockImplementation(
			(p: string) => localFiles.find((f) => f.path === p) ?? null
		);
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/revived.md', type: LocalChangeType.CREATE },
		]);
		// Remote has a tombstone for this path
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteFile('notes/revived.md', { id: 'remote-revived', size: 50, deleted: { '@odata.type': '#microsoft.graph.deleted' } as any })],
			deltaLink: 'first-delta',
		});

		await makeEngine().performSync();

		// The file was deleted remotely — local CREATE must win and re-upload it.
		expect(mockFileOps.uploadFile).toHaveBeenCalled();
	});

	// Sibling-case 2: file exists remotely but with a different size — the CREATE
	// guard skips the local change, then the remote-pass downloads the remote version.
	it('downloads remote version when first-sync create event exists but sizes differ', async () => {
		const localFiles = [makeTFile('notes/conflict.md', 100, Date.now())];
		(mockApp.vault.getFiles as Mock).mockReturnValue(localFiles);
		(mockApp.vault.getAbstractFileByPath as Mock).mockImplementation(
			(p: string) => localFiles.find((f) => f.path === p) ?? null
		);
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/conflict.md', type: LocalChangeType.CREATE },
		]);
		// Remote has the same file but with a different size
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteFile('notes/conflict.md', { id: 'remote-conflict', size: 200 })],
			deltaLink: 'first-delta',
		});

		await makeEngine().performSync();

		// CREATE is ignored; remote size differs → remote wins → download.
		expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
		expect(mockFileOps.downloadFile).toHaveBeenCalled();
	});

	// Sibling-case 3: on a subsequent (non-first) sync, CREATE dirty entries must
	// not be filtered — they represent genuine new local files and should upload.
	it('uploads new files via dirty-queue CREATE on a subsequent sync', async () => {
		// Establish prior sync state so isFirstSync() is false.
		stateManager.setLastSyncTime(Date.now());
		stateManager.setDeltaLink('prev-delta');
		const localFiles = [makeTFile('notes/new-file.md', 30, Date.now())];
		(mockApp.vault.getFiles as Mock).mockReturnValue(localFiles);
		(mockApp.vault.getAbstractFileByPath as Mock).mockImplementation(
			(p: string) => localFiles.find((f) => f.path === p) ?? null
		);
		// Dirty queue has a CREATE for a file that also appears remotely
		// (e.g. synced from another device).  On a subsequent sync this is
		// a genuine conflict/upload, not startup noise.
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/new-file.md', type: LocalChangeType.CREATE },
		]);
		mockClient.getDelta.mockResolvedValue({
			items: [],
			deltaLink: 'next-delta',
		});

		await makeEngine().performSync();

		// Non-first-sync: CREATE must not be suppressed.
		expect(mockFileOps.uploadFile).toHaveBeenCalled();
		const uploadedPath = mockFileOps.uploadFile.mock.calls[0][0];
		expect(uploadedPath).toContain('new-file.md');
	});

	// Sibling-case 4: first-sync CREATE for a purely local file (no remote match)
	// must still be uploaded even through the dirty queue.
	it('uploads local-only files via dirty-queue CREATE on first sync', async () => {
		const localFiles = [makeTFile('notes/brand-new.md', 40, Date.now())];
		(mockApp.vault.getFiles as Mock).mockReturnValue(localFiles);
		(mockApp.vault.getAbstractFileByPath as Mock).mockImplementation(
			(p: string) => localFiles.find((f) => f.path === p) ?? null
		);
		// Dirty queue has a CREATE but no matching remote item
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/brand-new.md', type: LocalChangeType.CREATE },
		]);
		mockClient.getDelta.mockResolvedValue({
			items: [],
			deltaLink: 'first-delta',
		});

		await makeEngine().performSync();

		// The file has no remote counterpart — must be uploaded.
		expect(mockFileOps.uploadFile).toHaveBeenCalled();
		const uploadedPath = mockFileOps.uploadFile.mock.calls[0][0];
		expect(uploadedPath).toContain('brand-new.md');
	});

	it('skips local files that should not be synced (e.g. the log folder)', async () => {
		const localFiles = [
			makeTFile('notes/keep.md', 10, Date.now()),
			makeTFile('_OneDriveSyncLogs/2026-06-04.md', 999, Date.now()),
		];
		(mockApp.vault.getFiles as Mock).mockReturnValue(localFiles);
		(mockApp.vault.getAbstractFileByPath as Mock).mockImplementation(
			(p: string) => localFiles.find((f) => f.path === p) ?? null
		);

		await makeEngine().performSync();

		const uploadedPaths = mockFileOps.uploadFile.mock.calls.map((c: any[]) => c[0]);
		expect(uploadedPaths).toEqual(['/remote/root/notes/keep.md']);
	});

	it('does not enumerate local files on subsequent (non-first) syncs', async () => {
		// Establish prior sync state so isFirstSync() is false.
		stateManager.setLastSyncTime(Date.now());
		stateManager.setDeltaLink('prev-delta');
		const localFiles = [makeTFile('notes/local-only.md', 50, Date.now())];
		(mockApp.vault.getFiles as Mock).mockReturnValue(localFiles);
		(mockApp.vault.getAbstractFileByPath as Mock).mockImplementation(
			(p: string) => localFiles.find((f) => f.path === p) ?? null
		);

		await makeEngine().performSync();

		// Without an event-driven dirty entry, a non-first sync should NOT upload.
		expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
	});
});


describe('SyncEngine progress reporting', () => {
	let stateManager: SyncStateManager;
	let conflictResolver: ConflictResolver;
	let mockFileOps: any;
	let mockClient: any;
	let mockEventManager: any;

	beforeEach(() => {
		stateManager = new SyncStateManager();
		conflictResolver = new ConflictResolver(ConflictResolutionStrategy.LAST_WRITE_WINS);
		mockFileOps = {
			uploadFile: vi.fn().mockResolvedValue({ id: 'uploaded-id', size: 100 }),
			downloadFile: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
			deleteFile: vi.fn().mockResolvedValue(undefined),
			moveFile: vi.fn().mockResolvedValue({ id: 'moved-id', size: 100 }),
		};
		mockClient = {
			getDelta: vi.fn().mockResolvedValue({ items: [], deltaLink: 'first-delta' }),
			isSharedDrive: vi.fn().mockReturnValue(false),
		};
		mockEventManager = {
			getDirtyFiles: vi.fn().mockReturnValue([]),
			clearDirtyFiles: vi.fn(),
			addDirtyFile: vi.fn(),
			removeDirtyPaths: vi.fn(),
			markOwnWrites: vi.fn(),
			isOwnWrite: vi.fn().mockReturnValue(false),
			markInitialSyncDone: vi.fn(),
		};
	});

	it('emits phase progress before any operations execute and per-file progress during execution', async () => {
		const onProgress = vi.fn();
		const localFiles = [
			makeTFile('notes/a.md', 5, Date.now()),
			makeTFile('notes/b.md', 6, Date.now()),
		];
		(mockApp.vault.getFiles as Mock).mockReturnValue(localFiles);
		(mockApp.vault.getAbstractFileByPath as Mock).mockImplementation(
			(p: string) => localFiles.find((f) => f.path === p) ?? null
		);

		const engine = new SyncEngine(
			mockApp as any,
			mockFileOps,
			mockClient,
			stateManager,
			conflictResolver,
			mockEventManager,
			'.obsidian',
			{
				remoteRoot: '/remote/root',
				shouldSyncPath: () => true,
				getLargeDeleteThreshold: () => 0,
				onProgress,
			}
		);

		await engine.performSync();

		const messages = onProgress.mock.calls.map((c: any[]) => c[0]);
		// Phase markers are emitted before per-file progress starts.
		expect(messages).toContain('starting...');
		expect(messages).toContain('fetching remote changes...');
		expect(messages).toContain('planning...');
		// Per-file progress should reach the total operation count.
		expect(messages).toContain('2/2 files');
		// Final clear so the status bar drops back to idle.
		expect(messages[messages.length - 1]).toBeUndefined();
	});

	it.each(['upload', 'download'] as const)(
		'counts failed %s operations toward progress completion',
		async (direction) => {
			const onProgress = vi.fn();
			stateManager.setDeltaLink('prev-delta');
			stateManager.setLastSyncTime(Date.now());

			if (direction === 'upload') {
				mockEventManager.getDirtyFiles.mockReturnValue([
					{ path: 'notes/test.md', type: LocalChangeType.MODIFY },
				]);
				(mockApp.vault.getAbstractFileByPath as Mock).mockReturnValue(
					makeTFile('notes/test.md', 100, Date.now())
				);
				mockFileOps.uploadFile.mockRejectedValue(new Error('Upload failed'));
			} else {
				mockClient.getDelta.mockResolvedValue({
					items: [makeRemoteFile('notes/new.md', { id: 'new-id' })],
					deltaLink: 'next-delta',
				});
				(mockApp.vault.getAbstractFileByPath as Mock).mockReturnValue(null);
				mockFileOps.downloadFile.mockRejectedValue(new Error('Download failed'));
			}

			const engine = new SyncEngine(
				mockApp as any,
				mockFileOps,
				mockClient,
				stateManager,
				conflictResolver,
				mockEventManager,
				'.obsidian',
				{
					remoteRoot: '/remote/root',
					onProgress,
				}
			);

			await expect(engine.performSync()).resolves.toBeUndefined();

			const messages = onProgress.mock.calls.map((c: any[]) => c[0]);
			expect(messages).toContain('1/1 files');
			expect(messages[messages.length - 1]).toBeUndefined();
		}
	);
});


describe('SyncEngine remote-delete via id-only delta entries', () => {
	let stateManager: SyncStateManager;
	let conflictResolver: ConflictResolver;
	let mockFileOps: any;
	let mockClient: any;
	let mockEventManager: any;

	beforeEach(() => {
		stateManager = new SyncStateManager();
		conflictResolver = new ConflictResolver(ConflictResolutionStrategy.LAST_WRITE_WINS);
		mockFileOps = {
			uploadFile: vi.fn().mockResolvedValue({ id: 'uploaded-id', size: 100 }),
			downloadFile: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
			deleteFile: vi.fn().mockResolvedValue(undefined),
			moveFile: vi.fn().mockResolvedValue({ id: 'moved-id', size: 100 }),
		};
		mockClient = {
			getDelta: vi.fn(),
			isSharedDrive: vi.fn().mockReturnValue(false),
		};
		mockEventManager = {
			getDirtyFiles: vi.fn().mockReturnValue([]),
			clearDirtyFiles: vi.fn(),
			addDirtyFile: vi.fn(),
			removeDirtyPaths: vi.fn(),
			markOwnWrites: vi.fn(),
			removeOwnWrite: vi.fn(),
			isOwnWrite: vi.fn().mockReturnValue(false),
			markInitialSyncDone: vi.fn(),
		};
		(mockApp.vault.getFiles as Mock).mockReturnValue([]);
	});

	it('resolves an id-only delete entry to the tracked vault path and queues a local delete', async () => {
		const targetPath = 'notes/from-other-device.md';
		const targetId = '48043224B16FF524!sDELETEDONOTHERDEVICE';
		stateManager.setFileState(targetPath, {
			path: targetPath,
			localMtime: 1,
			remoteHash: 'h',
			size: 10,
			remoteModifiedTime: Date.now(),
			oneDriveId: targetId,
		});
		// Pretend the file exists locally so the planner queues the delete op.
		const file = makeTFile(targetPath, 10, Date.now());
		(mockApp.vault.getAbstractFileByPath as Mock).mockImplementation(
			(p: string) => (p === targetPath ? file : null)
		);

		// Microsoft Graph delete entry: id only, no name, no parentReference.
		mockClient.getDelta.mockResolvedValue({
			items: [{ id: targetId, deleted: { state: 'deleted' } } as any],
			deltaLink: 'next-delta',
		});
		// Set a delta link so isFirstSync is false (we don't want the first-sync
		// short-circuit, which doesn't issue deletes anyway).
		stateManager.setDeltaLink('prev-delta');
		stateManager.setLastSyncTime(1);

		const engine = new SyncEngine(
			mockApp as any,
			mockFileOps,
			mockClient,
			stateManager,
			conflictResolver,
			mockEventManager,
			'.obsidian',
			{ remoteRoot: '/remote/root' }
		);

		await engine.performSync();

		// The file should have been deleted locally via Obsidian's vault API.
		expect(mockApp.fileManager.trashFile).toHaveBeenCalledWith(file);
		// And its tracked state should be gone so future syncs don't trip on it.
		expect(stateManager.getFileState(targetPath)).toBeUndefined();
	});
});


describe('SyncEngine remote folder-delete expansion', () => {
	let stateManager: SyncStateManager;
	let conflictResolver: ConflictResolver;
	let mockFileOps: any;
	let mockClient: any;
	let mockEventManager: any;

	beforeEach(() => {
		stateManager = new SyncStateManager();
		conflictResolver = new ConflictResolver(ConflictResolutionStrategy.LAST_WRITE_WINS);
		mockFileOps = {
			uploadFile: vi.fn().mockResolvedValue({ id: 'uploaded-id', size: 100 }),
			downloadFile: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
			deleteFile: vi.fn().mockResolvedValue(undefined),
			moveFile: vi.fn().mockResolvedValue({ id: 'moved-id', size: 100 }),
		};
		mockClient = {
			getDelta: vi.fn(),
			isSharedDrive: vi.fn().mockReturnValue(false),
		};
		mockEventManager = {
			getDirtyFiles: vi.fn().mockReturnValue([]),
			clearDirtyFiles: vi.fn(),
			addDirtyFile: vi.fn(),
			removeDirtyPaths: vi.fn(),
			markOwnWrites: vi.fn(),
			removeOwnWrite: vi.fn(),
			isOwnWrite: vi.fn().mockReturnValue(false),
			markInitialSyncDone: vi.fn(),
		};
		(mockApp.vault.getFiles as Mock).mockReturnValue([]);
	});

	it('expands an id-only folder delete into per-file deletes for every tracked descendant', async () => {
		const folderId = 'FOLDER-ID-DELETED-ELSEWHERE';
		const folderPath = "Jeff's Notebook/Dog";
		stateManager.setFolderState(folderId, folderPath);

		const descendants = [
			{ path: `${folderPath}/Links.md`, id: 'CHILD-1' },
			{ path: `${folderPath}/Vet/Visits.md`, id: 'CHILD-2' },
		];
		for (const d of descendants) {
			stateManager.setFileState(d.path, {
				path: d.path,
				localMtime: 1,
				remoteHash: 'h',
				size: 10,
				remoteModifiedTime: Date.now(),
				oneDriveId: d.id,
			});
		}
		// Also track a file OUTSIDE the deleted folder — it must not be touched.
		stateManager.setFileState('Notes/Other.md', {
			path: 'Notes/Other.md',
			localMtime: 1,
			remoteHash: 'h',
			size: 10,
			remoteModifiedTime: Date.now(),
			oneDriveId: 'OTHER-ID',
		});

		const localFiles = [
			makeTFile(descendants[0].path, 10, Date.now()),
			makeTFile(descendants[1].path, 10, Date.now()),
			makeTFile('Notes/Other.md', 10, Date.now()),
		];
		(mockApp.vault.getAbstractFileByPath as Mock).mockImplementation(
			(p: string) => localFiles.find((f) => f.path === p) ?? null
		);

		// Graph delta: a single folder-delete entry with id only.
		mockClient.getDelta.mockResolvedValue({
			items: [
				{
					id: folderId,
					deleted: { state: 'deleted' },
					folder: { childCount: 0 },
				} as any,
			],
			deltaLink: 'next-delta',
		});
		stateManager.setDeltaLink('prev-delta');
		stateManager.setLastSyncTime(1);

		const engine = new SyncEngine(
			mockApp as any,
			mockFileOps,
			mockClient,
			stateManager,
			conflictResolver,
			mockEventManager,
			'.obsidian',
			{ remoteRoot: '/remote/root' }
		);

		await engine.performSync();

		// Both descendant files should have been deleted locally.
		const deletedPaths = (mockApp.fileManager.trashFile as Mock).mock.calls.map(
			(c: any[]) => (c[0] as { path: string }).path
		);
		expect(deletedPaths).toContain(descendants[0].path);
		expect(deletedPaths).toContain(descendants[1].path);
		// The unrelated file outside the folder must remain.
		expect(deletedPaths).not.toContain('Notes/Other.md');
		// Tracked state for both descendants should be cleaned up.
		expect(stateManager.getFileState(descendants[0].path)).toBeUndefined();
		expect(stateManager.getFileState(descendants[1].path)).toBeUndefined();
		// Folder state for the deleted folder should be gone.
		expect(stateManager.getFolderPathById(folderId)).toBeUndefined();
	});
});

describe('SyncEngine reconcile from cloud', () => {
	let stateManager: SyncStateManager;
	let conflictResolver: ConflictResolver;
	let mockFileOps: any;
	let mockClient: any;
	let mockEventManager: any;

	beforeEach(() => {
		stateManager = new SyncStateManager();
		conflictResolver = new ConflictResolver(ConflictResolutionStrategy.LAST_WRITE_WINS);
		mockFileOps = {
			uploadFile: vi.fn().mockResolvedValue({ id: 'uploaded-id', size: 100 }),
			downloadFile: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
			deleteFile: vi.fn().mockResolvedValue(undefined),
			moveFile: vi.fn().mockResolvedValue({ id: 'moved-id', size: 100 }),
		};
		mockClient = {
			listAllItems: vi.fn(),
			getDelta: vi.fn().mockResolvedValue({ items: [], deltaLink: 'fresh-delta' }),
			isSharedDrive: vi.fn().mockReturnValue(false),
		};
		mockEventManager = {
			getDirtyFiles: vi.fn().mockReturnValue([]),
			clearDirtyFiles: vi.fn(),
			addDirtyFile: vi.fn(),
			removeDirtyPaths: vi.fn(),
			markOwnWrites: vi.fn(),
			removeOwnWrite: vi.fn(),
			isOwnWrite: vi.fn().mockReturnValue(false),
			markInitialSyncDone: vi.fn(),
		};
	});

	it('deletes local-only files, downloads remote-only files, refreshes matching files', async () => {
		// Cloud: A.md (matches local size), B.md (only in cloud), C.md (size mismatch)
		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile('A.md', { size: 10 }),
			makeRemoteFile('B.md', { size: 20 }),
			makeRemoteFile('C.md', { size: 30 }),
		]);

		// Local: A.md (size 10), C.md (size 99 — mismatch), D.md (local-only, should be deleted)
		const localFiles = [
			makeTFile('A.md', 10, Date.now()),
			makeTFile('C.md', 99, Date.now()),
			makeTFile('D.md', 5, Date.now()),
		];
		(mockApp.vault.getFiles as Mock).mockReturnValue(localFiles);
		(mockApp.vault.getAbstractFileByPath as Mock).mockImplementation(
			(p: string) => localFiles.find((f) => f.path === p) ?? null
		);

		const engine = new SyncEngine(
			mockApp as any,
			mockFileOps,
			mockClient,
			stateManager,
			conflictResolver,
			mockEventManager,
			'.obsidian',
			{ remoteRoot: '/remote/root' }
		);

		await engine.reconcileFromCloud();

		// D.md (local-only) should have been deleted via vault.delete
		const deletedPaths = (mockApp.fileManager.trashFile as Mock).mock.calls.map(
			(c: any[]) => (c[0] as { path: string }).path
		);
		expect(deletedPaths).toContain('D.md');
		expect(deletedPaths).not.toContain('A.md');

		// B.md and C.md should have been downloaded (size-mismatch counts as download)
		const downloadedIds = (mockFileOps.downloadFile as Mock).mock.calls.map((c: any[]) => c[0]);
		expect(downloadedIds).toContain('B.md-id');
		expect(downloadedIds).toContain('C.md-id');
		expect(downloadedIds).not.toContain('A.md-id');

		// A.md (matching size) should have tracked state refreshed without downloading
		expect(stateManager.getFileState('A.md')).toBeDefined();

		// Delta cursor should have been advanced
		expect(mockClient.getDelta).toHaveBeenCalled();
		expect(stateManager.getDeltaLink()).toBe('fresh-delta');
	});

	it('skips destructive deletes when user declines large-delete confirmation', async () => {
		// Cloud is empty; local has 10 files — all would be deleted.
		mockClient.listAllItems.mockResolvedValue([]);
		const localFiles = Array.from({ length: 10 }, (_, i) =>
			makeTFile(`Note${i}.md`, 10, Date.now())
		);
		(mockApp.vault.getFiles as Mock).mockReturnValue(localFiles);
		(mockApp.vault.getAbstractFileByPath as Mock).mockImplementation(
			(p: string) => localFiles.find((f) => f.path === p) ?? null
		);

		const handler = vi.fn().mockResolvedValue('cancel');

		const engine = new SyncEngine(
			mockApp as any,
			mockFileOps,
			mockClient,
			stateManager,
			conflictResolver,
			mockEventManager,
			'.obsidian',
			{
				remoteRoot: '/remote/root',
				shouldSyncPath: (p) => shouldSyncVaultPath(p, false, false, '.obsidian'),
				getLargeDeleteThreshold: () => 5, // threshold 5
				largeDeleteWarningHandler: handler,
			}
		);

		await engine.reconcileFromCloud();

		expect(handler).toHaveBeenCalledTimes(1);
		// No deletes should have happened.
		expect((mockApp.fileManager.trashFile as Mock).mock.calls.length).toBe(0);
		// Cursor should NOT have been advanced when user cancelled.
		expect(mockClient.getDelta).not.toHaveBeenCalled();
	});
});

describe('SyncEngine reconcile to cloud', () => {
	let stateManager: SyncStateManager;
	let conflictResolver: ConflictResolver;
	let mockFileOps: any;
	let mockClient: any;
	let mockEventManager: any;

	beforeEach(() => {
		stateManager = new SyncStateManager();
		conflictResolver = new ConflictResolver(ConflictResolutionStrategy.LAST_WRITE_WINS);
		mockFileOps = {
			uploadFile: vi.fn().mockResolvedValue({
				id: 'uploaded-id',
				size: 100,
				lastModifiedDateTime: new Date().toISOString(),
				file: { hashes: { quickXorHash: 'uploaded-hash' } },
			}),
			downloadFile: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
			deleteFile: vi.fn().mockResolvedValue(undefined),
			moveFile: vi.fn().mockResolvedValue({ id: 'moved-id', size: 100 }),
		};
		mockClient = {
			listAllItems: vi.fn(),
			getDelta: vi.fn().mockResolvedValue({ items: [], deltaLink: 'fresh-delta' }),
			isSharedDrive: vi.fn().mockReturnValue(false),
		};
		mockEventManager = {
			getDirtyFiles: vi.fn().mockReturnValue([]),
			clearDirtyFiles: vi.fn(),
			addDirtyFile: vi.fn(),
			removeDirtyPaths: vi.fn(),
			markOwnWrites: vi.fn(),
			removeOwnWrite: vi.fn(),
			isOwnWrite: vi.fn().mockReturnValue(false),
			markInitialSyncDone: vi.fn(),
		};
	});

	it('uploads local-only files, deletes remote-only files, refreshes matching files', async () => {
		// Cloud: A.md (matches local size), B.md (only in cloud, should be deleted), C.md (size mismatch)
		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile('A.md', { size: 10 }),
			makeRemoteFile('B.md', { size: 20 }),
			makeRemoteFile('C.md', { size: 30 }),
		]);

		// Local: A.md (size 10), C.md (size 99 — mismatch), D.md (local-only, should be uploaded)
		const localFiles = [
			makeTFile('A.md', 10, Date.now()),
			makeTFile('C.md', 99, Date.now()),
			makeTFile('D.md', 5, Date.now()),
		];
		(mockApp.vault.getFiles as Mock).mockReturnValue(localFiles);
		(mockApp.vault.getAbstractFileByPath as Mock).mockImplementation(
			(p: string) => localFiles.find((f) => f.path === p) ?? null
		);

		const engine = new SyncEngine(
			mockApp as any,
			mockFileOps,
			mockClient,
			stateManager,
			conflictResolver,
			mockEventManager,
			'.obsidian',
			{ remoteRoot: '/remote/root' }
		);

		await engine.reconcileToCloud();

		// D.md (local-only) and C.md (size-mismatch) should have been uploaded.
		const uploadedPaths = (mockFileOps.uploadFile as Mock).mock.calls.map((c: any[]) => c[0]);
		expect(uploadedPaths).toContain('/remote/root/D.md');
		expect(uploadedPaths).toContain('/remote/root/C.md');
		expect(uploadedPaths).not.toContain('/remote/root/A.md');

		// B.md (remote-only) should have been deleted from OneDrive.
		expect(mockFileOps.deleteFile).toHaveBeenCalledWith('B.md-id');

		// A.md (matching size) should have tracked state refreshed without uploading.
		expect(stateManager.getFileState('A.md')).toBeDefined();

		// Delta cursor should have been advanced.
		expect(mockClient.getDelta).toHaveBeenCalled();
		expect(stateManager.getDeltaLink()).toBe('fresh-delta');
	});

	it('skips destructive remote deletes when user declines large-delete confirmation', async () => {
		// Cloud has 10 files — all would be deleted since local is empty.
		mockClient.listAllItems.mockResolvedValue(
			Array.from({ length: 10 }, (_, i) => makeRemoteFile(`Note${i}.md`))
		);
		(mockApp.vault.getFiles as Mock).mockReturnValue([]);
		(mockApp.vault.getAbstractFileByPath as Mock).mockReturnValue(null);

		const handler = vi.fn().mockResolvedValue('cancel');

		const engine = new SyncEngine(
			mockApp as any,
			mockFileOps,
			mockClient,
			stateManager,
			conflictResolver,
			mockEventManager,
			'.obsidian',
			{
				remoteRoot: '/remote/root',
				shouldSyncPath: (p) => shouldSyncVaultPath(p, false, false, '.obsidian'),
				getLargeDeleteThreshold: () => 5, // threshold 5
				largeDeleteWarningHandler: handler,
			}
		);

		await engine.reconcileToCloud();

		expect(handler).toHaveBeenCalledTimes(1);
		// No deletes should have happened.
		expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
		// Cursor should NOT have been advanced when user cancelled.
		expect(mockClient.getDelta).not.toHaveBeenCalled();
	});
});

describe('SyncEngine pull-only mode', () => {
	let stateManager: SyncStateManager;
	let conflictResolver: ConflictResolver;
	let mockFileOps: any;
	let mockClient: any;
	let mockEventManager: any;

	beforeEach(() => {
		mockApp.vault.getAbstractFileByPath.mockReset();
		mockApp.vault.readBinary.mockReset().mockResolvedValue(new ArrayBuffer(10));
		mockApp.fileManager.trashFile.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.exists.mockReset().mockResolvedValue(true);
		mockApp.vault.adapter.read.mockReset().mockRejectedValue(new Error('missing .syncIgnore'));
		mockApp.vault.adapter.mkdir.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.writeBinary.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.stat.mockReset().mockResolvedValue(null);
		mockApp.vault.adapter.list.mockReset().mockResolvedValue({ files: [], folders: [] });

		stateManager = new SyncStateManager();
		conflictResolver = new ConflictResolver(ConflictResolutionStrategy.LAST_WRITE_WINS);
		mockFileOps = {
			uploadFile: vi.fn().mockResolvedValue({ id: 'uploaded-id', size: 100 }),
			downloadFile: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
			deleteFile: vi.fn().mockResolvedValue(undefined),
			moveFile: vi.fn().mockResolvedValue({ id: 'moved-id', size: 100 }),
		};
		mockClient = {
			getDelta: vi.fn().mockResolvedValue({ items: [], deltaLink: 'delta-link-1' }),
			isSharedDrive: vi.fn().mockReturnValue(false),
		};
		mockEventManager = {
			getDirtyFiles: vi.fn().mockReturnValue([]),
			clearDirtyFiles: vi.fn(),
			addDirtyFile: vi.fn(),
			removeDirtyPaths: vi.fn(),
			markOwnWrites: vi.fn(),
			removeOwnWrite: vi.fn(),
			isOwnWrite: vi.fn().mockReturnValue(false),
			markInitialSyncDone: vi.fn(),
		};
	});

	function makeEngine(isPullOnlyMode: () => boolean) {
		return new SyncEngine(
			mockApp as any,
			mockFileOps,
			mockClient,
			stateManager,
			conflictResolver,
			mockEventManager,
			'.obsidian',
			{
				remoteRoot: '/remote/root',
				shouldSyncPath: (p) => shouldSyncVaultPath(p, false, false, '.obsidian'),
				getLargeDeleteThreshold: () => 0,
				pluginVersion: 'test',
				maxConcurrentOperations: 4,
				useAtomicMoves: true,
				isPullOnlyMode,
			}
		);
	}

	it('skips local changes when pull-only mode is enabled', async () => {
		stateManager.setLastSyncTime(Date.now());
		// Local dirty file would normally trigger an upload
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/test.md', type: LocalChangeType.MODIFY },
		]);
		const localFile = makeTFile('notes/test.md', 100, Date.now());
		mockApp.vault.getAbstractFileByPath.mockReturnValue(localFile);

		const engine = makeEngine(() => true); // pull-only enabled
		await engine.performSync();

		// Should NOT upload
		expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
		// Delta should still be fetched and cursor advanced
		expect(mockClient.getDelta).toHaveBeenCalled();
		expect(stateManager.getDeltaLink()).toBe('delta-link-1');
	});

	it('still downloads remote changes when pull-only mode is enabled', async () => {
		stateManager.setLastSyncTime(Date.now());
		// Remote has a new file
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteFile('cloud-file.md')],
			deltaLink: 'delta-link-2',
		});
		mockApp.vault.adapter.exists.mockResolvedValue(false);

		const engine = makeEngine(() => true); // pull-only enabled
		await engine.performSync();

		// Should download the remote file
		expect(mockFileOps.downloadFile).toHaveBeenCalled();
		expect(stateManager.getDeltaLink()).toBe('delta-link-2');
	});

	it('uploads local changes when pull-only mode is disabled', async () => {
		stateManager.setLastSyncTime(Date.now());
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/test.md', type: LocalChangeType.MODIFY },
		]);
		const localFile = makeTFile('notes/test.md', 100, Date.now());
		mockApp.vault.getAbstractFileByPath.mockReturnValue(localFile);

		const engine = makeEngine(() => false); // pull-only disabled
		await engine.performSync();

		// Should upload
		expect(mockFileOps.uploadFile).toHaveBeenCalled();
	});

	it('respects dynamic pull-only mode toggle between syncs', async () => {
		stateManager.setLastSyncTime(Date.now());
		let pullOnlyEnabled = true;
		const engine = makeEngine(() => pullOnlyEnabled);

		// First sync with pull-only enabled
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/test.md', type: LocalChangeType.MODIFY },
		]);
		const localFile = makeTFile('notes/test.md', 100, Date.now());
		mockApp.vault.getAbstractFileByPath.mockReturnValue(localFile);

		await engine.performSync();
		expect(mockFileOps.uploadFile).not.toHaveBeenCalled();

		// Disable pull-only mode
		pullOnlyEnabled = false;
		mockFileOps.uploadFile.mockClear();

		// Second sync with pull-only disabled
		await engine.performSync();
		expect(mockFileOps.uploadFile).toHaveBeenCalled();
	});
});

describe('SyncEngine error handling', () => {
	let stateManager: SyncStateManager;
	let conflictResolver: ConflictResolver;
	let mockFileOps: any;
	let mockClient: any;
	let mockEventManager: any;
	type TrackingNoticeClass = typeof Notice & { calls: Array<[string, number | undefined]> };
	const trackingNotice = Notice as TrackingNoticeClass;

	beforeEach(() => {
		trackingNotice.calls.length = 0;
		stateManager = new SyncStateManager();
		conflictResolver = new ConflictResolver(ConflictResolutionStrategy.LAST_WRITE_WINS);
		mockFileOps = {
			uploadFile: vi.fn().mockResolvedValue({ id: 'uploaded-id', size: 100 }),
			downloadFile: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
			deleteFile: vi.fn().mockResolvedValue(undefined),
			moveFile: vi.fn().mockResolvedValue({ id: 'moved-id', size: 100 }),
		};
		mockClient = {
			getDelta: vi.fn().mockResolvedValue({ items: [], deltaLink: 'delta-link-1' }),
			isSharedDrive: vi.fn().mockReturnValue(false),
		};
		mockEventManager = {
			getDirtyFiles: vi.fn().mockReturnValue([]),
			clearDirtyFiles: vi.fn(),
			addDirtyFile: vi.fn(),
			removeDirtyPaths: vi.fn(),
			markOwnWrites: vi.fn(),
			isOwnWrite: vi.fn().mockReturnValue(false),
			markInitialSyncDone: vi.fn(),
		};
		mockApp.vault.getAbstractFileByPath.mockReset();
		mockApp.vault.readBinary.mockReset().mockResolvedValue(new ArrayBuffer(10));
		mockApp.vault.adapter.exists.mockReset().mockResolvedValue(true);
		mockApp.vault.adapter.writeBinary.mockReset().mockResolvedValue(undefined);
	});

	function makeEngine() {
		return new SyncEngine(
			mockApp as any,
			mockFileOps,
			mockClient,
			stateManager,
			conflictResolver,
			mockEventManager,
			'.obsidian',
			{ remoteRoot: '/remote/root' }
		);
	}

	it('throws and shows error notice when sync fails', async () => {
		stateManager.setLastSyncTime(Date.now());
		mockClient.getDelta.mockRejectedValue(new Error('Network error'));

		const engine = makeEngine();

		await expect(engine.performSync()).rejects.toThrow('Network error');

		const errorNotices = trackingNotice.calls.filter(([msg]) =>
			msg.includes('Network error') || msg.includes('failed')
		);
		expect(errorNotices.length).toBeGreaterThan(0);
	});

	it('keeps syncing and shows retry notice when upload fails', async () => {
		stateManager.setLastSyncTime(Date.now());
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/test.md', type: LocalChangeType.MODIFY },
		]);
		mockApp.vault.getAbstractFileByPath.mockReturnValue(makeTFile('notes/test.md', 100, Date.now()));
		mockFileOps.uploadFile.mockRejectedValue(new Error('Upload failed'));

		const engine = makeEngine();

		await expect(engine.performSync()).resolves.toBeUndefined();
		expect(stateManager.getDeltaLink()).toBe('delta-link-1');
		expect(mockEventManager.addDirtyFile).toHaveBeenCalledWith('notes/test.md', 'modify');
		expect(trackingNotice.calls).toContainEqual([
			'OneDrive sync: 0 files synced; 1 file will retry automatically (0 locked/deferred)',
			undefined,
		]);
	});

	it('keeps syncing and shows retry notice when download fails', async () => {
		stateManager.setLastSyncTime(Date.now());
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteFile('notes/new.md', { id: 'new-id' })],
			deltaLink: 'delta-2',
		});
		mockApp.vault.getAbstractFileByPath.mockReturnValue(null); // file doesn't exist locally
		mockFileOps.downloadFile.mockRejectedValue(new Error('Download failed'));

		const engine = makeEngine();

		await expect(engine.performSync()).resolves.toBeUndefined();
		expect(stateManager.getDeltaLink()).toBe('delta-2');
		expect(mockEventManager.addDirtyFile).toHaveBeenCalledWith('notes/new.md', 'modify');
		expect(trackingNotice.calls).toContainEqual([
			'OneDrive sync: 0 files synced; 1 file will retry automatically (0 locked/deferred)',
			undefined,
		]);
	});
});
