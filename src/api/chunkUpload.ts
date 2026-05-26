/**
 * Chunked upload implementation for large files
 * Implementation pattern based on remotely-save and Home Assistant
 * https://github.com/remotely-save/remotely-save
 * Licensed under Apache 2.0
 */

import { requestUrl } from 'obsidian';
import { OneDriveUploadSession, OneDriveItem, OneDriveError } from '../types';
import { SYNC_CONFIG } from '../constants';
import { logger } from '../utils/logger';
import { retryWithBackoff } from '../utils/retry';
import { OneDriveClient } from './oneDriveClient';

/**
 * Calculate optimal chunk size based on file size
 * Pattern from Home Assistant: target 20 chunks, min 320KB, max 60MB
 */
function calculateChunkSize(fileSize: number): number {
	const targetSize = Math.floor(fileSize / SYNC_CONFIG.TARGET_CHUNKS_PER_FILE);
	return Math.min(Math.max(targetSize, SYNC_CONFIG.MIN_CHUNK_SIZE), SYNC_CONFIG.MAX_CHUNK_SIZE);
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
	 */
	private async uploadSmallFile(filePath: string, content: ArrayBuffer): Promise<OneDriveItem> {
		logger.debug('Using simple upload for small file');

		try {
			const graphClient = this.client.getClient();
			const apiPath = this.client.buildEndpoint(filePath, 'content');

			const response = await retryWithBackoff(() =>
				graphClient.api(apiPath).putStream(content)
			);

			return response as OneDriveItem;
		} catch (error) {
			logger.error('Failed to upload small file:', error);
			throw new OneDriveError(
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

		// Step 2: Upload chunks
		let uploadedBytes = 0;
		const chunks = Math.ceil(fileSize / chunkSize);

		for (let i = 0; i < chunks; i++) {
			const start = i * chunkSize;
			const end = Math.min(start + chunkSize, fileSize);
			const chunk = content.slice(start, end);

			await this.uploadChunk(session.uploadUrl, chunk, start, end - 1, fileSize);

			uploadedBytes = end;
			if (onProgress) {
				onProgress(uploadedBytes, fileSize);
			}

			logger.debug(`Uploaded chunk ${i + 1}/${chunks} (${uploadedBytes}/${fileSize} bytes)`);
		}

		// Step 3: Get final item (upload complete)
		// The last chunk upload returns the completed item
		const finalItem = await this.getFinalItem(session.uploadUrl);
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

			const response = await retryWithBackoff(() =>
				graphClient.api(apiPath).post({
					item: {
						'@microsoft.graph.conflictBehavior': 'replace',
					},
				})
			);

			return response as OneDriveUploadSession;
		} catch (error) {
			logger.error('Failed to create upload session:', error);
			throw new OneDriveError(
				`Failed to create upload session: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	}

	/**
	 * Upload a single chunk
	 */
	private async uploadChunk(
		uploadUrl: string,
		chunk: ArrayBuffer,
		start: number,
		end: number,
		total: number
	): Promise<void> {
		try {
			await retryWithBackoff(async () => {
				const response = await requestUrl({
					url: uploadUrl,
					method: 'PUT',
					headers: {
						'Content-Length': chunk.byteLength.toString(),
						'Content-Range': `bytes ${start}-${end}/${total}`,
					},
					body: chunk,
				});

				// 202 = chunk accepted, 201/200 = upload complete
				if (![200, 201, 202].includes(response.status)) {
					throw new OneDriveError(`Failed to upload chunk: HTTP ${response.status}`);
				}
			});
		} catch (error) {
			logger.error(`Failed to upload chunk ${start}-${end}:`, error);
			throw new OneDriveError(
				`Failed to upload chunk: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
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
