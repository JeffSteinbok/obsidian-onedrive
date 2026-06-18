/**
 * Unit tests for chunk upload
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateChunkSize, ChunkUploader } from '../../../src/api/chunkUpload';
import { SYNC_CONFIG } from '../../../src/constants';
import { OneDriveError } from '../../../src/types';

// Mock dependencies
vi.mock('obsidian', () => ({
	requestUrl: vi.fn(),
}));

vi.mock('../../../src/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../src/utils/retry', () => ({
	retryWithBackoff: vi.fn((fn) => fn()),
}));

import { requestUrl } from 'obsidian';

describe('Chunk Upload', () => {
	describe('calculateChunkSize', () => {
		const calculateExpectedChunkSize = (fileSize: number): number => {
			const targetSize = Math.floor(fileSize / SYNC_CONFIG.TARGET_CHUNKS_PER_FILE);
			const aligned =
				Math.ceil(targetSize / SYNC_CONFIG.MIN_CHUNK_SIZE) * SYNC_CONFIG.MIN_CHUNK_SIZE;
			return Math.min(
				Math.max(aligned, SYNC_CONFIG.MIN_CHUNK_SIZE),
				SYNC_CONFIG.MAX_CHUNK_SIZE
			);
		};

		it('should use minimum chunk size for very small files', () => {
			const chunkSize = calculateChunkSize(1024 * 1024); // 1 MB
			expect(chunkSize).toBe(SYNC_CONFIG.MIN_CHUNK_SIZE); // 320 KB
		});

		it('should calculate an aligned chunk size for medium files', () => {
			const fileSize = 20 * 1024 * 1024; // 20 MB
			const chunkSize = calculateChunkSize(fileSize);

			expect(chunkSize).toBe(calculateExpectedChunkSize(fileSize));
		});

		it('should use maximum chunk size for very large files', () => {
			const fileSize = 2 * 1024 * 1024 * 1024; // 2 GB
			const chunkSize = calculateChunkSize(fileSize);
			expect(chunkSize).toBe(SYNC_CONFIG.MAX_CHUNK_SIZE); // 60 MB
		});

		it('should align chunk sizes to 320 KB boundaries for supported file sizes', () => {
			const fileSizes = [
				Math.floor(8.4 * 1024 * 1024),
				20 * 1024 * 1024,
				100 * 1024 * 1024,
				500 * 1024 * 1024,
			];

			for (const fileSize of fileSizes) {
				const chunkSize = calculateChunkSize(fileSize);
				expect(chunkSize).toBe(calculateExpectedChunkSize(fileSize));
				expect(chunkSize % SYNC_CONFIG.MIN_CHUNK_SIZE).toBe(0);
			}
		});

		it('should target approximately 20 chunks for typical files', () => {
			const fileSize = 100 * 1024 * 1024; // 100 MB
			const chunkSize = calculateChunkSize(fileSize);

			const chunks = Math.ceil(fileSize / chunkSize);
			expect(chunks).toBeGreaterThanOrEqual(15);
			expect(chunks).toBeLessThanOrEqual(25);
		});
	});

	describe('chunk size constraints', () => {
		it('should have valid minimum chunk size', () => {
			expect(SYNC_CONFIG.MIN_CHUNK_SIZE).toBe(327680); // 320 KB
		});

		it('should have valid maximum chunk size', () => {
			expect(SYNC_CONFIG.MAX_CHUNK_SIZE).toBe(62914560); // 60 MB
		});

		it('should have valid target chunks per file', () => {
			expect(SYNC_CONFIG.TARGET_CHUNKS_PER_FILE).toBe(20);
		});

		it('should have valid small file threshold', () => {
			expect(SYNC_CONFIG.SMALL_FILE_THRESHOLD).toBe(4194304); // 4 MB
		});
	});

	describe('ChunkUploader', () => {
		let mockClient: {
			buildEndpoint: ReturnType<typeof vi.fn>;
			getAccessToken: ReturnType<typeof vi.fn>;
			getClient: ReturnType<typeof vi.fn>;
		};
		let uploader: ChunkUploader;

		beforeEach(() => {
			vi.clearAllMocks();
			mockClient = {
				buildEndpoint: vi.fn().mockReturnValue('/me/drive/root:/test.txt:/content'),
				getAccessToken: vi.fn().mockResolvedValue('mock-token'),
				getClient: vi.fn().mockReturnValue({
					api: vi.fn().mockReturnValue({
						post: vi.fn().mockResolvedValue({ uploadUrl: 'https://upload.example.com' }),
					}),
				}),
			};
			uploader = new ChunkUploader(mockClient as never);
		});

		describe('uploadFile', () => {
			it('should use simple upload for small files', async () => {
				const smallContent = new ArrayBuffer(1024); // 1 KB
				const mockResponse = {
					status: 200,
					json: { id: 'file-123', name: 'test.txt' },
				};
				vi.mocked(requestUrl).mockResolvedValue(mockResponse as never);

				const result = await uploader.uploadFile('test.txt', smallContent);

				expect(result).toEqual({ id: 'file-123', name: 'test.txt' });
				expect(mockClient.buildEndpoint).toHaveBeenCalledWith('test.txt', 'content');
			});

			it('should throw OneDriveError on upload failure', async () => {
				const smallContent = new ArrayBuffer(1024);
				vi.mocked(requestUrl).mockResolvedValue({
					status: 500,
					json: { error: 'Server error' },
				} as never);

				await expect(uploader.uploadFile('test.txt', smallContent)).rejects.toThrow(
					OneDriveError
				);
			});

			it('should call progress callback for large files', async () => {
				// Create content larger than SMALL_FILE_THRESHOLD (4MB)
				const largeContent = new ArrayBuffer(5 * 1024 * 1024); // 5 MB
				const onProgress = vi.fn();

				// Mock the upload session creation
				mockClient.getClient.mockReturnValue({
					api: vi.fn().mockReturnValue({
						post: vi.fn().mockResolvedValue({
							uploadUrl: 'https://upload.example.com/session',
						}),
					}),
				});

				// Mock chunk uploads - return null for intermediate, item for final
				vi.mocked(requestUrl).mockImplementation(async (options) => {
					if (options.method === 'PUT') {
						const contentRange = options.headers?.['Content-Range'] as string;
						const total = parseInt(contentRange?.split('/')[1] || '0');
						const end = parseInt(contentRange?.split('-')[1]?.split('/')[0] || '0');

						// Final chunk returns the item
						if (end + 1 >= total) {
							return { status: 200, json: { id: 'file-123', name: 'large.bin' } } as never;
						}
						return { status: 202, json: {} } as never;
					}
					return { status: 200, json: {} } as never;
				});

				const result = await uploader.uploadFile('large.bin', largeContent, onProgress);

				expect(result).toEqual({ id: 'file-123', name: 'large.bin' });
				expect(onProgress).toHaveBeenCalled();
			});
		});
	});
});
