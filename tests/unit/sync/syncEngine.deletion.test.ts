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

import { TFolder, type TFile } from 'obsidian';
import '../../setup';
import { mockApp, makeTFile } from '../../setup';
import { SyncEngine } from '../../../src/sync/syncEngine';
import { SyncStateManager } from '../../../src/sync/syncState';
import { ConflictResolver } from '../../../src/sync/conflictResolver';
import {
	ConflictResolutionStrategy,
	LocalChangeType,
	OneDriveItem,
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

function makeRemoteFolder(
	vaultPath: string,
	overrides: Partial<OneDriveItem> & { id?: string } = {}
): OneDriveItem {
	const parts = vaultPath.split('/');
	const name = parts.pop() ?? vaultPath;
	const parent = parts.join('/');

	return makeRemoteItem({
		id: overrides.id ?? `${vaultPath}-id`,
		name,
		folder: { childCount: 0 },
		parentReference: overrides.parentReference ?? {
			id: 'parent-id',
			path: parent ? `/drive/root:/remote/root/${parent}` : '/drive/root:/remote/root',
		},
		...overrides,
	});
}

function makeTFolder(path: string): TFolder {
	const folder = new TFolder();
	folder.path = path;
	folder.name = path.split('/').pop() ?? '';
	folder.children = [];
	return folder;
}

function buildFolderTree(folderPaths: string[], filePaths: string[]) {
	const root = makeTFolder('');
	const folders = new Map<string, TFolder>([['', root]]);
	const files = new Map<string, TFile>();

	const ensureFolder = (path: string): TFolder => {
		if (folders.has(path)) {
			return folders.get(path)!;
		}
		const parentPath = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
		const parent = ensureFolder(parentPath);
		const folder = makeTFolder(path);
		parent.children.push(folder);
		folders.set(path, folder);
		return folder;
	};

	for (const folderPath of [...folderPaths].sort((a, b) => a.split('/').length - b.split('/').length)) {
		ensureFolder(folderPath);
	}

	for (const filePath of filePaths) {
		const parentPath = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
		const parent = ensureFolder(parentPath);
		const file = makeTFile(filePath, 10, Date.now());
		parent.children.push(file);
		files.set(filePath, file);
	}

	const removeChild = (path: string) => {
		const parentPath = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
		const parent = folders.get(parentPath);
		if (!parent) return;
		parent.children = parent.children.filter((child) => child.path !== path);
	};

	return {
		root,
		folders,
		files,
		getByPath(path: string) {
			return files.get(path) ?? folders.get(path) ?? null;
		},
		async trash(entry: { path: string }) {
			if (files.has(entry.path)) {
				files.delete(entry.path);
				removeChild(entry.path);
				return;
			}
			if (folders.has(entry.path)) {
				folders.delete(entry.path);
				removeChild(entry.path);
			}
		},
	};
}

describe('SyncEngine deletion permutations', () => {
	let stateManager: SyncStateManager;
	let conflictResolver: ConflictResolver;
	let mockFileOps: { uploadFile: Mock; downloadFile: Mock; deleteFile: Mock; moveFile: Mock };
	let mockClient: { getDelta: Mock; listAllItems: Mock; isSharedDrive: Mock };
	let mockEventManager: {
		getDirtyFiles: Mock;
		clearDirtyFiles: Mock;
		removeDirtyPaths: Mock;
		markOwnWrites: Mock;
		removeOwnWrite: Mock;
		isOwnWrite: Mock;
		markInitialSyncDone: Mock;
	};

	const createEngine = (shouldSyncPath: (path: string) => boolean = () => true) =>
		new SyncEngine(
			mockApp as any,
			mockFileOps as any,
			mockClient as any,
			stateManager,
			conflictResolver,
			mockEventManager as any,
			'.obsidian',
			{
				remoteRoot: '/remote/root',
				shouldSyncPath,
			}
		);

	beforeEach(() => {
		mockApp.vault.getAbstractFileByPath.mockReset().mockReturnValue(null);
		mockApp.vault.getFiles.mockReset().mockReturnValue([]);
		mockApp.vault.getRoot.mockReset().mockReturnValue(makeTFolder(''));
		mockApp.vault.readBinary.mockReset().mockResolvedValue(new ArrayBuffer(10));
		mockApp.fileManager.trashFile.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.exists.mockReset().mockResolvedValue(true);
		mockApp.vault.adapter.read.mockReset().mockRejectedValue(new Error('missing .syncIgnore'));
		mockApp.vault.adapter.mkdir.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.writeBinary.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.readBinary.mockReset().mockResolvedValue(new ArrayBuffer(10));
		mockApp.vault.adapter.remove.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.stat.mockReset().mockResolvedValue(null);
		mockApp.vault.adapter.list.mockReset().mockResolvedValue({ files: [], folders: [] });

		stateManager = new SyncStateManager();
		conflictResolver = new ConflictResolver(ConflictResolutionStrategy.LAST_WRITE_WINS);
		mockFileOps = {
			uploadFile: vi.fn().mockResolvedValue(makeRemoteFile('uploaded.md', { id: 'uploaded-id' })),
			downloadFile: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
			deleteFile: vi.fn().mockResolvedValue(undefined),
			moveFile: vi
				.fn()
				.mockImplementation((id: string) => Promise.resolve(makeRemoteFile('moved.md', { id }))),
		};
		mockClient = {
			getDelta: vi.fn().mockResolvedValue({ items: [], deltaLink: 'delta-link-next' }),
			listAllItems: vi.fn().mockResolvedValue([]),
			isSharedDrive: vi.fn().mockReturnValue(false),
		};
		mockEventManager = {
			getDirtyFiles: vi.fn().mockReturnValue([]),
			clearDirtyFiles: vi.fn(),
			removeDirtyPaths: vi.fn(),
			markOwnWrites: vi.fn(),
			removeOwnWrite: vi.fn(),
			isOwnWrite: vi.fn().mockReturnValue(false),
			markInitialSyncDone: vi.fn(),
		};
	});

	it('deletes a single tracked file remotely when it is deleted locally', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('notes/solo.md', {
			path: 'notes/solo.md',
			localMtime: 1,
			remoteHash: 'solo-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'remote-solo-id',
		});
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/solo.md', type: LocalChangeType.DELETE },
		]);

		await createEngine().performSync();

		expect(mockFileOps.deleteFile).toHaveBeenCalledTimes(1);
		expect(mockFileOps.deleteFile).toHaveBeenCalledWith('remote-solo-id');
		expect(stateManager.getFileState('notes/solo.md')).toBeUndefined();
	});

	it('queues individual remote deletes for multiple local deletions in the same folder', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('notes/a.md', {
			path: 'notes/a.md',
			localMtime: 1,
			remoteHash: 'hash-a',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'remote-a',
		});
		stateManager.setFileState('notes/b.md', {
			path: 'notes/b.md',
			localMtime: 1,
			remoteHash: 'hash-b',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'remote-b',
		});
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/a.md', type: LocalChangeType.DELETE },
			{ path: 'notes/b.md', type: LocalChangeType.DELETE },
		]);

		await createEngine().performSync();

		expect(mockFileOps.deleteFile.mock.calls.map((call) => call[0]).sort()).toEqual([
			'remote-a',
			'remote-b',
		]);
	});

	it('detects deletion of an entire plugin folder and deletes all tracked plugin files remotely', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('.obsidian/plugins/my-plugin/manifest.json', {
			path: '.obsidian/plugins/my-plugin/manifest.json',
			localMtime: 1,
			remoteHash: 'manifest-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'plugin-manifest-id',
		});
		stateManager.setFileState('.obsidian/plugins/my-plugin/main.js', {
			path: '.obsidian/plugins/my-plugin/main.js',
			localMtime: 1,
			remoteHash: 'main-hash',
			size: 20,
			remoteModifiedTime: 2,
			oneDriveId: 'plugin-main-id',
		});
		stateManager.setFileState('.obsidian/plugins/my-plugin/styles.css', {
			path: '.obsidian/plugins/my-plugin/styles.css',
			localMtime: 1,
			remoteHash: 'styles-hash',
			size: 30,
			remoteModifiedTime: 2,
			oneDriveId: 'plugin-styles-id',
		});
		stateManager.setFolderState('plugin-folder-id', '.obsidian/plugins/my-plugin');
		mockApp.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		mockApp.vault.adapter.stat.mockResolvedValue(null);

		await createEngine().performSync();

		expect(mockFileOps.deleteFile.mock.calls.map((call) => call[0]).sort()).toEqual([
			'plugin-folder-id',
			'plugin-main-id',
			'plugin-manifest-id',
			'plugin-styles-id',
		]);
		expect(stateManager.getFileState('.obsidian/plugins/my-plugin/manifest.json')).toBeUndefined();
		expect(stateManager.getFolderPathById('plugin-folder-id')).toBeUndefined();
	});

	it('queues remote deletes for all tracked files when a deleted folder contains subfolders', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('projects/active/plan.md', {
			path: 'projects/active/plan.md',
			localMtime: 1,
			remoteHash: 'plan-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'plan-id',
		});
		stateManager.setFileState('projects/archive/2024/notes.md', {
			path: 'projects/archive/2024/notes.md',
			localMtime: 1,
			remoteHash: 'archive-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'archive-id',
		});
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'projects/active/plan.md', type: LocalChangeType.DELETE },
			{ path: 'projects/archive/2024/notes.md', type: LocalChangeType.DELETE },
		]);

		await createEngine().performSync();

		expect(mockFileOps.deleteFile.mock.calls.map((call) => call[0]).sort()).toEqual([
			'archive-id',
			'plan-id',
		]);
	});

	it('handles a locally deleted file gracefully when the cloud delta already reports it deleted', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('notes/already-gone.md', {
			path: 'notes/already-gone.md',
			localMtime: 1,
			remoteHash: 'gone-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'already-gone-id',
		});
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/already-gone.md', type: LocalChangeType.DELETE },
		]);
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteDelete('notes/already-gone.md', { id: 'already-gone-id' })],
			deltaLink: 'delta-link-next',
		});

		await expect(createEngine().performSync()).resolves.toBeUndefined();

		expect(mockFileOps.deleteFile).toHaveBeenCalledWith('already-gone-id');
		expect(stateManager.getFileState('notes/already-gone.md')).toBeUndefined();
	});

	it('ignores local delete events for files that are not in tracked state', async () => {
		stateManager.setLastSyncTime(Date.now());
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/untracked.md', type: LocalChangeType.DELETE },
		]);

		await createEngine().performSync();

		expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
	});

	it('converts a config upload into a remote delete when the file vanishes before execution', async () => {
		const configPath = '.obsidian/app.json';
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState(configPath, {
			path: configPath,
			localMtime: 1,
			remoteHash: 'config-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'config-id',
		});
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: configPath, type: LocalChangeType.MODIFY },
		]);
		mockApp.vault.adapter.exists.mockResolvedValue(false);

		await createEngine((path) => path === configPath).performSync();

		expect(mockFileOps.deleteFile).toHaveBeenCalledWith('config-id');
		expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
		expect(stateManager.getFileState(configPath)).toBeUndefined();
	});

	it('deletes a local file when the cloud delta reports a single file delete', async () => {
		const localFile = makeTFile('notes/cloud-delete.md', 10, Date.now());
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('notes/cloud-delete.md', {
			path: 'notes/cloud-delete.md',
			localMtime: 1,
			remoteHash: 'hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'cloud-delete-id',
		});
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteDelete('notes/cloud-delete.md', { id: 'cloud-delete-id' })],
			deltaLink: 'delta-link-next',
		});
		mockApp.vault.getAbstractFileByPath.mockReturnValue(localFile);

		await createEngine().performSync();

		expect(mockApp.fileManager.trashFile).toHaveBeenCalledWith(localFile);
		expect(stateManager.getFileState('notes/cloud-delete.md')).toBeUndefined();
	});

	it('keeps a cloud-deleted folder when untracked local files still remain inside it', async () => {
		const tree = buildFolderTree(['notes/deleted-folder'], [
			'notes/deleted-folder/tracked.md',
			'notes/deleted-folder/untracked.md',
		]);
		stateManager.setLastSyncTime(Date.now());
		stateManager.setDeltaLink('prev-delta');
		stateManager.setFolderState('deleted-folder-id', 'notes/deleted-folder');
		stateManager.setFileState('notes/deleted-folder/tracked.md', {
			path: 'notes/deleted-folder/tracked.md',
			localMtime: 1,
			remoteHash: 'tracked-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'tracked-file-id',
		});
		mockClient.getDelta.mockResolvedValue({
			items: [{ id: 'deleted-folder-id', deleted: { state: 'deleted' }, folder: { childCount: 0 } } as any],
			deltaLink: 'delta-link-next',
		});
		mockApp.vault.getRoot.mockReturnValue(tree.root);
		mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) => tree.getByPath(path));
		mockApp.fileManager.trashFile.mockImplementation(tree.trash as any);

		await createEngine().performSync();

		expect(tree.getByPath('notes/deleted-folder/tracked.md')).toBeNull();
		expect(tree.getByPath('notes/deleted-folder/untracked.md')).not.toBeNull();
		expect(tree.getByPath('notes/deleted-folder')).not.toBeNull();
		const deletedPaths = mockApp.fileManager.trashFile.mock.calls.map((call) => call[0].path);
		expect(deletedPaths).toContain('notes/deleted-folder/tracked.md');
		expect(deletedPaths).not.toContain('notes/deleted-folder');
	});

	it('deletes a cloud-deleted folder after its tracked files are removed and the folder becomes empty', async () => {
		const tree = buildFolderTree(['notes/empty-folder'], ['notes/empty-folder/tracked.md']);
		stateManager.setLastSyncTime(Date.now());
		stateManager.setDeltaLink('prev-delta');
		stateManager.setFolderState('empty-folder-id', 'notes/empty-folder');
		stateManager.setFileState('notes/empty-folder/tracked.md', {
			path: 'notes/empty-folder/tracked.md',
			localMtime: 1,
			remoteHash: 'tracked-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'tracked-file-id',
		});
		mockClient.getDelta.mockResolvedValue({
			items: [{ id: 'empty-folder-id', deleted: { state: 'deleted' }, folder: { childCount: 0 } } as any],
			deltaLink: 'delta-link-next',
		});
		mockApp.vault.getRoot.mockReturnValue(tree.root);
		mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) => tree.getByPath(path));
		mockApp.fileManager.trashFile.mockImplementation(tree.trash as any);

		await createEngine().performSync();

		const deletedPaths = mockApp.fileManager.trashFile.mock.calls
			.map((call) => call[0].path)
			.filter(Boolean);
		expect(deletedPaths).toEqual(['notes/empty-folder/tracked.md', 'notes/empty-folder']);
		expect(tree.getByPath('notes/empty-folder')).toBeNull();
	});

	it('handles nested cloud folder deletes deepest-first so child and parent folders are both removed', async () => {
		const tree = buildFolderTree(
			['projects', 'projects/nested'],
			['projects/nested/spec.md']
		);
		stateManager.setLastSyncTime(Date.now());
		stateManager.setDeltaLink('prev-delta');
		stateManager.setFolderState('projects-id', 'projects');
		stateManager.setFolderState('nested-id', 'projects/nested');
		stateManager.setFileState('projects/nested/spec.md', {
			path: 'projects/nested/spec.md',
			localMtime: 1,
			remoteHash: 'spec-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'spec-id',
		});
		mockClient.getDelta.mockResolvedValue({
			items: [
				{ id: 'projects-id', deleted: { state: 'deleted' }, folder: { childCount: 0 } } as any,
				{ id: 'nested-id', deleted: { state: 'deleted' }, folder: { childCount: 0 } } as any,
			],
			deltaLink: 'delta-link-next',
		});
		mockApp.vault.getRoot.mockReturnValue(tree.root);
		mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) => tree.getByPath(path));
		mockApp.fileManager.trashFile.mockImplementation(tree.trash as any);

		await createEngine().performSync();

		const deletedPaths = mockApp.fileManager.trashFile.mock.calls
			.map((call) => call[0].path)
			.filter(Boolean);
		expect(deletedPaths).toEqual([
			'projects/nested/spec.md',
			'projects/nested',
			'projects',
		]);
		expect(tree.getByPath('projects')).toBeNull();
	});

	it('prunes the remote folder after local deletion removes the last tracked file in that folder', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('.obsidian/plugins/plugin-a/main.js', {
			path: '.obsidian/plugins/plugin-a/main.js',
			localMtime: 1,
			remoteHash: 'main-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'plugin-a-main-id',
		});
		stateManager.setFolderState('plugin-a-folder-id', '.obsidian/plugins/plugin-a');
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: '.obsidian/plugins/plugin-a/main.js', type: LocalChangeType.DELETE },
		]);
		mockApp.vault.adapter.stat.mockImplementation(async (path: string) =>
			path === '.obsidian/plugins/plugin-a' ? null : { type: 'file', mtime: 0, size: 0, ctime: 0 }
		);

		await createEngine().performSync();

		expect(mockFileOps.deleteFile.mock.calls.map((call) => call[0])).toEqual([
			'plugin-a-main-id',
			'plugin-a-folder-id',
		]);
		expect(stateManager.getFolderPathById('plugin-a-folder-id')).toBeUndefined();
	});

	it('does not prune a remote folder when the local folder still exists', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('notes/keep-folder/file.md', {
			path: 'notes/keep-folder/file.md',
			localMtime: 1,
			remoteHash: 'file-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'keep-file-id',
		});
		stateManager.setFolderState('keep-folder-id', 'notes/keep-folder');
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: 'notes/keep-folder/file.md', type: LocalChangeType.DELETE },
		]);
		mockApp.vault.adapter.stat.mockImplementation(async (path: string) =>
			path === 'notes/keep-folder'
				? { type: 'folder', mtime: 0, size: 0, ctime: 0 }
				: { type: 'file', mtime: 0, size: 0, ctime: 0 }
		);

		await createEngine().performSync();

		expect(mockFileOps.deleteFile).toHaveBeenCalledTimes(1);
		expect(mockFileOps.deleteFile).toHaveBeenCalledWith('keep-file-id');
		expect(stateManager.getFolderPathById('keep-folder-id')).toBe('notes/keep-folder');
	});

	it('prunes every deleted remote plugin folder independently', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setFileState('.obsidian/plugins/plugin-a/main.js', {
			path: '.obsidian/plugins/plugin-a/main.js',
			localMtime: 1,
			remoteHash: 'hash-a',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'plugin-a-main-id',
		});
		stateManager.setFileState('.obsidian/plugins/plugin-b/main.js', {
			path: '.obsidian/plugins/plugin-b/main.js',
			localMtime: 1,
			remoteHash: 'hash-b',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'plugin-b-main-id',
		});
		stateManager.setFolderState('plugin-a-folder-id', '.obsidian/plugins/plugin-a');
		stateManager.setFolderState('plugin-b-folder-id', '.obsidian/plugins/plugin-b');
		mockEventManager.getDirtyFiles.mockReturnValue([
			{ path: '.obsidian/plugins/plugin-a/main.js', type: LocalChangeType.DELETE },
			{ path: '.obsidian/plugins/plugin-b/main.js', type: LocalChangeType.DELETE },
		]);
		mockApp.vault.adapter.stat.mockResolvedValue(null);

		await createEngine().performSync();

		expect(mockFileOps.deleteFile.mock.calls.map((call) => call[0]).sort()).toEqual([
			'plugin-a-folder-id',
			'plugin-a-main-id',
			'plugin-b-folder-id',
			'plugin-b-main-id',
		]);
	});

	it('clears ghost tracked state before reconcile and drops entries not present in the cloud', async () => {
		const clearFileStatesSpy = vi.spyOn(stateManager, 'clearFileStates');
		stateManager.setFileState('ghost.md', {
			path: 'ghost.md',
			localMtime: 1,
			remoteHash: 'ghost-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'ghost-id',
		});
		const localFile = makeTFile('cloud.md', 10, Date.now());
		mockClient.listAllItems.mockResolvedValue([makeRemoteFile('cloud.md', { id: 'cloud-id', size: 10 })]);
		mockClient.getDelta.mockResolvedValue({ items: [], deltaLink: 'fresh-delta' });
		mockApp.vault.getFiles.mockReturnValue([localFile]);
		mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
			path === 'cloud.md' ? localFile : null
		);

		await createEngine().reconcileFromCloud();

		expect(clearFileStatesSpy).toHaveBeenCalledTimes(1);
		expect(stateManager.getFileState('ghost.md')).toBeUndefined();
		expect(stateManager.getFileState('cloud.md')).toMatchObject({
			path: 'cloud.md',
			oneDriveId: 'cloud-id',
		});
	});

	it('rebuilds tracked state from the cloud listing only during reconcile', async () => {
		stateManager.setFileState('stale.md', {
			path: 'stale.md',
			localMtime: 1,
			remoteHash: 'stale-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'stale-id',
		});
		const localKeep = makeTFile('keep.md', 10, Date.now());
		const localDelete = makeTFile('local-only.md', 5, Date.now());
		mockClient.listAllItems.mockResolvedValue([
			makeRemoteFile('keep.md', { id: 'keep-id', size: 10 }),
			makeRemoteFile('downloaded.md', { id: 'downloaded-id', size: 20 }),
		]);
		mockClient.getDelta.mockResolvedValue({ items: [], deltaLink: 'fresh-delta' });
		mockApp.vault.getFiles.mockReturnValue([localKeep, localDelete]);
		mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) => {
			if (path === 'keep.md') return localKeep;
			if (path === 'local-only.md') return localDelete;
			return null;
		});

		await createEngine().reconcileFromCloud();

		expect(stateManager.getFileState('keep.md')).toMatchObject({ oneDriveId: 'keep-id' });
		expect(stateManager.getFileState('downloaded.md')).toMatchObject({ oneDriveId: 'downloaded-id' });
		expect(stateManager.getFileState('local-only.md')).toBeUndefined();
		expect(stateManager.getFileState('stale.md')).toBeUndefined();
	});

	// Regression test for issue #163: reorganizing folders on one device
	// (e.g. desktop) left other devices (e.g. mobile) with a stale folder
	// structure, because non-deleted folder delta entries only updated
	// internal tracked state and never touched the local vault or the
	// tracked paths of files underneath the moved folder.
	it('moves the local folder and its tracked files when the remote reports a folder move', async () => {
		const tree = buildFolderTree(['notes/old-folder'], ['notes/old-folder/child.md']);
		const oldFolder = tree.getByPath('notes/old-folder') as TFolder;
		stateManager.setLastSyncTime(Date.now());
		stateManager.setDeltaLink('prev-delta');
		stateManager.setFolderState('folder-move-id', 'notes/old-folder');
		stateManager.setFileState('notes/old-folder/child.md', {
			path: 'notes/old-folder/child.md',
			localMtime: 1,
			remoteHash: 'child-hash',
			size: 10,
			remoteModifiedTime: 2,
			oneDriveId: 'child-file-id',
		});
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteFolder('notes/new-folder', { id: 'folder-move-id' })],
			deltaLink: 'delta-link-next',
		});
		mockApp.vault.getRoot.mockReturnValue(tree.root);
		mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) => tree.getByPath(path));

		await createEngine().performSync();

		expect(mockApp.vault.rename).toHaveBeenCalledWith(oldFolder, 'notes/new-folder');
		expect(mockEventManager.markOwnWrites).toHaveBeenCalledWith(
			expect.arrayContaining(['notes/new-folder', 'notes/old-folder/child.md', 'notes/new-folder/child.md'])
		);
		expect(stateManager.getFolderPathById('folder-move-id')).toBe('notes/new-folder');
		expect(stateManager.getFileState('notes/old-folder/child.md')).toBeUndefined();
		expect(stateManager.getFileState('notes/new-folder/child.md')).toMatchObject({
			oneDriveId: 'child-file-id',
		});
	});

	// Regression tests for issue #50: a file renamed on one device (atomic
	// PATCH move — the OneDrive id survives, so delta reports the item only
	// at its new path with no delete for the old one) left every other device
	// holding both the old and the new name.
	describe('remote file moves (issue #50)', () => {
		const trackFile = (path: string, id: string, hash: string) => {
			stateManager.setFileState(path, {
				path,
				localMtime: 1,
				remoteHash: hash,
				size: 100,
				remoteModifiedTime: 2,
				oneDriveId: id,
			});
		};

		it('renames the local file instead of leaving a duplicate behind', async () => {
			const localFile = makeTFile('Test Sync.md', 100, 1);
			stateManager.setLastSyncTime(Date.now());
			stateManager.setDeltaLink('prev-delta');
			trackFile('Test Sync.md', 'stable-id', 'Test Sync 111.md-hash');
			mockClient.getDelta.mockResolvedValue({
				items: [makeRemoteFile('Test Sync 111.md', { id: 'stable-id' })],
				deltaLink: 'delta-link-next',
			});
			mockApp.vault.adapter.exists.mockResolvedValue(false);
			mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
				path === 'Test Sync.md' ? localFile : null
			);

			await createEngine().performSync();

			expect(mockApp.vault.rename).toHaveBeenCalledWith(localFile, 'Test Sync 111.md');
			expect(mockEventManager.markOwnWrites).toHaveBeenCalledWith([
				'Test Sync.md',
				'Test Sync 111.md',
			]);
			expect(stateManager.getFileState('Test Sync.md')).toBeUndefined();
			expect(stateManager.getFileState('Test Sync 111.md')).toMatchObject({
				oneDriveId: 'stable-id',
			});
			// Pure rename — the tracked hash moved with the state, so there is
			// nothing left to download.
			expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
		});

		it('still downloads the new path when the remote move also changed content', async () => {
			const localFile = makeTFile('notes/a.md', 100, 1);
			stateManager.setLastSyncTime(Date.now());
			stateManager.setDeltaLink('prev-delta');
			trackFile('notes/a.md', 'stable-id', 'stale-hash');
			mockClient.getDelta.mockResolvedValue({
				items: [makeRemoteFile('notes/b.md', { id: 'stable-id' })],
				deltaLink: 'delta-link-next',
			});
			mockApp.vault.adapter.exists.mockResolvedValue(false);
			mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
				path === 'notes/a.md' ? localFile : null
			);

			await createEngine().performSync();

			expect(mockApp.vault.rename).toHaveBeenCalledWith(localFile, 'notes/b.md');
			expect(mockFileOps.downloadFile).toHaveBeenCalledWith('stable-id');
		});

		it('trashes the stale old copy when the new path already exists locally', async () => {
			const oldFile = makeTFile('notes/a.md', 100, 1);
			const newFile = makeTFile('notes/b.md', 100, 1);
			stateManager.setLastSyncTime(Date.now());
			stateManager.setDeltaLink('prev-delta');
			trackFile('notes/a.md', 'stable-id', 'notes/b.md-hash');
			mockClient.getDelta.mockResolvedValue({
				items: [makeRemoteFile('notes/b.md', { id: 'stable-id' })],
				deltaLink: 'delta-link-next',
			});
			mockApp.vault.adapter.exists.mockResolvedValue(false);
			mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) => {
				if (path === 'notes/a.md') return oldFile;
				if (path === 'notes/b.md') return newFile;
				return null;
			});

			await createEngine().performSync();

			expect(mockApp.vault.rename).not.toHaveBeenCalled();
			expect(mockApp.fileManager.trashFile).toHaveBeenCalledWith(oldFile);
			expect(stateManager.getFileState('notes/a.md')).toBeUndefined();
		});

		it('drops stale tracking and downloads when the old path was never present locally', async () => {
			stateManager.setLastSyncTime(Date.now());
			stateManager.setDeltaLink('prev-delta');
			trackFile('notes/a.md', 'stable-id', 'notes/b.md-hash');
			mockClient.getDelta.mockResolvedValue({
				items: [makeRemoteFile('notes/b.md', { id: 'stable-id' })],
				deltaLink: 'delta-link-next',
			});
			mockApp.vault.adapter.exists.mockResolvedValue(false);
			mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

			await createEngine().performSync();

			expect(mockApp.vault.rename).not.toHaveBeenCalled();
			expect(stateManager.getFileState('notes/a.md')).toBeUndefined();
			expect(mockFileOps.downloadFile).toHaveBeenCalledWith('stable-id');
			expect(stateManager.getFileState('notes/b.md')).toMatchObject({
				oneDriveId: 'stable-id',
			});
		});

		it('moves a config file via the adapter, since it is not in the vault index', async () => {
			stateManager.setLastSyncTime(Date.now());
			stateManager.setDeltaLink('prev-delta');
			trackFile('.obsidian/snippets/a.css', 'stable-id', '.obsidian/snippets/b.css-hash');
			mockClient.getDelta.mockResolvedValue({ items: [], deltaLink: 'delta-link-next' });
			mockClient.getDelta.mockResolvedValueOnce({ items: [], deltaLink: 'delta-link-next' });
			mockClient.getDelta.mockResolvedValueOnce({
				items: [makeRemoteFile('.obsidian/snippets/b.css', { id: 'stable-id' })],
				deltaLink: 'obsidian-delta-next',
			});
			mockApp.vault.adapter.exists.mockImplementation((path: string) =>
				Promise.resolve(path === '.obsidian/snippets/a.css')
			);
			mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

			await createEngine().performSync();

			expect(mockApp.vault.adapter.rename).toHaveBeenCalledWith(
				'.obsidian/snippets/a.css',
				'.obsidian/snippets/b.css'
			);
			expect(stateManager.getFileState('.obsidian/snippets/a.css')).toBeUndefined();
			expect(stateManager.getFileState('.obsidian/snippets/b.css')).toMatchObject({
				oneDriveId: 'stable-id',
			});
			expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
		});

		// A CREATE_DUPLICATE conflict copy is downloaded with the BASE file's
		// oneDriveId, so two tracked paths share one id. The move detector must
		// not read that alias as "the base file moved to the conflict copy".
		it('does not trash a conflict copy that shares the base file oneDriveId', async () => {
			const base = makeTFile('n.md', 100, 1);
			const copy = makeTFile('n (conflict).md', 100, 1);
			stateManager.setLastSyncTime(Date.now());
			stateManager.setDeltaLink('prev-delta');
			trackFile('n.md', 'shared-id', 'n.md-hash');
			// Written second, so the reverse index resolves shared-id → copy
			trackFile('n (conflict).md', 'shared-id', 'n.md-hash');
			mockClient.getDelta.mockResolvedValue({
				items: [makeRemoteFile('n.md', { id: 'shared-id' })],
				deltaLink: 'delta-link-next',
			});
			mockApp.vault.adapter.exists.mockResolvedValue(false);
			mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) => {
				if (path === 'n.md') return base;
				if (path === 'n (conflict).md') return copy;
				return null;
			});

			await createEngine().performSync();

			expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
			expect(mockApp.vault.rename).not.toHaveBeenCalled();
		});

		// adapter.exists is case-insensitive unless asked otherwise, so a
		// case-only rename must not be mistaken for "destination occupied".
		it('renames in place for a case-only rename instead of trashing and re-downloading', async () => {
			const localFile = makeTFile('Test.md', 100, 1);
			stateManager.setLastSyncTime(Date.now());
			stateManager.setDeltaLink('prev-delta');
			trackFile('Test.md', 'stable-id', 'test.md-hash');
			mockClient.getDelta.mockResolvedValue({
				items: [makeRemoteFile('test.md', { id: 'stable-id' })],
				deltaLink: 'delta-link-next',
			});
			// Case-insensitive filesystem: 'test.md' reports as existing
			mockApp.vault.adapter.exists.mockImplementation((path: string, sensitive?: boolean) =>
				Promise.resolve(!sensitive && path.toLowerCase() === 'test.md')
			);
			mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
				path === 'Test.md' ? localFile : null
			);

			await createEngine().performSync();

			expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
			expect(mockApp.vault.rename).toHaveBeenCalledWith(localFile, 'test.md');
			expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
		});

		// Obsidian refuses to rename onto an existing name, so "delete B, then
		// rename A → B" is a common pattern. Both delta orderings must end with
		// B holding A's content — never with both files gone.
		for (const order of ['move-first', 'delete-first'] as const) {
			it(`keeps A's content at B for delete-then-rename in one batch (${order})`, async () => {
				const fileA = makeTFile('A.md', 100, 1);
				const fileB = makeTFile('B.md', 100, 1);
				stateManager.setLastSyncTime(Date.now());
				stateManager.setDeltaLink('prev-delta');
				trackFile('A.md', 'id-x', 'B.md-hash');
				trackFile('B.md', 'id-y', 'B-old-hash');
				const moved = makeRemoteFile('B.md', { id: 'id-x' });
				const removed = makeRemoteDelete('B.md', { id: 'id-y' });
				mockClient.getDelta.mockResolvedValue({
					items: order === 'move-first' ? [moved, removed] : [removed, moved],
					deltaLink: 'delta-link-next',
				});
				mockApp.vault.adapter.exists.mockResolvedValue(false);
				const present = new Map<string, TFile>([
					['A.md', fileA],
					['B.md', fileB],
				]);
				mockApp.fileManager.trashFile.mockImplementation(async (f: { path: string }) => {
					present.delete(f.path);
				});
				mockApp.vault.rename.mockImplementation(async (f: TFile, dest: string) => {
					present.delete(f.path);
					present.set(dest, f);
				});
				mockApp.vault.getAbstractFileByPath.mockImplementation(
					(path: string) => present.get(path) ?? null
				);

				await createEngine().performSync();

				// B.md must survive holding X's content (by rename or download),
				// A.md must be gone, and B.md must be tracked as X.
				expect(present.has('B.md')).toBe(true);
				expect(present.has('A.md')).toBe(false);
				expect(stateManager.getFileState('B.md')).toMatchObject({ oneDriveId: 'id-x' });
			});
		}

		// A delta batch captured before a move this device already applied
		// would otherwise rename the file backwards.
		it('ignores a delta item older than the tracked state', async () => {
			const localFile = makeTFile('notes/b.md', 100, 1);
			stateManager.setLastSyncTime(Date.now());
			stateManager.setDeltaLink('prev-delta');
			stateManager.setFileState('notes/b.md', {
				path: 'notes/b.md',
				localMtime: 1,
				remoteHash: 'notes/a.md-hash',
				size: 100,
				remoteModifiedTime: 5000,
				oneDriveId: 'stable-id',
			});
			mockClient.getDelta.mockResolvedValue({
				items: [
					makeRemoteFile('notes/a.md', {
						id: 'stable-id',
						lastModifiedDateTime: new Date(1000).toISOString(),
					}),
				],
				deltaLink: 'delta-link-next',
			});
			mockApp.vault.adapter.exists.mockResolvedValue(false);
			mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
				path === 'notes/b.md' ? localFile : null
			);

			await createEngine().performSync();

			expect(mockApp.vault.rename).not.toHaveBeenCalled();
			expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
			expect(stateManager.getFileState('notes/b.md')).toMatchObject({ oneDriveId: 'stable-id' });
		});

		it('leaves the file alone when the same path has a pending local change', async () => {
			const localFile = makeTFile('notes/a.md', 100, 1);
			stateManager.setLastSyncTime(Date.now());
			stateManager.setDeltaLink('prev-delta');
			trackFile('notes/a.md', 'stable-id', 'old-hash');
			mockEventManager.getDirtyFiles.mockReturnValue([
				{ path: 'notes/a.md', type: LocalChangeType.MODIFY },
			]);
			mockClient.getDelta.mockResolvedValue({
				items: [makeRemoteFile('notes/b.md', { id: 'stable-id' })],
				deltaLink: 'delta-link-next',
			});
			mockApp.vault.adapter.exists.mockResolvedValue(false);
			mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
				path === 'notes/a.md' ? localFile : null
			);

			await createEngine().performSync();

			expect(mockApp.vault.rename).not.toHaveBeenCalled();
		});

		it('does not treat a locally-initiated atomic move as a remote move', async () => {
			const localFile = makeTFile('notes/b.md', 100, 1);
			stateManager.setLastSyncTime(Date.now());
			stateManager.setDeltaLink('prev-delta');
			trackFile('notes/a.md', 'stable-id', 'old-hash');
			mockEventManager.getDirtyFiles.mockReturnValue([
				{ path: 'notes/b.md', oldPath: 'notes/a.md', type: LocalChangeType.RENAME },
			]);
			// Delta still echoes the pre-move item at the OLD path with the same
			// id (issue #138) — this must not be read as a remote move.
			mockClient.getDelta.mockResolvedValue({
				items: [makeRemoteFile('notes/a.md', { id: 'stable-id' })],
				deltaLink: 'delta-link-next',
			});
			mockApp.vault.adapter.exists.mockResolvedValue(false);
			mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) =>
				path === 'notes/b.md' ? localFile : null
			);

			await createEngine().performSync();

			expect(mockApp.vault.rename).not.toHaveBeenCalled();
			expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
			expect(mockFileOps.moveFile).toHaveBeenCalledWith('stable-id', '/remote/root/notes/b.md');
		});
	});

	it('does not attempt a local folder move when the moved folder was never synced on this device', async () => {
		stateManager.setLastSyncTime(Date.now());
		stateManager.setDeltaLink('prev-delta');
		stateManager.setFolderState('folder-move-id', 'notes/old-folder');
		mockClient.getDelta.mockResolvedValue({
			items: [makeRemoteFolder('notes/new-folder', { id: 'folder-move-id' })],
			deltaLink: 'delta-link-next',
		});
		mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

		await createEngine().performSync();

		expect(mockApp.vault.rename).not.toHaveBeenCalled();
		expect(stateManager.getFolderPathById('folder-move-id')).toBe('notes/new-folder');
	});
});
