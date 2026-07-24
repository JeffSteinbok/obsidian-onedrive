/**
 * Chunked upload implementation for large files
 * Implementation pattern based on remotely-save and Home Assistant
 * https://github.com/remotely-save/remotely-save
 * Licensed under Apache 2.0
 */

import { requestUrl } from 'obsidian';
import { OneDriveUploadSession, OneDriveItem, OneDriveError, RateLimitError } from '../types';
import { SYNC_CONFIG, GRAPH_API_ENDPOINT } from '../constants';
import { logger } from '../utils/logger';
import { retryWithBackoff } from '../utils/retry';
import { parseRetryAfterHeader } from '../utils/errors';
import { OneDriveClient } from './oneDriveClient';

// How many times a large-file upload may consult the session's
// nextExpectedRanges to resume after a chunk fails its retries.
const MAX_SESSION_RESUMES = 3;

/**
 * Build the error for a failed upload HTTP response. 429s become
 * RateLimitError carrying the server's Retry-After hint (Graph sends it
 * in the header, not the body); everything else keeps its status code so
 * retryWithBackoff can classify it.
 */
function uploadHttpError(
	prefix: string,
	response: { status: number; headers: Record<string, string> }
): OneDriveError {
	if (response.status === 429) {
		return new RateLimitError(`${prefix}: HTTP 429`, parseRetryAfterHeader(response.headers));
	}
	return new OneDriveError(`${prefix}: HTTP ${response.status}`, undefined, response.status);
}

/**
 * Calculate optimal chunk size based on file size
 * Pattern from Home Assistant: target 20 chunks, min 320KB, max 60MB
 */
export function calculateChunkSize(fileSize: number): number {
	const targetSize = Math.floor(fileSize / SYNC_CONFIG.TARGET_CHUNKS_PER_FILE);
	// Microsoft Graph requires non-final chunks to be multiples of 320 KiB
	const aligned =
		Math.ceil(Math.max(targetSize, SYNC_CONFIG.MIN_CHUNK_SIZE) / SYNC_CONFIG.MIN_CHUNK_SIZE) *
		SYNC_CONFIG.MIN_CHUNK_SIZE;
	return Math.min(aligned, SYNC_CONFIG.MAX_CHUNK_SIZE);
}

/**
 * Chunked file uploader
 */
export class ChunkUploader {
	constructor(private client: OneDriveClient) {}

	/**
	 * Upload file with chunking for large files
	 * Uses small file upload for files < 4MB, chunked upload for larger files
	 */
	async uploadFile(
		filePath: string,
		content: ArrayBuffer,
		onProgress?: (uploaded: number, total: number) => void
	): Promise<OneDriveItem> {
		const fileSize = content.byteLength;

		logger.debug(`Uploading file ${filePath} (${fileSize} bytes)`);

		// Use simple upload for small files
		if (fileSize < SYNC_CONFIG.SMALL_FILE_THRESHOLD) {
			return this.uploadSmallFile(filePath, content);
		}

		// Use chunked upload for large files
		return this.uploadLargeFile(filePath, content, onProgress);
	}

	/**
	 * Simple upload for files < 4MB
	 * Uses requestUrl (Obsidian's cross-platform fetch wrapper) instead of the
	 * Graph SDK's .put(), which internally calls Buffer.from() — a Node.js
	 * built-in that is not available on Android / iOS.
	 */
	private async uploadSmallFile(filePath: string, content: ArrayBuffer): Promise<OneDriveItem> {
		logger.debug('Using simple upload for small file');

		try {
			const apiPath = this.client.buildEndpoint(filePath, 'content');
			const url = `${GRAPH_API_ENDPOINT}${apiPath}`;

			return await retryWithBackoff<OneDriveItem>(async () => {
				// Fetch a fresh token on every attempt so a mid-retry token
				// refresh is handled transparently.
				const token = await this.client.getAccessToken();

				const response = await requestUrl({
					url,
					method: 'PUT',
					headers: {
						Authorization: 'Bearer ' + token,
						'Content-Type': 'application/octet-stream',
					},
					body: content,
					throw: false,
				});

				if (response.status < 200 || response.status >= 300) {
					throw uploadHttpError('Failed to upload file', response);
				}

				return response.json as OneDriveItem;
			});
		} catch (error) {
			logger.error('Failed to upload small file:', error);
			throw error instanceof OneDriveError ? error : new OneDriveError(
				`Failed to upload file: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * Chunked upload for files >= 4MB
	 */
	private async uploadLargeFile(
		filePath: string,
		content: ArrayBuffer,
		onProgress?: (uploaded: number, total: number) => void
	): Promise<OneDriveItem> {
		const fileSize = content.byteLength;
		const chunkSize = calculateChunkSize(fileSize);

		logger.debug('Using chunked upload', { fileSize, chunkSize });

		// Step 1: Create upload session
		const session = await this.createUploadSession(filePath);

		// Step 2: Upload chunks sequentially (Graph requires in-order ranges).
		// If a chunk fails after its retries, consult the session's
		// nextExpectedRanges to resume — already-accepted bytes are kept
		// server-side and don't need re-uploading.
		const totalChunks = Math.ceil(fileSize / chunkSize);
		let position = 0;
		let resumesLeft = MAX_SESSION_RESUMES;
		let finalItem: OneDriveItem | null = null;

		while (position < fileSize) {
			const end = Math.min(position + chunkSize, fileSize);
			const chunk = content.slice(position, end);

			let result: OneDriveItem | null;
			try {
				result = await this.uploadChunk(session.uploadUrl, chunk, position, end - 1, fileSize);
			} catch (error) {
				if (resumesLeft <= 0) {
					throw error;
				}
				resumesLeft--;
				const resumePosition = await this.getResumePosition(session.uploadUrl);
				if (resumePosition === undefined || resumePosition >= fileSize) {
					throw error;
				}
				logger.warn(
					`Chunk upload interrupted at byte ${position}; session resume from byte ${resumePosition}`
				);
				position = resumePosition;
				continue;
			}

			if (result) {
				finalItem = result;
			}

			position = end;
			if (onProgress) {
				onProgress(position, fileSize);
			}

			logger.debug(
				`Uploaded chunk ${Math.ceil(position / chunkSize)}/${totalChunks} (${position}/${fileSize} bytes)`
			);
		}

		// The last chunk (200/201) returns the completed item directly.
		// Fall back to a GET only if somehow it wasn't captured.
		if (!finalItem) {
			finalItem = await this.getFinalItem(session.uploadUrl);
		}
		logger.info(`File uploaded successfully: ${filePath}`);

		return finalItem;
	}

	/**
	 * Create an upload session
	 */
	private async createUploadSession(filePath: string): Promise<OneDriveUploadSession> {
		logger.debug('Creating upload session for:', filePath);

		try {
			const graphClient = this.client.getClient();
			const apiPath = this.client.buildEndpoint(filePath, 'createUploadSession');

			return await retryWithBackoff<OneDriveUploadSession>(() =>
				graphClient.api(apiPath).post({
					item: {
						'@microsoft.graph.conflictBehavior': 'replace',
					},
				}) as Promise<OneDriveUploadSession>
			);
		} catch (error) {
			logger.error('Failed to create upload session:', error);
			throw new OneDriveError(
				`Failed to create upload session: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * Upload a single chunk.
	 * Returns the completed OneDriveItem when the server responds with
	 * 200/201 (final chunk), or null for 202 (intermediate chunk accepted).
	 */
	private async uploadChunk(
		uploadUrl: string,
		chunk: ArrayBuffer,
		start: number,
		end: number,
		total: number
	): Promise<OneDriveItem | null> {
		try {
			return await retryWithBackoff(async () => {
				const response = await requestUrl({
					url: uploadUrl,
					method: 'PUT',
					headers: {
						'Content-Range': `bytes ${start}-${end}/${total}`,
					},
					body: chunk,
					throw: false,
				});

				// 202 = chunk accepted, 201/200 = upload complete
				if (![200, 201, 202].includes(response.status)) {
					throw uploadHttpError('Failed to upload chunk', response);
				}

				// Final chunk — server returns the completed item
				if (response.status === 200 || response.status === 201) {
					return response.json as OneDriveItem;
				}

				return null;
			});
		} catch (error) {
			logger.error(`Failed to upload chunk ${start}-${end}:`, error);
			throw new OneDriveError(
				`Failed to upload chunk: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * Query the upload session for the next byte offset the server expects.
	 * Used to resume a chunked upload after a failed chunk. Returns undefined
	 * when the session status can't be read (caller rethrows the chunk error).
	 */
	private async getResumePosition(uploadUrl: string): Promise<number | undefined> {
		try {
			const response = await requestUrl({
				url: uploadUrl,
				method: 'GET',
				throw: false,
			});
			if (response.status !== 200) {
				return undefined;
			}
			const ranges = (response.json as { nextExpectedRanges?: string[] }).nextExpectedRanges;
			const firstRange = ranges?.[0];
			if (!firstRange) {
				return undefined;
			}
			const start = Number(firstRange.split('-')[0]);
			return Number.isFinite(start) ? start : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Get final item after upload completes
	 */
	private async getFinalItem(uploadUrl: string): Promise<OneDriveItem> {
		try {
			const response = await requestUrl({
				url: uploadUrl,
				method: 'GET',
				throw: false,
			});

			if (response.status !== 200) {
				throw new OneDriveError(`Failed to get final item: HTTP ${response.status}`);
			}

			return response.json as OneDriveItem;
		} catch (error) {
			logger.error('Failed to get final item:', error);
			throw new OneDriveError(
				`Failed to get final item: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}
}
