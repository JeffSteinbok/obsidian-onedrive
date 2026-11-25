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

import { TFolder } from 'obsidian';
import '../../setup';
import { mockApp, makeTFile } from '../../setup';
import { SyncEngine } from '../../../src/sync/syncEngine';
import { SyncStateManager } from '../../../src/sync/syncState';
import { ConflictResolver } from '../../../src/sync/conflictResolver';
import {
	ConflictResolutionStrategy,
	LocalChangeType,
	OneDriveItem,
	type SyncEngineOptions,
} from '../../../src/types';
import { shouldSyncVaultPath, type DeviceSyncFilter } from '../../../src/utils/pathUtils';

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

/**
 * Engine-level behaviour of "Additional folders to sync" (#203) and the
 * per-device sync filter it shares with device-specific folders (#190).
 */
describe('SyncEngine additional (hidden) sync folders', () => {
	let stateManager: SyncStateManager;
	let conflictResolver: ConflictResolver;
	let mockFileOps: { uploadFile: Mock; downloadFile: Mock; deleteFile: Mock; moveFile: Mock };
	let mockClient: { getDelta: Mock; listAllItems: Mock; isSharedDrive: Mock };
	let mockEventManager: Record<string, Mock>;

	const createEngine = (options: Partial<SyncEngineOptions> = {}) =>
		new SyncEngine(
			mockApp as any,
			mockFileOps as any,
			mockClient as any,
			stateManager,
			conflictResolver,
			mockEventManager as any,
			'.obsidian',
			{ remoteRoot: '/remote/root', ...options }
		);

	const track = (path: string, extra: Record<string, unknown> = {}) =>
		stateManager.setFileState(path, {
			path,
			localMtime: 1,
			remoteHash: `${path}-old-hash`,
			size: 10,
			remoteModifiedTime: 1,
			oneDriveId: `${path}-id`,
			localContentHash: 'stale-local-hash',
			...extra,
		} as any);

	/** Files that exist on disk but that Obsidian does not index. */
	const setHiddenDisk = (files: Record<string, { mtime: number; size: number }>) => {
		mockApp.vault.adapter.list.mockImplementation(async (dir: string) => {
			const prefix = `${dir}/`;
			const inDir = Object.keys(files).filter((p) => p.startsWith(prefix));
			return {
				files: inDir.filter((p) => !p.slice(prefix.length).includes('/')),
				folders: [
					...new Set(
						inDir
							.filter((p) => p.slice(prefix.length).includes('/'))
							.map((p) => prefix + p.slice(prefix.length).split('/')[0])
					),
				],
			};
		});
		mockApp.vault.adapter.stat.mockImplementation(async (path: string) =>
			files[path] ? { type: 'file', ...files[path], ctime: 0 } : null
		);
		mockApp.vault.adapter.exists.mockImplementation(async (path: string) => !!files[path]);
	};

	beforeEach(() => {
		mockApp.vault.getAbstractFileByPath.mockReset().mockReturnValue(null);
		mockApp.vault.getFiles.mockReset().mockReturnValue([]);
		mockApp.vault.getRoot.mockReset().mockReturnValue(Object.assign(new TFolder(), { path: '', children: [] }));
		mockApp.vault.readBinary.mockReset().mockResolvedValue(new ArrayBuffer(10));
		mockApp.fileManager.trashFile.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.exists.mockReset().mockResolvedValue(true);
		mockApp.vault.adapter.read.mockReset().mockRejectedValue(new Error('missing .syncIgnore'));
		mockApp.vault.adapter.mkdir.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.writeBinary.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.readBinary.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
		mockApp.vault.adapter.remove.mockReset().mockResolvedValue(undefined);
		mockApp.vault.adapter.stat.mockReset().mockResolvedValue(null);
		mockApp.vault.adapter.list.mockReset().mockResolvedValue({ files: [], folders: [] });

		stateManager = new SyncStateManager();
		stateManager.setLastSyncTime(Date.now());
		conflictResolver = new ConflictResolver(ConflictResolutionStrategy.CREATE_DUPLICATE);
		mockFileOps = {
			uploadFile: vi.fn().mockImplementation((path: string) =>
				Promise.resolve(makeRemoteFile(path, { id: `${path}-id` }))
			),
			downloadFile: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
			deleteFile: vi.fn().mockResolvedValue(undefined),
			moveFile: vi
				.fn()
				.mockImplementation((id: string) => Promise.resolve(makeRemoteFile('Attachments/b.png', { id }))),
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
			addDirtyFile: vi.fn(),
		};
	});

	// Note: createConflictFileName currently drops the parent folder for every
	// path (pre-existing), so the copy is matched by file name only.
	const writtenPaths = () => mockApp.vault.adapter.writeBinary.mock.calls.map((call) => call[0] as string);
	// uploadFile receives the remote path; map it back to the vault path.
	const uploadedPaths = () =>
		mockFileOps.uploadFile.mock.calls.map((call) => (call[0] as string).replace(/^\/remote\/root\//, ''));

	describe('conflicts in an additional folder (#1)', () => {
		it('runs the conflict resolver instead of overwriting the remote edit', async () => {
			track('.claude/CLAUDE.md');
			setHiddenDisk({ '.claude/CLAUDE.md': { mtime: 5_000, size: 3 } });
			mockClient.getDelta.mockResolvedValue({
				items: [
					makeRemoteFile('.claude/CLAUDE.md', {
						file: { mimeType: 'text/markdown', hashes: { quickXorHash: 'remote-new-hash' } },
					}),
				],
				deltaLink: 'next',
			});

			await createEngine({ getAdditionalSyncFolders: () => ['.claude'] }).performSync();

			// CREATE_DUPLICATE keeps the other device's edit as a conflict copy.
			const copy = writtenPaths().find((p) => /(^|\/)CLAUDE \(conflict .*\)\.md$/.test(p));
			expect(copy).toBeDefined();
			expect(mockFileOps.downloadFile).toHaveBeenCalledWith('.claude/CLAUDE.md-id');
		});

		it('queues a manual conflict when the strategy is manual', async () => {
			conflictResolver = new ConflictResolver(ConflictResolutionStrategy.MANUAL);
			const conflictQueue = { add: vi.fn().mockResolvedValue(undefined), hasConflict: vi.fn().mockReturnValue(false) };
			track('.claude/CLAUDE.md');
			setHiddenDisk({ '.claude/CLAUDE.md': { mtime: 5_000, size: 3 } });
			mockClient.getDelta.mockResolvedValue({
				items: [
					makeRemoteFile('.claude/CLAUDE.md', {
						file: { mimeType: 'text/markdown', hashes: { quickXorHash: 'remote-new-hash' } },
					}),
				],
				deltaLink: 'next',
			});

			await createEngine({
				getAdditionalSyncFolders: () => ['.claude'],
				conflictQueue: conflictQueue as any,
			}).performSync();

			expect(conflictQueue.add).toHaveBeenCalledWith(
				'.claude/CLAUDE.md',
				expect.anything(),
				expect.anything(),
				5_000,
				expect.any(Number),
				'.claude/CLAUDE.md-id',
				'remote-new-hash'
			);
			expect(uploadedPaths()).not.toContain('.claude/CLAUDE.md');
		});

		it('does not overwrite the remote when both devices already had the file before opting in', async () => {
			// No tracked state: this device just enabled the setting.
			setHiddenDisk({ '.claude/CLAUDE.md': { mtime: 5_000, size: 3 } });
			mockClient.getDelta.mockResolvedValue({
				items: [
					makeRemoteFile('.claude/CLAUDE.md', {
						file: { mimeType: 'text/markdown', hashes: { quickXorHash: 'other-device-hash' } },
					}),
				],
				deltaLink: 'next',
			});

			await createEngine({ getAdditionalSyncFolders: () => ['.claude'] }).performSync();

			const copy = writtenPaths().find((p) => /(^|\/)CLAUDE \(conflict .*\)\.md$/.test(p));
			expect(copy).toBeDefined();
		});

		it('just tracks the file when content already matches the remote', async () => {
			setHiddenDisk({ '.claude/CLAUDE.md': { mtime: 5_000, size: 3 } });
			mockClient.getDelta.mockResolvedValue({
				items: [
					makeRemoteFile('.claude/CLAUDE.md', {
						size: 3,
						file: {
							mimeType: 'text/markdown',
							// sha1 of the bytes [1, 2, 3] returned by adapter.readBinary
							hashes: { quickXorHash: 'same-hash', sha1Hash: '7037807198C22A7D2B0807371D763779A84FDFCF' },
						},
					}),
				],
				deltaLink: 'next',
			});

			await createEngine({ getAdditionalSyncFolders: () => ['.claude'] }).performSync();

			expect(writtenPaths()).toEqual([]);
			expect(uploadedPaths()).toEqual([]);
			expect(stateManager.getFileState('.claude/CLAUDE.md')?.remoteHash).toBe('same-hash');
		});
	});

	describe('device without the setting (#2)', () => {
		it('does not download hidden-folder files another device uploaded', async () => {
			// This device lists no additional folders and has its own .claude.
			setHiddenDisk({ '.claude/settings.json': { mtime: 5_000, size: 3 } });
			mockClient.getDelta.mockResolvedValue({
				items: [makeRemoteFile('.claude/settings.json'), makeRemoteFile('.claude/agents/a.md')],
				deltaLink: 'next',
			});

			// Default scope check: what a device without any per-device opt-in uses.
			await createEngine().performSync();

			expect(writtenPaths()).toEqual([]);
			expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
			expect(stateManager.getFileState('.claude/settings.json')).toBeUndefined();
		});

		it('does not delete remote files when a folder is un-listed on this device', async () => {
			track('.claude/CLAUDE.md');
			setHiddenDisk({});

			await createEngine().performSync();

			expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
		});
	});

	describe('delete detection in an additional folder', () => {
		it('deletes a tracked file remotely when it is gone locally', async () => {
			track('.claude/old.md');
			setHiddenDisk({});

			await createEngine({ getAdditionalSyncFolders: () => ['.claude'] }).performSync();

			expect(mockFileOps.deleteFile).toHaveBeenCalledWith('.claude/old.md-id');
		});

		it('does not treat a stat error as a delete', async () => {
			track('.claude/locked.md');
			setHiddenDisk({});
			mockApp.vault.adapter.stat.mockRejectedValue(new Error('EPERM'));

			await createEngine({ getAdditionalSyncFolders: () => ['.claude'] }).performSync();

			expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
		});
	});

	describe('rename inside a listed non-hidden folder (#3)', () => {
		it('moves the item and does not also delete it remotely', async () => {
			track('Attachments/a.png');
			const renamed = makeTFile('Attachments/b.png', 3, 5_000);
			mockApp.vault.getAbstractFileByPath.mockImplementation((p: string) =>
				p === 'Attachments/b.png' ? renamed : null
			);
			setHiddenDisk({ 'Attachments/b.png': { mtime: 5_000, size: 3 } });
			mockEventManager.getDirtyFiles.mockReturnValue([
				{ path: 'Attachments/b.png', type: LocalChangeType.RENAME, oldPath: 'Attachments/a.png' },
			]);

			// Engine-level guard: even if a non-hidden folder reaches the
			// engine (settings validation now rejects it), no delete is emitted.
			await createEngine({
				getAdditionalSyncFolders: () => ['Attachments'],
				shouldSyncPath: () => true,
			}).performSync();

			expect(mockFileOps.moveFile).toHaveBeenCalledTimes(1);
			expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
		});
	});
	describe('read errors on a listed file (R1)', () => {
		it('does not delete remotely when stat throws for a listed file', async () => {
			track('.claude/locked.md');
			setHiddenDisk({ '.claude/locked.md': { mtime: 5_000, size: 3 } });
			mockApp.vault.adapter.stat.mockRejectedValue(new Error('EPERM'));

			await createEngine({ getAdditionalSyncFolders: () => ['.claude'] }).performSync();

			expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
		});

		it('does not delete remotely when reading a changed file throws', async () => {
			track('.claude/busy.md');
			setHiddenDisk({ '.claude/busy.md': { mtime: 5_000, size: 3 } });
			mockApp.vault.adapter.readBinary.mockRejectedValue(new Error('EBUSY'));

			await createEngine({ getAdditionalSyncFolders: () => ['.claude'] }).performSync();

			expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
		});
	});

	it('does not delete a tracked plugin file remotely when its stat throws', async () => {
		track('.obsidian/plugins/foo/main.js');
		mockApp.vault.adapter.stat.mockRejectedValue(new Error('EPERM'));

		await createEngine({ shouldSyncPath: () => true }).performSync();

		expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
	});

	describe('scope transitions (R2, R3)', () => {
		/** Delta that only returns `fullListing` when enumerating from scratch. */
		const deltaWithFullListing = (fullListing: OneDriveItem[]) =>
			mockClient.getDelta.mockImplementation(async (deltaLink?: string) => ({
				items: deltaLink ? [] : fullListing,
				deltaLink: 'cursor-next',
			}));

		it('a staggered first opt-in does not blindly overwrite the other device\'s files', async () => {
			// Device A already uploaded .claude while this device was not
			// opted in; this device's cursor has moved past those uploads.
			stateManager.setDeltaLink('cursor-0');
			deltaWithFullListing([
				makeRemoteFile('.claude/CLAUDE.md', {
					file: { mimeType: 'text/markdown', hashes: { quickXorHash: 'device-a-hash' } },
				}),
				makeRemoteFile('.claude/agents/a.md'),
			]);
			setHiddenDisk({ '.claude/CLAUDE.md': { mtime: 5_000, size: 3 } });
			let folders: string[] = [];
			const engine = createEngine({ getAdditionalSyncFolders: () => folders });

			await engine.performSync(); // not opted in yet
			expect(writtenPaths()).toEqual([]);
			expect(uploadedPaths()).toEqual([]);

			folders = ['.claude'];
			await engine.performSync(); // opted in

			// Device A's version is kept (conflict copy), and the file that
			// only exists remotely arrives here.
			expect(writtenPaths().some((p) => /(^|\/)CLAUDE \(conflict .*\)\.md$/.test(p))).toBe(true);
			expect(writtenPaths()).toContain('.claude/agents/a.md');
		});

		it('a folder added during a running sync waits for the next sync (no blind upload)', async () => {
			stateManager.setDeltaLink('cursor-0');
			deltaWithFullListing([
				makeRemoteFile('.claude/CLAUDE.md', {
					file: { mimeType: 'text/markdown', hashes: { quickXorHash: 'device-a-hash' } },
				}),
			]);
			setHiddenDisk({ '.claude/CLAUDE.md': { mtime: 5_000, size: 3 } });
			// The first read (Phase 0) sees the old list; the user's change
			// lands while the sync is still running.
			let calls = 0;
			const engine = createEngine({
				getAdditionalSyncFolders: () => (calls++ === 0 ? [] : ['.claude']),
			});

			await engine.performSync();
			expect(uploadedPaths()).not.toContain('.claude/CLAUDE.md');
			expect(writtenPaths()).toEqual([]);

			await engine.performSync(); // the change is applied now
			expect(writtenPaths().some((p) => /(^|\/)CLAUDE \(conflict .*\)\.md$/.test(p))).toBe(true);
		});

		// Pins only the gatherLocalChanges snapshot filter: the event is for a
		// folder this device never listed, with no live scope check involved.
		// The mid-sync add/remove races are covered with a main.ts-like live
		// shouldSyncPath in the block below.
		it('ignores queued vault events for paths outside this sync\'s device scope', async () => {
			setHiddenDisk({ '.claude/CLAUDE.md': { mtime: 5_000, size: 3 } });
			mockEventManager.getDirtyFiles.mockReturnValue([
				{ path: '.claude/CLAUDE.md', type: LocalChangeType.CREATE },
			]);

			await createEngine().performSync();

			expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
		});

		it('un-list, delete locally, re-list does not delete the folder remotely', async () => {
			stateManager.setDeltaLink('cursor-0');
			track('.claude/CLAUDE.md', { localMtime: 5_000, size: 3 });
			const disk: Record<string, { mtime: number; size: number }> = {
				'.claude/CLAUDE.md': { mtime: 5_000, size: 3 },
			};
			setHiddenDisk(disk);
			deltaWithFullListing([
				makeRemoteFile('.claude/CLAUDE.md', {
					size: 3,
					file: { mimeType: 'text/markdown', hashes: { quickXorHash: '.claude/CLAUDE.md-old-hash' } },
				}),
			]);
			let folders = ['.claude'];
			const engine = createEngine({ getAdditionalSyncFolders: () => folders });

			await engine.performSync(); // listed, nothing changed
			folders = [];
			await engine.performSync(); // un-listed
			delete disk['.claude/CLAUDE.md']; // removed locally while un-listed
			folders = ['.claude'];
			await engine.performSync(); // re-listed

			expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
			// Re-listing is a fresh opt-in: the remote copy comes back.
			expect(writtenPaths()).toContain('.claude/CLAUDE.md');
		});

		it('un-listing stops tracking the folder without touching the remote', async () => {
			track('.claude/CLAUDE.md');
			stateManager.setFolderState('claude-folder-id', '.claude');
			setHiddenDisk({});

			await createEngine().performSync();

			expect(stateManager.getFileState('.claude/CLAUDE.md')).toBeUndefined();
			expect(stateManager.getFolderIdByPath('.claude')).toBeUndefined();
			expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
			expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
		});
	});

	describe('excluded folders', () => {
		const exclusionOptions = (device: { excluded: string[] }): Partial<SyncEngineOptions> => {
			const getDeviceSyncFilter = () => ({ excludeFolders: device.excluded });
			return {
				getDeviceSyncFilter,
				shouldSyncPath: (path, filter = getDeviceSyncFilter()) =>
					shouldSyncVaultPath(path, false, false, '.obsidian', false, false, false, filter),
			};
		};

		it.each(['performSync', 'reconcileFromCloud', 'reconcileToCloud'] as const)(
			'%s leaves excluded local and remote files alone',
			async (run) => {
				const local = makeTFile('Attachments/PDFs/local.pdf', 10, 5000);
				mockApp.vault.getFiles.mockReturnValue([local]);
				mockApp.vault.getAbstractFileByPath.mockImplementation((path) => path === local.path ? local : null);
				track(local.path);
				track('Attachments/PDFs/deleted-local.pdf');
				const remote = makeRemoteFile('Attachments/PDFs/remote.pdf');
				mockClient.listAllItems.mockResolvedValue([remote]);
				mockClient.getDelta.mockResolvedValue({
					items: [remote, makeRemoteDelete(local.path)],
					deltaLink: 'next',
				});
				mockEventManager.getDirtyFiles.mockReturnValue([
					{ path: local.path, type: LocalChangeType.MODIFY },
					{ path: 'Attachments/PDFs/deleted-local.pdf', type: LocalChangeType.DELETE },
				]);

				await createEngine(exclusionOptions({ excluded: ['Attachments/PDFs'] }))[run]();

				expect(stateManager.getFileState(local.path)).toBeUndefined();
				expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
				expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
				expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
				expect(mockApp.fileManager.trashFile).not.toHaveBeenCalled();
				expect(mockApp.vault.adapter.remove).not.toHaveBeenCalled();
			}
		);

		it('keeps excluded descendants when a parent folder is deleted locally', async () => {
			stateManager.setFolderState('attachments-id', 'Attachments');
			mockEventManager.getDirtyFiles.mockReturnValue([
				{ path: 'Attachments', type: LocalChangeType.FOLDER_DELETE },
			]);

			await createEngine(exclusionOptions({ excluded: ['Attachments/PDFs'] })).performSync();

			expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
		});

		it.each(['performSync', 'reconcileFromCloud', 'reconcileToCloud'] as const)(
			're-enumerates missing remote files and checks conflicts after un-excluding following %s',
			async (run) => {
				const local = makeTFile('PDFs/conflict.pdf', 3, 5000);
				mockApp.vault.getFiles.mockReturnValue([local]);
				mockApp.vault.getAbstractFileByPath.mockImplementation((path) => path === local.path ? local : null);
				mockApp.vault.readBinary.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
				track(local.path);
				stateManager.setDeltaLink('cursor-0');
				const device = { excluded: ['PDFs'] };
				mockClient.getDelta.mockImplementation(async (cursor?: string) => ({
					items: cursor ? [] : [makeRemoteFile(local.path), makeRemoteFile('PDFs/missing.pdf')],
					deltaLink: 'cursor-next',
				}));
				mockClient.listAllItems.mockResolvedValue([makeRemoteFile(local.path), makeRemoteFile('PDFs/missing.pdf')]);
				const engine = createEngine(exclusionOptions(device));

				await engine[run]();
				expect(stateManager.getFileState(local.path)).toBeUndefined();
				device.excluded = [];
				await engine.performSync();

				expect(writtenPaths()).toContain('PDFs/missing.pdf');
				expect(writtenPaths()).toEqual(expect.arrayContaining([expect.stringMatching(/conflict \(conflict .*\)\.pdf$/)]));
				expect(writtenPaths()).not.toContain(local.path);
				expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
				expect(uploadedPaths()).toContain(local.path);
			}
		);

		it('does not overwrite the remote file when its conflict copy fails', async () => {
			const local = makeTFile('PDFs/conflict.pdf', 3, 5000);
			mockApp.vault.getFiles.mockReturnValue([local]);
			mockApp.vault.getAbstractFileByPath.mockImplementation((path) => path === local.path ? local : null);
			mockClient.getDelta.mockImplementation(async (cursor?: string) => ({
				items: cursor ? [] : [makeRemoteFile(local.path)],
				deltaLink: 'next',
			}));
			stateManager.setDeviceSyncScope({ excludeFolders: ['PDFs'] });
			stateManager.setDeltaLink('old');
			const engine = createEngine(exclusionOptions({ excluded: [] }));
			mockFileOps.downloadFile.mockRejectedValueOnce(new Error('download failed'));

			await engine.performSync();
			expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
			expect(mockFileOps.deleteFile).not.toHaveBeenCalled();

			await engine.performSync();
			expect(writtenPaths()).toEqual([expect.stringMatching(/conflict \(conflict .*\)\.pdf$/)]);
			expect(uploadedPaths()).toContain(local.path);
		});

		it('applies an exclusion added mid-sync starting with the next run', async () => {
			const device = { excluded: [] as string[] };
			mockClient.getDelta.mockImplementationOnce(async () => {
				device.excluded = ['PDFs'];
				return { items: [makeRemoteFile('PDFs/first.pdf')], deltaLink: 'next' };
			});
			mockClient.getDelta.mockResolvedValue({
				items: [makeRemoteFile('PDFs/second.pdf')],
				deltaLink: 'last',
			});
			const engine = createEngine(exclusionOptions(device));

			await engine.performSync();
			expect(writtenPaths()).toContain('PDFs/first.pdf');
			expect(stateManager.getFileState('PDFs/first.pdf')).toBeDefined();
			await engine.performSync();

			expect(stateManager.getFileState('PDFs/first.pdf')).toBeUndefined();
			expect(writtenPaths()).not.toContain('PDFs/second.pdf');
			expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
		});
	});

	describe('settings changed during a running sync (production-like live shouldSyncPath)', () => {
		/**
		 * Mirrors main.ts: the engine's shouldSyncPath option and device
		 * filter both read the user's live list, so a change made while a
		 * sync runs is visible to every later call unless the engine pins
		 * the Phase 0 snapshot.
		 */
		const liveOptions = (live: { folders: string[] }): Partial<SyncEngineOptions> => ({
			getDeviceSyncFilter: () => ({ includeHiddenFolders: live.folders }),
			shouldSyncPath: (path: string, filter: DeviceSyncFilter = { includeHiddenFolders: live.folders }) =>
				shouldSyncVaultPath(path, false, false, '.obsidian', false, false, false, filter),
		});
		const deviceAEdit = () => ({
			items: [
				makeRemoteFile('.claude/CLAUDE.md', {
					file: { mimeType: 'text/markdown', hashes: { quickXorHash: 'device-a-new-hash' } },
				}),
			],
			deltaLink: 'next',
		});
		const hasConflictCopy = () => writtenPaths().some((p) => /(^|\/)CLAUDE \(conflict .*\)\.md$/.test(p));

		it('un-listing while local changes are gathered does not blind-PUT over the other device\'s edit', async () => {
			const live = { folders: ['.claude'] };
			track('.claude/CLAUDE.md');
			setHiddenDisk({ '.claude/CLAUDE.md': { mtime: 5_000, size: 3 } });
			mockEventManager.getDirtyFiles.mockImplementation(() => {
				live.folders = []; // the user un-lists .claude mid-sync
				return [{ path: '.claude/CLAUDE.md', type: LocalChangeType.MODIFY }];
			});
			mockClient.getDelta.mockResolvedValue(deviceAEdit());

			await createEngine(liveOptions(live)).performSync();

			// Device A's edit reaches the conflict resolver (CREATE_DUPLICATE
			// keeps it as a copy) instead of being dropped and overwritten.
			expect(mockFileOps.downloadFile).toHaveBeenCalledWith('.claude/CLAUDE.md-id');
			expect(hasConflictCopy()).toBe(true);
		});

		it('un-listing before the delta is filtered does not blind-PUT over the other device\'s edit', async () => {
			const live = { folders: ['.claude'] };
			track('.claude/CLAUDE.md');
			setHiddenDisk({ '.claude/CLAUDE.md': { mtime: 5_000, size: 3 } });
			mockClient.getDelta.mockImplementation(async () => {
				live.folders = []; // the user un-lists .claude mid-sync
				return deviceAEdit();
			});

			await createEngine(liveOptions(live)).performSync();

			// Device A's edit reaches the conflict resolver (CREATE_DUPLICATE
			// keeps it as a copy) instead of being dropped and overwritten.
			expect(mockFileOps.downloadFile).toHaveBeenCalledWith('.claude/CLAUDE.md-id');
			expect(hasConflictCopy()).toBe(true);
		});

		it('the un-listing takes effect at the next sync without touching the remote', async () => {
			const live = { folders: ['.claude'] };
			track('.claude/CLAUDE.md');
			setHiddenDisk({ '.claude/CLAUDE.md': { mtime: 5_000, size: 3 } });
			mockClient.getDelta.mockImplementationOnce(async () => {
				live.folders = [];
				return deviceAEdit();
			});
			const engine = createEngine(liveOptions(live));

			await engine.performSync();
			mockFileOps.uploadFile.mockClear();
			mockFileOps.deleteFile.mockClear();
			await engine.performSync();

			expect(stateManager.getFileState('.claude/CLAUDE.md')).toBeUndefined();
			expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
			expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
		});

		it('adding a folder mid-sync waits for the next sync (no blind upload)', async () => {
			const live = { folders: [] as string[] };
			stateManager.setDeltaLink('cursor-0');
			mockClient.getDelta.mockImplementation(async (deltaLink?: string) => ({
				items: deltaLink
					? []
					: [
							makeRemoteFile('.claude/CLAUDE.md', {
								file: { mimeType: 'text/markdown', hashes: { quickXorHash: 'device-a-hash' } },
							}),
						],
				deltaLink: 'cursor-next',
			}));
			setHiddenDisk({ '.claude/CLAUDE.md': { mtime: 5_000, size: 3 } });
			mockEventManager.getDirtyFiles.mockImplementation(() => {
				live.folders = ['.claude']; // the user lists .claude mid-sync
				return [{ path: '.claude/CLAUDE.md', type: LocalChangeType.CREATE }];
			});
			const engine = createEngine(liveOptions(live));

			await engine.performSync();
			expect(uploadedPaths()).not.toContain('.claude/CLAUDE.md');
			expect(writtenPaths()).toEqual([]);

			mockEventManager.getDirtyFiles.mockReturnValue([]);
			await engine.performSync();
			expect(uploadedPaths()).not.toContain('.claude/CLAUDE.md');
			expect(hasConflictCopy()).toBe(true);
		});

		describe('reconcile runs use one scope snapshot too', () => {
			/** Un-list `.claude` while the local hidden-folder scan is running. */
			const unlistDuringLocalScan = (live: { folders: string[] }) => {
				const list = mockApp.vault.adapter.list.getMockImplementation();
				mockApp.vault.adapter.list.mockImplementation(async (dir: string) => {
					live.folders = [];
					return list ? list(dir) : { files: [], folders: [] };
				});
			};

			it('reconcile to cloud: un-listing mid-run does not delete the folder from OneDrive', async () => {
				const live = { folders: ['.claude'] };
				track('.claude/CLAUDE.md');
				setHiddenDisk({ '.claude/CLAUDE.md': { mtime: 5_000, size: 100 } });
				mockClient.listAllItems.mockResolvedValue([makeRemoteFile('.claude/CLAUDE.md', { size: 50 })]);
				unlistDuringLocalScan(live);

				await createEngine(liveOptions(live)).reconcileToCloud();

				expect(mockFileOps.deleteFile).not.toHaveBeenCalled();
				// The run finishes with the scope it started with: local wins.
				expect(uploadedPaths()).toContain('.claude/CLAUDE.md');
			});

			it('reconcile from cloud: un-listing mid-run does not re-download a file that is already in sync', async () => {
				const live = { folders: ['.claude'] };
				setHiddenDisk({ '.claude/CLAUDE.md': { mtime: 5_000, size: 3 } });
				mockClient.listAllItems.mockResolvedValue([makeRemoteFile('.claude/CLAUDE.md', { size: 3 })]);
				unlistDuringLocalScan(live);

				await createEngine(liveOptions(live)).reconcileFromCloud();

				expect(mockFileOps.downloadFile).not.toHaveBeenCalled();
				expect(writtenPaths()).toEqual([]);
			});

			it('clears the reconcile snapshot so the next run sees the new list', async () => {
				const live = { folders: ['.claude'] };
				setHiddenDisk({ '.claude/CLAUDE.md': { mtime: 5_000, size: 3 } });
				mockClient.listAllItems.mockResolvedValue([]);
				const engine = createEngine(liveOptions(live));

				await engine.reconcileToCloud();
				expect(uploadedPaths()).toContain('.claude/CLAUDE.md');

				mockFileOps.uploadFile.mockClear();
				live.folders = [];
				await engine.reconcileToCloud();
				expect(mockFileOps.uploadFile).not.toHaveBeenCalled();
			});
		});
	});
});
