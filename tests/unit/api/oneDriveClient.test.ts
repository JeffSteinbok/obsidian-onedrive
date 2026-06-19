import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockRequestUrl } from '../../setup';

const { mockApiGet, mockApiPost, mockApiDelete, mockApiBuilder, mockClient } = vi.hoisted(() => {
	const mockApiGet = vi.fn();
	const mockApiPost = vi.fn();
	const mockApiDelete = vi.fn();
	const mockApiBuilder = {
		get: mockApiGet,
		post: mockApiPost,
		delete: mockApiDelete,
	};
	const mockClient = {
		api: vi.fn().mockReturnValue(mockApiBuilder),
	};

	return { mockApiGet, mockApiPost, mockApiDelete, mockApiBuilder, mockClient };
});

vi.mock('@microsoft/microsoft-graph-client', () => ({
	Client: {
		initWithMiddleware: vi.fn().mockReturnValue(mockClient),
	},
}));

vi.mock('../../../src/utils/retry', () => ({
	retryWithBackoff: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../../src/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { OneDriveAccessMode, OneDriveError } from '../../../src/types';
import { OneDriveClient } from '../../../src/api/oneDriveClient';
import { encodePathForGraph } from '../../../src/utils/pathUtils';

describe('OneDriveClient', () => {
	let client: OneDriveClient;
	const mockAuthProvider = { getAccessToken: vi.fn().mockResolvedValue('mock-token') };

	beforeEach(() => {
		vi.clearAllMocks();
		mockApiGet.mockReset();
		mockApiPost.mockReset();
		mockApiDelete.mockReset();
		mockRequestUrl.mockReset();
		mockClient.api.mockReturnValue(mockApiBuilder);
		client = new OneDriveClient(mockAuthProvider as any, OneDriveAccessMode.APP_FOLDER);
	});

	describe('buildEndpoint', () => {
		it('builds the app folder root endpoint without a suffix', () => {
			expect(client.buildEndpoint('')).toBe('/me/drive/special/approot');
		});

		it('builds the app folder root endpoint with a suffix', () => {
			expect(client.buildEndpoint('', 'children')).toBe('/me/drive/special/approot/children');
		});

		it('builds the app folder endpoint with a path', () => {
			const encoded = encodePathForGraph('folder name/file#.md');
			expect(client.buildEndpoint('folder name/file#.md')).toBe(`/me/drive/special/approot:/${encoded}`);
		});

		it('builds the app folder endpoint with a path and suffix', () => {
			const encoded = encodePathForGraph('folder name/file#.md');
			expect(client.buildEndpoint('folder name/file#.md', 'children')).toBe(`/me/drive/special/approot:/${encoded}:/children`);
		});

		it('builds the full access root endpoint', () => {
			const fullAccessClient = new OneDriveClient(mockAuthProvider as any, OneDriveAccessMode.FULL_ACCESS);
			expect(fullAccessClient.buildEndpoint('')).toBe('/me/drive/root');
		});

		it('builds the full access endpoint with a path', () => {
			const fullAccessClient = new OneDriveClient(mockAuthProvider as any, OneDriveAccessMode.FULL_ACCESS);
			const encoded = encodePathForGraph('folder name/file#.md');
			expect(fullAccessClient.buildEndpoint('folder name/file#.md')).toBe(`/me/drive/root:/${encoded}`);
		});

		it('builds the shared drive root endpoint without a suffix', () => {
			client.setRemoteDrive('drive-123', 'item-456', 'Shared');
			expect(client.buildEndpoint('')).toBe('/drives/drive-123/items/item-456');
		});

		it('builds the shared drive root endpoint with a suffix', () => {
			client.setRemoteDrive('drive-123', 'item-456', 'Shared');
			expect(client.buildEndpoint('', 'children')).toBe('/drives/drive-123/items/item-456/children');
		});

		it('builds the shared drive endpoint with a path', () => {
			client.setRemoteDrive('drive-123', 'item-456', 'Shared');
			const encoded = encodePathForGraph('folder name/file#.md');
			expect(client.buildEndpoint('folder name/file#.md')).toBe(`/drives/drive-123/items/item-456:/${encoded}`);
		});

		it('builds the shared drive endpoint with a path and suffix', () => {
			client.setRemoteDrive('drive-123', 'item-456', 'Shared');
			const encoded = encodePathForGraph('folder name/file#.md');
			expect(client.buildEndpoint('folder name/file#.md', 'content')).toBe(`/drives/drive-123/items/item-456:/${encoded}:/content`);
		});

		it('strips leading and trailing slashes from paths', () => {
			const encoded = encodePathForGraph('nested/path');
			expect(client.buildEndpoint('/nested/path/')).toBe(`/me/drive/special/approot:/${encoded}`);
		});

		// Shared drive with relative path (vault deeper in shared folder)
		it('prepends relativePathInShared for shared drive endpoints', () => {
			client.setRemoteDrive('drive-123', 'item-456', 'Shared', 'Vaults/MyVault');
			const encoded = encodePathForGraph('Vaults/MyVault/notes/test.md');
			expect(client.buildEndpoint('notes/test.md')).toBe(`/drives/drive-123/items/item-456:/${encoded}`);
		});

		it('prepends relativePathInShared for shared drive root with suffix', () => {
			client.setRemoteDrive('drive-123', 'item-456', 'Shared', 'Vaults/MyVault');
			const encoded = encodePathForGraph('Vaults/MyVault');
			expect(client.buildEndpoint('', 'children')).toBe(`/drives/drive-123/items/item-456:/${encoded}:/children`);
		});

		it('does not prepend relativePathInShared when it is empty', () => {
			client.setRemoteDrive('drive-123', 'item-456', 'Shared', '');
			expect(client.buildEndpoint('')).toBe('/drives/drive-123/items/item-456');
			const encoded = encodePathForGraph('notes/test.md');
			expect(client.buildEndpoint('notes/test.md')).toBe(`/drives/drive-123/items/item-456:/${encoded}`);
		});

		it('prepends relativePathInShared with suffix for nested path', () => {
			client.setRemoteDrive('drive-123', 'item-456', 'Shared', 'Vaults/MyVault');
			const encoded = encodePathForGraph('Vaults/MyVault/notes/test.md');
			expect(client.buildEndpoint('notes/test.md', 'content')).toBe(`/drives/drive-123/items/item-456:/${encoded}:/content`);
		});
	});

	describe('getItemEndpoint', () => {
		it('builds an item endpoint for the current users drive', () => {
			expect(client.getItemEndpoint('item-123')).toBe('/me/drive/items/item-123');
		});

		it('builds an item endpoint for a shared drive', () => {
			client.setRemoteDrive('drive-123', 'root-456', 'Shared');
			expect(client.getItemEndpoint('item-123')).toBe('/drives/drive-123/items/item-123');
		});
	});

	describe('shared drive state', () => {
		it('is not a shared drive by default', () => {
			expect(client.isSharedDrive()).toBe(false);
		});

		it('reports shared drive mode after configuring a remote drive', () => {
			client.setRemoteDrive('drive-123', 'item-456', 'Shared');
			expect(client.isSharedDrive()).toBe(true);
		});
	});

	describe('getUserInfo', () => {
		it('returns the mapped user info', async () => {
			mockApiGet.mockResolvedValue({
				id: 'user-1',
				displayName: 'Test User',
				mail: 'test@example.com',
				userPrincipalName: 'test@example.com',
			});

			await expect(client.getUserInfo()).resolves.toEqual({
				id: 'user-1',
				displayName: 'Test User',
				mail: 'test@example.com',
				userPrincipalName: 'test@example.com',
			});
			expect(mockClient.api).toHaveBeenCalledWith('/me');
		});

		it('throws OneDriveError when fetching the user fails', async () => {
			mockApiGet.mockRejectedValue(new Error('boom'));

			await expect(client.getUserInfo()).rejects.toBeInstanceOf(OneDriveError);
			await expect(client.getUserInfo()).rejects.toThrow('Failed to get user info: boom');
		});
	});

	describe('getItemByPath', () => {
		it('builds the endpoint and returns the item', async () => {
			const item = { id: 'item-1', name: 'file.md' };
			const buildEndpointSpy = vi.spyOn(client, 'buildEndpoint');
			mockApiGet.mockResolvedValue(item);

			await expect(client.getItemByPath('folder/file.md')).resolves.toBe(item as any);
			expect(buildEndpointSpy).toHaveBeenCalledWith('folder/file.md');
			expect(mockClient.api).toHaveBeenCalledWith(client.buildEndpoint('folder/file.md'));
		});

		it('throws OneDriveError when the item lookup fails', async () => {
			mockApiGet.mockRejectedValue(new Error('missing'));

			await expect(client.getItemByPath('folder/file.md')).rejects.toBeInstanceOf(OneDriveError);
			await expect(client.getItemByPath('folder/file.md')).rejects.toThrow('Failed to get item: missing');
		});
	});

	describe('listFolder', () => {
		it('lists folder children', async () => {
			const items = [{ id: 'item-1', name: 'note.md' }];
			const buildEndpointSpy = vi.spyOn(client, 'buildEndpoint');
			mockApiGet.mockResolvedValue({ value: items });

			await expect(client.listFolder('folder')).resolves.toEqual(items);
			expect(buildEndpointSpy).toHaveBeenCalledWith('folder', 'children');
			expect(mockClient.api).toHaveBeenCalledWith(client.buildEndpoint('folder', 'children'));
		});
	});

	describe('listFoldersForPicker', () => {
			const folderItem = { id: 'folder-1', name: 'Folder', folder: { childCount: 0 } };
			const sharedFolderItem = {
				id: 'folder-2',
				name: 'Shared Folder',
				remoteItem: {
					id: 'remote-1',
					name: 'Shared Folder',
					folder: { childCount: 1 },
					parentReference: { driveId: 'drive-123' },
				},
			};
			const fileItem = { id: 'file-1', name: 'note.md', file: { mimeType: 'text/markdown' } };

		it('uses the own-drive root endpoint at the root path', async () => {
			mockApiGet.mockResolvedValue({ value: [folderItem] });

			await expect(client.listFoldersForPicker()).resolves.toEqual([folderItem]);
			expect(mockClient.api).toHaveBeenCalledWith('/me/drive/root/children');
		});

		it('uses the own-drive endpoint for a nested path', async () => {
			const encoded = encodePathForGraph('Folder Name/Sub Folder');
			mockApiGet.mockResolvedValue({ value: [folderItem] });

			await expect(client.listFoldersForPicker('Folder Name/Sub Folder')).resolves.toEqual([folderItem]);
			expect(mockClient.api).toHaveBeenCalledWith(`/me/drive/root:/${encoded}:/children`);
		});

		it('uses the shared-drive root endpoint', async () => {
			mockApiGet.mockResolvedValue({ value: [folderItem] });

			await expect(client.listFoldersForPicker('', 'drive-123', 'item-456')).resolves.toEqual([folderItem]);
			expect(mockClient.api).toHaveBeenCalledWith('/drives/drive-123/items/item-456/children');
		});

		it('uses the shared-drive endpoint for a nested path', async () => {
			const encoded = encodePathForGraph('Folder Name/Sub Folder');
			mockApiGet.mockResolvedValue({ value: [folderItem] });

			await expect(client.listFoldersForPicker('', 'drive-123', 'item-456', 'Folder Name/Sub Folder')).resolves.toEqual([folderItem]);
			expect(mockClient.api).toHaveBeenCalledWith(`/drives/drive-123/items/item-456:/${encoded}:/children`);
		});

		it('filters results to folders and shared folder shortcuts', async () => {
			mockApiGet.mockResolvedValue({ value: [folderItem, sharedFolderItem, fileItem] });

			await expect(client.listFoldersForPicker()).resolves.toEqual([folderItem, sharedFolderItem]);
		});
	});

	describe('createFolder', () => {
		it('creates a folder with fail conflict behavior', async () => {
			const createdItem = { id: 'folder-1', name: 'New Folder' };
			mockApiPost.mockResolvedValue(createdItem);

			await expect(client.createFolder('parent', 'New Folder')).resolves.toBe(createdItem as any);
			expect(mockClient.api).toHaveBeenCalledWith(client.buildEndpoint('parent', 'children'));
			expect(mockApiPost).toHaveBeenCalledWith({
				name: 'New Folder',
				folder: {},
				'@microsoft.graph.conflictBehavior': 'fail',
			});
		});

		it('falls back to getItemByPath when the folder already exists', async () => {
			const existingItem = { id: 'folder-1', name: 'New Folder' };
			const getItemByPathSpy = vi.spyOn(client, 'getItemByPath').mockResolvedValue(existingItem as any);
			mockApiPost.mockRejectedValue(new Error('nameAlreadyExists'));

			await expect(client.createFolder('parent', 'New Folder')).resolves.toBe(existingItem as any);
			expect(getItemByPathSpy).toHaveBeenCalledWith('parent/New Folder');
		});
	});

	describe('deleteItem', () => {
		it('deletes an item via its item endpoint', async () => {
			mockApiDelete.mockResolvedValue(undefined);

			await expect(client.deleteItem('item-123')).resolves.toBeUndefined();
			expect(mockClient.api).toHaveBeenCalledWith('/me/drive/items/item-123');
			expect(mockApiDelete).toHaveBeenCalled();
		});

		it('throws OneDriveError when deletion fails', async () => {
			mockApiDelete.mockRejectedValue(new Error('forbidden'));

			await expect(client.deleteItem('item-123')).rejects.toBeInstanceOf(OneDriveError);
			await expect(client.deleteItem('item-123')).rejects.toThrow('Failed to delete item: forbidden');
		});
	});

	describe('downloadFile', () => {
		it('downloads a file using the graph download URL', async () => {
			const buffer = new ArrayBuffer(10);
			mockApiGet.mockResolvedValue({
				id: 'item-123',
				name: 'file.md',
				'@microsoft.graph.downloadUrl': 'https://download.example/file',
			});
			mockRequestUrl.mockResolvedValue({
				status: 200,
				text: '',
				arrayBuffer: buffer,
			});

			await expect(client.downloadFile('item-123')).resolves.toBe(buffer);
			expect(mockClient.api).toHaveBeenCalledWith('/me/drive/items/item-123');
			expect(mockRequestUrl).toHaveBeenCalledWith({
				url: 'https://download.example/file',
				method: 'GET',
				throw: false,
			});
		});

		it('throws when no download URL is available', async () => {
			mockApiGet.mockResolvedValue({ id: 'item-123', name: 'file.md' });

			await expect(client.downloadFile('item-123')).rejects.toBeInstanceOf(OneDriveError);
			await expect(client.downloadFile('item-123')).rejects.toThrow('Failed to download file: No download URL available');
		});

		it('throws OneDriveError when the binary fetch fails', async () => {
			mockApiGet.mockResolvedValue({
				id: 'item-123',
				name: 'file.md',
				'@microsoft.graph.downloadUrl': 'https://download.example/file',
			});
			mockRequestUrl.mockResolvedValue({ status: 500, text: 'Server Error' });

			await expect(client.downloadFile('item-123')).rejects.toBeInstanceOf(OneDriveError);
			await expect(client.downloadFile('item-123')).rejects.toThrow('Failed to download file: HTTP 500: Server Error');
		});
	});

	describe('itemExists', () => {
		it('returns true when the item exists', async () => {
			vi.spyOn(client, 'getItemByPath').mockResolvedValue({ id: 'item-1', name: 'file.md' } as any);

			await expect(client.itemExists('file.md')).resolves.toBe(true);
		});

		it('returns false when getItemByPath throws', async () => {
			vi.spyOn(client, 'getItemByPath').mockRejectedValue(new OneDriveError('missing'));

			await expect(client.itemExists('file.md')).resolves.toBe(false);
		});
	});

	describe('getDelta', () => {
		const item1 = { id: 'item-1', name: 'one.md' };
		const item2 = { id: 'item-2', name: 'two.md' };

		it('uses the app-folder delta endpoint on the first call', async () => {
			mockApiGet.mockResolvedValue({ value: [item1], '@odata.deltaLink': 'delta-1' });

			await expect(client.getDelta()).resolves.toEqual({ items: [item1], deltaLink: 'delta-1' });
			expect(mockClient.api).toHaveBeenCalledWith('/me/drive/special/approot/delta');
		});

		it('uses a full-access remote path delta endpoint on the first call', async () => {
			const fullAccessClient = new OneDriveClient(mockAuthProvider as any, OneDriveAccessMode.FULL_ACCESS);
			const encoded = encodePathForGraph('Folder Name/Sub Folder');
			mockApiGet.mockResolvedValue({ value: [item1], '@odata.deltaLink': 'delta-1' });

			await expect(fullAccessClient.getDelta(undefined, '/Folder Name/Sub Folder')).resolves.toEqual({ items: [item1], deltaLink: 'delta-1' });
			expect(mockClient.api).toHaveBeenCalledWith(`/me/drive/root:/${encoded}:/delta`);
		});

		it('uses the shared-drive delta endpoint on the first call', async () => {
			client.setRemoteDrive('drive-123', 'item-456', 'Shared');
			mockApiGet.mockResolvedValue({ value: [item1], '@odata.deltaLink': 'delta-1' });

			await expect(client.getDelta()).resolves.toEqual({ items: [item1], deltaLink: 'delta-1' });
			expect(mockClient.api).toHaveBeenCalledWith('/drives/drive-123/items/item-456/delta');
		});

		it('uses the provided delta link directly', async () => {
			mockApiGet.mockResolvedValue({ value: [item1], '@odata.deltaLink': 'delta-1' });

			await expect(client.getDelta('https://delta.example/token')).resolves.toEqual({ items: [item1], deltaLink: 'delta-1' });
			expect(mockClient.api).toHaveBeenCalledWith('https://delta.example/token');
		});

		it('follows pagination until it receives a delta link', async () => {
			mockApiGet
				.mockResolvedValueOnce({ value: [item1], '@odata.nextLink': 'next-url' })
				.mockResolvedValueOnce({ value: [item2], '@odata.deltaLink': 'new-delta' });

			await expect(client.getDelta()).resolves.toEqual({ items: [item1, item2], deltaLink: 'new-delta' });
			expect(mockClient.api).toHaveBeenNthCalledWith(1, '/me/drive/special/approot/delta');
			expect(mockClient.api).toHaveBeenNthCalledWith(2, 'next-url');
		});

		it('retries without the delta link when the token requires resync', async () => {
			mockApiGet
				.mockRejectedValueOnce(new Error('resyncRequired'))
				.mockResolvedValueOnce({ value: [item1], '@odata.deltaLink': 'fresh-delta' });

			await expect(client.getDelta('https://delta.example/token')).resolves.toEqual({ items: [item1], deltaLink: 'fresh-delta' });
			expect(mockClient.api).toHaveBeenNthCalledWith(1, 'https://delta.example/token');
			expect(mockClient.api).toHaveBeenNthCalledWith(2, '/me/drive/special/approot/delta');
		});

		it('throws OneDriveError for other delta errors', async () => {
			mockApiGet.mockRejectedValue(new Error('network down'));

			await expect(client.getDelta('https://delta.example/token')).rejects.toBeInstanceOf(OneDriveError);
			await expect(client.getDelta('https://delta.example/token')).rejects.toThrow('Failed to get delta: network down');
		});

		// Shared drive with vault nested inside the shared folder
		it('scopes shared-drive delta to vault subfolder when relativePathInShared is set', async () => {
			client.setRemoteDrive('drive-123', 'item-456', 'Shared', 'Vaults/MyVault');
			mockApiGet.mockResolvedValue({ value: [item1], '@odata.deltaLink': 'delta-1' });

			await client.getDelta();
			const encoded = encodePathForGraph('Vaults/MyVault');
			expect(mockClient.api).toHaveBeenCalledWith(`/drives/drive-123/items/item-456:/${encoded}:/delta`);
		});

		it('prepends relativePathInShared to subPath for shared-drive delta', async () => {
			client.setRemoteDrive('drive-123', 'item-456', 'Shared', 'Vaults/MyVault');
			mockApiGet.mockResolvedValue({ value: [item1], '@odata.deltaLink': 'delta-1' });

			await client.getDelta(undefined, '', '.obsidian');
			const encoded = encodePathForGraph('Vaults/MyVault/.obsidian');
			expect(mockClient.api).toHaveBeenCalledWith(`/drives/drive-123/items/item-456:/${encoded}:/delta`);
		});

		it('uses subPath alone for shared-drive delta when relativePathInShared is empty', async () => {
			client.setRemoteDrive('drive-123', 'item-456', 'Shared', '');
			mockApiGet.mockResolvedValue({ value: [item1], '@odata.deltaLink': 'delta-1' });

			await client.getDelta(undefined, '', '.obsidian');
			const encoded = encodePathForGraph('.obsidian');
			expect(mockClient.api).toHaveBeenCalledWith(`/drives/drive-123/items/item-456:/${encoded}:/delta`);
		});

		it('treats GraphError 404 on subPath as empty when no deltaLink (first sync)', async () => {
			// Graph SDK throws GraphError with statusCode/code properties, not OneDriveError
			const graphError = new Error('The resource could not be found.') as unknown as Record<string, unknown>;
			graphError.statusCode = 404;
			graphError.code = 'itemNotFound';
			mockApiGet.mockRejectedValueOnce(graphError);

			const result = await client.getDelta(undefined, '', '.obsidian');
			expect(result).toEqual({ items: [], deltaLink: '' });
		});

		it('treats OneDriveError with statusCode 404 as empty on first sync', async () => {
			const error = new OneDriveError('Not found', undefined, 404);
			mockApiGet.mockRejectedValueOnce(error);

			const result = await client.getDelta(undefined, '', '.obsidian');
			expect(result).toEqual({ items: [], deltaLink: '' });
		});

		it('treats OneDriveError with code itemNotFound as empty on first sync', async () => {
			const error = new OneDriveError('Item not found');
			(error as Record<string, unknown>).code = 'itemNotFound';
			mockApiGet.mockRejectedValueOnce(error);

			const result = await client.getDelta(undefined, '', '.obsidian');
			expect(result).toEqual({ items: [], deltaLink: '' });
		});

		it('treats plain object with code itemNotFound as empty on first sync', async () => {
			const error = { code: 'itemNotFound', message: 'Not found' };
			mockApiGet.mockRejectedValueOnce(error);

			const result = await client.getDelta(undefined, '', '.obsidian');
			expect(result).toEqual({ items: [], deltaLink: '' });
		});

		it('treats Error with 404 in message as empty on first sync', async () => {
			const error = new Error('HTTP 404: resource could not be found');
			mockApiGet.mockRejectedValueOnce(error);

			const result = await client.getDelta(undefined, '', '.obsidian');
			expect(result).toEqual({ items: [], deltaLink: '' });
		});

		it('uses root delta for shared-drive when both relativePath and subPath are empty', async () => {
			client.setRemoteDrive('drive-123', 'item-456', 'Shared', '');
			mockApiGet.mockResolvedValue({ value: [item1], '@odata.deltaLink': 'delta-1' });

			await client.getDelta();
			expect(mockClient.api).toHaveBeenCalledWith('/drives/drive-123/items/item-456/delta');
		});
	});

	describe('resolveSharedFolderPath', () => {
		it('returns the cleaned shared folder path', async () => {
			mockApiGet.mockResolvedValue({
				id: 'item-456',
				name: 'Shared Folder',
				parentReference: {
					id: 'parent-1',
					path: '/drives/drive-123/root:/Documents/Projects',
				},
			});

			await expect(client.resolveSharedFolderPath('drive-123', 'item-456')).resolves.toBe('/Documents/Projects/Shared Folder');
			expect(mockClient.api).toHaveBeenCalledWith('/drives/drive-123/items/item-456');
		});

		it('throws OneDriveError when resolving the shared folder path fails', async () => {
			mockApiGet.mockRejectedValue(new Error('not found'));

			await expect(client.resolveSharedFolderPath('drive-123', 'item-456')).rejects.toBeInstanceOf(OneDriveError);
			await expect(client.resolveSharedFolderPath('drive-123', 'item-456')).rejects.toThrow('Failed to resolve shared folder: not found');
		});
	});

	describe('getClient', () => {
		it('should return the Graph client instance', () => {
			const graphClient = client.getClient();
			expect(graphClient).toBe(mockClient);
		});
	});

	describe('resolveAppFolderPath', () => {
		it('returns the resolved app folder path', async () => {
			mockApiGet.mockResolvedValue({
				id: 'approot-id',
				name: 'ObsidianOneDrive',
				parentReference: { path: '/drive/root:/Apps' },
			});

			const result = await client.resolveAppFolderPath();
			expect(result).toBe('/Apps/ObsidianOneDrive');
			expect(mockClient.api).toHaveBeenCalledWith('/me/drive/special/approot');
		});

		it('uses default parent path when parentReference.path is missing', async () => {
			mockApiGet.mockResolvedValue({
				id: 'approot-id',
				name: 'ObsidianOneDrive',
				parentReference: {},
			});

			const result = await client.resolveAppFolderPath();
			expect(result).toBe('/Apps/ObsidianOneDrive');
		});

		it('returns default path when the API call fails', async () => {
			mockApiGet.mockRejectedValue(new Error('not found'));

			const result = await client.resolveAppFolderPath();
			expect(result).toBe('/Apps/ObsidianOneDrive');
		});
	});

	describe('listAppFoldersForPicker', () => {
		it('lists folders at the app folder root', async () => {
			const folder = { id: 'f1', name: 'Vault1', folder: {} };
			mockApiGet.mockResolvedValue({ value: [folder, { id: 'f2', name: 'file.md' }] });

			const result = await client.listAppFoldersForPicker();
			expect(result).toEqual([folder]);
			expect(mockClient.api).toHaveBeenCalledWith('/me/drive/special/approot/children');
		});

		it('lists folders at a nested path', async () => {
			const folder = { id: 'f1', name: 'SubFolder', folder: {} };
			mockApiGet.mockResolvedValue({ value: [folder] });

			const result = await client.listAppFoldersForPicker('Vault1');
			expect(result).toEqual([folder]);
			expect(mockClient.api).toHaveBeenCalledWith(`/me/drive/special/approot:/${encodePathForGraph('Vault1')}:/children`);
		});

		it('throws OneDriveError when the API call fails', async () => {
			mockApiGet.mockRejectedValue(new Error('forbidden'));

			await expect(client.listAppFoldersForPicker()).rejects.toBeInstanceOf(OneDriveError);
			await expect(client.listAppFoldersForPicker()).rejects.toThrow('Failed to list folders: forbidden');
		});
	});

	describe('listAllItems', () => {
		it('lists all items recursively', async () => {
			const file = { id: 'f1', name: 'doc.md' };
			const subfolder = { id: 's1', name: 'subfolder', folder: {} };
			const subfile = { id: 'sf1', name: 'nested.md' };

			// First call returns file + subfolder, second call returns subfile
			mockApiGet
				.mockResolvedValueOnce({ value: [file, subfolder] })
				.mockResolvedValueOnce({ value: [subfile] });

			const result = await client.listAllItems();
			expect(result).toEqual([file, subfolder, subfile]);
		});

		it('handles empty folders', async () => {
			mockApiGet.mockResolvedValue({ value: [] });

			const result = await client.listAllItems('empty');
			expect(result).toEqual([]);
		});
	});

	describe('moveItem', () => {
		const mockApiPatch = vi.fn();

		beforeEach(() => {
			mockApiBuilder.patch = mockApiPatch;
			mockApiPatch.mockReset();
		});

		it('moves an item to a new location', async () => {
			// Mock getItemByPath for parent folder lookup
			mockApiGet.mockResolvedValue({ id: 'parent-id', name: 'Documents' });
			mockApiPatch.mockResolvedValue({ id: 'item-1', name: 'renamed.md' });

			const result = await client.moveItem('item-1', 'Documents/renamed.md');

			expect(result).toEqual({ id: 'item-1', name: 'renamed.md' });
			expect(mockApiPatch).toHaveBeenCalledWith({
				name: 'renamed.md',
				parentReference: { id: 'parent-id' },
			});
		});

		it('moves an item to root', async () => {
			// Mock root folder lookup
			mockApiGet.mockResolvedValue({ id: 'root-id', name: 'root' });
			mockApiPatch.mockResolvedValue({ id: 'item-1', name: 'moved.md' });

			const result = await client.moveItem('item-1', 'moved.md');

			expect(result).toEqual({ id: 'item-1', name: 'moved.md' });
			expect(mockApiPatch).toHaveBeenCalledWith({
				name: 'moved.md',
				parentReference: { id: 'root-id' },
			});
		});

		it('throws OneDriveError for empty path', async () => {
			await expect(client.moveItem('item-1', '')).rejects.toBeInstanceOf(OneDriveError);
			await expect(client.moveItem('item-1', '')).rejects.toThrow('Invalid move destination: empty path');
		});

		it('throws OneDriveError when the move fails', async () => {
			mockApiGet.mockResolvedValue({ id: 'parent-id' });
			mockApiPatch.mockRejectedValue(new Error('conflict'));

			await expect(client.moveItem('item-1', 'dest/file.md')).rejects.toBeInstanceOf(OneDriveError);
			await expect(client.moveItem('item-1', 'other/file.md')).rejects.toThrow('Failed to move item: conflict');
		});
	});

	describe('deleteItem', () => {
		it('treats 404 as success (item already deleted)', async () => {
			mockApiDelete.mockRejectedValue({ statusCode: 404 });

			// Should not throw
			await expect(client.deleteItem('item-1')).resolves.toBeUndefined();
		});
	});
});
