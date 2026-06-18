import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
	},
}));

import { SyncStateManager } from '../../../src/sync/syncState';
import type { FileState

 } from '../../../src/types';

function makeFileState(path: string, overrides: Partial<FileState> = {}): FileState {
	return {
		path,
		localMtime: Date.now(),
		remoteHash: `hash-${path}`,
		size: 100,
		remoteModifiedTime: Date.now(),
		oneDriveId: `${path}-id`,
		...overrides,
	};
}

describe('SyncStateManager', () => {
	let stateManager: SyncStateManager;

	beforeEach(() => {
		stateManager = new SyncStateManager();
	});

	it('clearFileStates clears file states while preserving folder state and sync metadata', () => {
		stateManager.setLastSyncTime(123456);
		stateManager.setDeltaLink('main-delta');
		stateManager.setObsidianDeltaLink('obsidian-delta');
		stateManager.setFileState('notes/one.md', makeFileState('notes/one.md'));
		stateManager.setFileState('notes/two.md', makeFileState('notes/two.md'));
		stateManager.setFolderState('folder-1', 'notes');
		stateManager.setFolderState('folder-2', 'archive');

		stateManager.clearFileStates();

		expect(stateManager.getTrackedPaths()).toEqual([]);
		expect(stateManager.getFileState('notes/one.md')).toBeUndefined();
		expect(stateManager.getFileState('notes/two.md')).toBeUndefined();
		expect(stateManager.getFolderPathById('folder-1')).toBe('notes');
		expect(stateManager.getFolderPathById('folder-2')).toBe('archive');
		expect(stateManager.getLastSyncTime()).toBe(123456);
		expect(stateManager.getDeltaLink()).toBe('main-delta');
		expect(stateManager.getObsidianDeltaLink()).toBe('obsidian-delta');
	});

	it('getFolderIdByPath returns the tracked OneDrive id for a folder path', () => {
		stateManager.setFolderState('folder-1', 'notes');
		stateManager.setFolderState('folder-2', 'notes/subfolder');

		expect(stateManager.getFolderIdByPath('notes')).toBe('folder-1');
		expect(stateManager.getFolderIdByPath('notes/subfolder')).toBe('folder-2');
		expect(stateManager.getFolderIdByPath('missing')).toBeUndefined();
	});

	it('removeFolderStateByPath removes the matching folder mapping and preserves others', () => {
		stateManager.setFolderState('folder-1', 'notes');
		stateManager.setFolderState('folder-2', 'archive');

		stateManager.removeFolderStateByPath('notes');

		expect(stateManager.getFolderPathById('folder-1')).toBeUndefined();
		expect(stateManager.getFolderIdByPath('notes')).toBeUndefined();
		expect(stateManager.getFolderPathById('folder-2')).toBe('archive');
		expect(stateManager.getFolderIdByPath('archive')).toBe('folder-2');
	});

	describe('file state operations', () => {
		it('should set and get file state', () => {
			const state = makeFileState('test.md');
			stateManager.setFileState('test.md', state);

			expect(stateManager.getFileState('test.md')).toEqual(state);
		});

		it('should remove file state', () => {
			stateManager.setFileState('test.md', makeFileState('test.md'));
			stateManager.removeFileState('test.md');

			expect(stateManager.getFileState('test.md')).toBeUndefined();
		});

		it('should return all tracked paths', () => {
			stateManager.setFileState('a.md', makeFileState('a.md'));
			stateManager.setFileState('b.md', makeFileState('b.md'));
			stateManager.setFileState('c.md', makeFileState('c.md'));

			const paths = stateManager.getTrackedPaths();
			expect(paths).toHaveLength(3);
			expect(paths).toContain('a.md');
			expect(paths).toContain('b.md');
			expect(paths).toContain('c.md');
		});

		it('should check if file is tracked via getFileState', () => {
			stateManager.setFileState('tracked.md', makeFileState('tracked.md'));

			expect(stateManager.getFileState('tracked.md')).toBeDefined();
			expect(stateManager.getFileState('untracked.md')).toBeUndefined();
		});

		it('should get path by OneDrive ID', () => {
			stateManager.setFileState('test.md', makeFileState('test.md', { oneDriveId: 'drive-id-123' }));

			expect(stateManager.getPathByOneDriveId('drive-id-123')).toBe('test.md');
			expect(stateManager.getPathByOneDriveId('unknown-id')).toBeUndefined();
		});

		it('should get file states under folder', () => {
			stateManager.setFileState('notes/a.md', makeFileState('notes/a.md'));
			stateManager.setFileState('notes/b.md', makeFileState('notes/b.md'));
			stateManager.setFileState('other/c.md', makeFileState('other/c.md'));

			const notesFiles = stateManager.getFileStatesUnderFolder('notes');
			expect(notesFiles).toHaveLength(2);
			expect(notesFiles.map((f) => f.path)).toContain('notes/a.md');
			expect(notesFiles.map((f) => f.path)).toContain('notes/b.md');
		});
	});

	describe('sync metadata', () => {
		it('should set and get last sync time', () => {
			stateManager.setLastSyncTime(1234567890);
			expect(stateManager.getLastSyncTime()).toBe(1234567890);
		});

		it('should set and get delta links', () => {
			stateManager.setDeltaLink('delta-123');
			stateManager.setObsidianDeltaLink('obsidian-delta-456');

			expect(stateManager.getDeltaLink()).toBe('delta-123');
			expect(stateManager.getObsidianDeltaLink()).toBe('obsidian-delta-456');
		});

		it('should clear delta link', () => {
			stateManager.setDeltaLink('delta-123');
			stateManager.clearDeltaLink();

			expect(stateManager.getDeltaLink()).toBeUndefined();
		});

		it('should clear all state and reset to initial values', () => {
			stateManager.setLastSyncTime(123);
			stateManager.setDeltaLink('delta');
			stateManager.setObsidianDeltaLink('obs-delta');
			stateManager.setFileState('file.md', makeFileState('file.md'));
			stateManager.setFolderState('folder-1', 'notes');

			stateManager.clearState();

			expect(stateManager.getLastSyncTime()).toBe(0); // Reset to 0, not undefined
			expect(stateManager.getDeltaLink()).toBeUndefined();
			expect(stateManager.getObsidianDeltaLink()).toBeUndefined();
			expect(stateManager.getTrackedPaths()).toEqual([]);
			expect(stateManager.getFolderPathById('folder-1')).toBeUndefined();
		});

		it('should detect first sync correctly', () => {
			expect(stateManager.isFirstSync()).toBe(true);

			stateManager.setLastSyncTime(Date.now());
			expect(stateManager.isFirstSync()).toBe(false);
		});
	});

	describe('serialization', () => {
		it('should serialize state via prepareForSave', () => {
			stateManager.setLastSyncTime(123456);
			stateManager.setDeltaLink('delta-link');
			stateManager.setFileState('test.md', makeFileState('test.md', { size: 500 }));

			const serialized = stateManager.prepareForSave();

			expect(serialized.lastSyncTime).toBe(123456);
			expect(serialized.deltaLink).toBe('delta-link');
			expect(serialized.fileStates).toHaveLength(1);
			expect(serialized.fileStates[0][0]).toBe('test.md');
		});

		it('should load state from persisted format', () => {
			const persisted = {
				lastSyncTime: 999999,
				deltaLink: 'restored-delta',
				obsidianDeltaLink: 'restored-obs-delta',
				fileStates: [
					['restored.md', makeFileState('restored.md')] as [string, FileState],
				],
			};

			stateManager.loadState(persisted);

			expect(stateManager.getLastSyncTime()).toBe(999999);
			expect(stateManager.getDeltaLink()).toBe('restored-delta');
			expect(stateManager.getObsidianDeltaLink()).toBe('restored-obs-delta');
			expect(stateManager.getFileState('restored.md')).toBeDefined();
		});

		it('should handle undefined persisted state gracefully', () => {
			stateManager.loadState(undefined);

			expect(stateManager.getLastSyncTime()).toBe(0);
			expect(stateManager.getTrackedPaths()).toEqual([]);
		});
	});

	describe('folder state edge cases', () => {
		it('should handle removing non-existent folder', () => {
			// Should not throw
			stateManager.removeFolderStateByPath('non-existent');
			expect(stateManager.getFolderIdByPath('non-existent')).toBeUndefined();
		});

		it('should track multiple folders independently', () => {
			stateManager.setFolderState('id-1', 'notes');
			stateManager.setFolderState('id-2', 'archive');
			stateManager.setFolderState('id-3', 'notes/subfolder');

			expect(stateManager.getFolderIdByPath('notes')).toBe('id-1');
			expect(stateManager.getFolderIdByPath('archive')).toBe('id-2');
			expect(stateManager.getFolderIdByPath('notes/subfolder')).toBe('id-3');
		});

		it('should remove folder by ID', () => {
			stateManager.setFolderState('folder-id', 'notes');
			stateManager.removeFolderState('folder-id');

			expect(stateManager.getFolderPathById('folder-id')).toBeUndefined();
		});
	});
});
