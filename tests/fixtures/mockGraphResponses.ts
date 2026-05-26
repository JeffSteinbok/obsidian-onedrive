/**
 * Mock Microsoft Graph API responses for testing
 */

import { OneDriveItem, OneDriveUploadSession } from '../../src/types';

export const mockOneDriveFile: OneDriveItem = {
	id: 'file_12345',
	name: 'test.md',
	size: 1024,
	file: {
		mimeType: 'text/markdown',
		hashes: {
			quickXorHash: 'mock_hash_12345',
		},
	},
	lastModifiedDateTime: '2026-05-25T12:00:00Z',
	createdDateTime: '2026-05-20T10:00:00Z',
	'@microsoft.graph.downloadUrl': 'https://download.url/test.md',
	parentReference: {
		id: 'parent_12345',
		path: '/drive/root:/Apps/ObsidianOneDrive',
	},
};

export const mockOneDriveFolder: OneDriveItem = {
	id: 'folder_12345',
	name: 'notes',
	folder: {
		childCount: 5,
	},
	lastModifiedDateTime: '2026-05-25T12:00:00Z',
	createdDateTime: '2026-05-20T10:00:00Z',
	parentReference: {
		id: 'parent_12345',
		path: '/drive/root:/Apps/ObsidianOneDrive',
	},
};

export const mockUploadSession: OneDriveUploadSession = {
	uploadUrl: 'https://upload.url/session',
	expirationDateTime: '2026-05-25T13:00:00Z',
	nextExpectedRanges: ['0-'],
};

export const mockListFolderResponse = {
	value: [mockOneDriveFile, mockOneDriveFolder],
};
