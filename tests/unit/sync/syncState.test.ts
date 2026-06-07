import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
	},
}));

import { SyncStateManager } from '../../../src/sync/syncState';
import type { FileState } from '../../../src/types';

function makeFileState(path: string): FileState {
	return {
		path,
		localMtime: Date.now(),
		remoteHash: `hash-${path}`,
		size: 100,
		remoteModifiedTime: Date.now(),
		oneDriveId: `${path}-id`,
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
});
