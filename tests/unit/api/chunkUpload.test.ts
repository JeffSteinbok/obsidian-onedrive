/**
 * Unit tests for chunk upload
 */

import { describe, it, expect } from 'vitest';
import { calculateChunkSize } from '../../../src/api/chunkUpload';
import { SYNC_CONFIG } from '../../../src/constants';

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
});
