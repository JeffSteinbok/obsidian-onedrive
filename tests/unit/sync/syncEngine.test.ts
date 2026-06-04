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
import { mockApp, makeTFile } from '../../setup';
import { SyncEngine } from '../../../src/sync/syncEngine';
import { SyncStateManager } from '../../../src/sync/syncState';
import { ConflictResolver } from '../../../src/sync/conflictResolver';
import { shouldSyncVaultPath } from '../../../src/utils/pathUtils';
import {
	ConflictResolutionStrategy,
	LocalChangeType,
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

describe('SyncEngine', () => {
	let syncEngine: SyncEngine;
	let mockFileOps: { uploadFile: Mock; downloadFile: Mock; deleteFile: Mock };
	let mockClient: { getDelta: Mock; isSharedDrive: Mock };
	let stateManager: SyncStateManager;
	let conflictResolver: ConflictResolver;
	let mockEventManager: {
		getDirtyFiles: Mock;
		clearDirtyFiles: Mock;
		removeDirtyPaths: Mock;
		markOwnWrites: Mock;
		removeOwnWrite: Mock;
	};
	type TrackingNoticeClass = typeof Notice & { calls: Array<[string, number | undefined]> };
	const trackingNotice = Notice as TrackingNoticeClass;

	beforeEach(() => {
		trackingNotice.calls.length = 0;

		mockApp.vault.getAbstractFileByPath.mockReset();
		mockApp.vault.readBinary.mockReset().mockResolvedValue(new ArrayBuffer(10));
		mockApp.vault.delete.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.exists.mockReset().mockResolvedValue(true);
		mockApp.vault.adapter.read.mockReset().mockRejectedValue(new Error('missing .syncIgnore'));
		mockApp.vault.adapter.mkdir.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.writeBinary.mockReset().mockResolvedValue(undefined);

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
		};

		stateManager = new SyncStateManager();
		conflictResolver = new ConflictResolver(ConflictResolutionStrategy.LAST_WRITE_WINS);

		mockEventManager = {
			getDirtyFiles: vi.fn().mockReturnValue([]),
			clearDirtyFiles: vi.fn(),
			removeDirtyPaths: vi.fn(),
			markOwnWrites: vi.fn(),
			removeOwnWrite: vi.fn(),
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
			'/remote/root'
		);
	});

	it('shows an up to date notice when there are no changes', async () => {
		stateManager.setLastSyncTime(Date.now());

		await syncEngine.performSync();

		expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
		expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
		expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
		expect(stateManager.getDeltaLink()).toBe('delta-link-1');
		expect(trackingNotice.calls).toContainEqual([
			'OneDrive sync: Everything up to date',
			undefined,
		]);
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

	it('handles local renames by deleting old remote path and uploading new path', async () => {
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

		expect(mockFileOps.deleteFile).toHaveBeenCalledWith('old-remote-id');
		expect(mockFileOps.uploadFile).toHaveBeenCalledWith(
			'/remote/root/new.md',
			expect.any(ArrayBuffer)
		);
		expect(stateManager.getFileState('old.md')).toBeUndefined();
		expect(stateManager.getFileState('new.md')).toBeDefined();
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
			'/remote/root',
			undefined,
			undefined,
			(path) => shouldSyncVaultPath(path, true)
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

		expect(mockApp.vault.delete).toHaveBeenCalledWith(localFile);
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
			'/remote/root'
		);

		await duplicateEngine.performSync();

		expect(mockFileOps.downloadFile).toHaveBeenCalledWith('remote-id');
		expect(mockApp.vault.adapter.writeBinary).toHaveBeenCalledWith(
			expect.stringContaining(' (conflict '),
			expect.any(ArrayBuffer)
		);
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
			'/remote/root',
			undefined,
			undefined,
			(path) => shouldSyncVaultPath(path, true)
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
			'/remote/root',
			undefined,
			undefined,
			// syncPluginManifests=false, syncAppSettings=true
			(path) => shouldSyncVaultPath(path, false, true)
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
			'/remote/root',
			undefined,
			undefined,
			() => true,
			() => threshold,
			handler
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
		expect(mockApp.vault.delete).toHaveBeenCalled();
		expect(stateManager.getDeltaLink()).toBe('next-delta');
	});

	it('does not warn when threshold is 0 (disabled)', async () => {
		const handler = vi.fn();
		const engine = makeEngine(0, handler);
		seedDeletes(50);

		await engine.performSync();

		expect(handler).not.toHaveBeenCalled();
		expect(mockApp.vault.delete).toHaveBeenCalled();
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
		expect(mockApp.vault.delete).toHaveBeenCalledTimes(7);
		expect(stateManager.getDeltaLink()).toBe('next-delta');
	});

	it('aborts without advancing the delta cursor when the user cancels', async () => {
		const handler = vi.fn().mockResolvedValue('cancel');
		const engine = makeEngine(5, handler);
		seedDeletes(7);

		await engine.performSync();

		expect(handler).toHaveBeenCalledTimes(1);
		expect(mockApp.vault.delete).not.toHaveBeenCalled();
		// Cursor still points at the pre-sync value so the user gets re-prompted next time.
		expect(stateManager.getDeltaLink()).toBe('prev-delta');
	});

	it('aborts without advancing the delta cursor when the user picks "disable"', async () => {
		const handler = vi.fn().mockResolvedValue('disable');
		const engine = makeEngine(5, handler);
		seedDeletes(7);

		await engine.performSync();

		expect(mockApp.vault.delete).not.toHaveBeenCalled();
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
			'/remote/root'
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
			'/remote/root',
			undefined,
			undefined,
			() => true,
			() => 0,
			undefined,
			onProgress
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
			'/remote/root'
		);

		await engine.performSync();

		// The file should have been deleted locally via Obsidian's vault API.
		expect(mockApp.vault.delete).toHaveBeenCalledWith(file);
		// And its tracked state should be gone so future syncs don't trip on it.
		expect(stateManager.getFileState(targetPath)).toBeUndefined();
	});
});
