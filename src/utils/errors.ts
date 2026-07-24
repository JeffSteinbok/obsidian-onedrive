/**
 * Error handling utilities and custom error classes
 * Implementation pattern inspired by Home Assistant's error decorator
 */

import { Notice } from 'obsidian';
import { AuthenticationError, RateLimitError, OneDriveError } from '../types';
import { logger } from './logger';

type DecoratedAsyncMethod = (this: object, ...args: unknown[]) => Promise<unknown>;

interface ParsedHttpErrorBody {
	error?: string;
	error_description?: string;
	message?: string;
	retry_after?: number;
}

function getDecoratedMethod(descriptor: PropertyDescriptor): DecoratedAsyncMethod {
	if (typeof descriptor.value !== 'function') {
		throw new Error('Decorator can only be applied to methods');
	}

	return descriptor.value as DecoratedAsyncMethod;
}

/**
 * Decorator to handle sync errors gracefully
 * Inspired by Home Assistant's @handle_backup_errors pattern
 */
export function handleSyncErrors(
	target: unknown,
	propertyKey: string,
	descriptor: PropertyDescriptor
) {
	const originalMethod = getDecoratedMethod(descriptor);

	descriptor.value = async function (this: object, ...args: unknown[]) {
		try {
			return await Reflect.apply(originalMethod, this, args);
		} catch (error) {
			if (error instanceof AuthenticationError) {
				logger.error('Authentication error during sync:', error);
				new Notice('OneDrive authentication failed. Please reconnect in settings.');
				throw error; // Re-throw to trigger re-auth flow
			} else if (error instanceof RateLimitError) {
				const retryAfter = error.retryAfter || 60;
				logger.warn(`Rate limit reached. Retry after ${retryAfter} seconds`);
				new Notice(`OneDrive rate limit reached. Will retry in ${retryAfter} seconds...`, 5000);
				throw error;
			} else if (error instanceof OneDriveError) {
				logger.error('OneDrive API error:', error);
				new Notice(`OneDrive error: ${error.message}`, 5000);
				throw error;
			} else {
				logger.error('Unexpected error during sync:', error);
				new Notice('An unexpected error occurred during sync. Check console for details.');
				throw error;
			}
		}
	};

	return descriptor;
}

/**
 * Decorator to handle authentication errors
 */
export function handleAuthErrors(
	target: unknown,
	propertyKey: string,
	descriptor: PropertyDescriptor
) {
	const originalMethod = getDecoratedMethod(descriptor);

	descriptor.value = async function (this: object, ...args: unknown[]) {
		try {
			return await Reflect.apply(originalMethod, this, args);
		} catch (error) {
			if (error instanceof Error) {
				logger.error(`Authentication error in ${propertyKey}:`, error);

				// Check for specific OAuth errors
				if (error.message.includes('access_denied')) {
					new Notice('Authentication was cancelled. Please try again.');
				} else if (error.message.includes('authorization_pending')) {
					// User hasn't completed auth yet, this is expected
					throw error;
				} else if (error.message.includes('expired_token')) {
					new Notice('Authentication code expired. Please try again.');
				} else {
					new Notice(`Authentication failed: ${error.message}`);
				}
			}
			throw error;
		}
	};

	return descriptor;
}

/**
 * Parse a Retry-After response header value into seconds.
 * Graph sends the throttling wait hint in this header, not the JSON body.
 */
export function parseRetryAfterHeader(
	headers: Record<string, string> | undefined
): number | undefined {
	if (!headers) return undefined;
	const raw = headers['retry-after'] ?? headers['Retry-After'];
	if (!raw) return undefined;
	const seconds = Number(raw);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * Parse error from HTTP response.
 * Pass the response headers when available so 429s pick up the server's
 * Retry-After hint instead of the fixed fallback.
 */
export function parseHttpError(
	status: number,
	body: string,
	headers?: Record<string, string>
): Error {
	const headerRetryAfter = parseRetryAfterHeader(headers);
	try {
		const json = JSON.parse(body) as ParsedHttpErrorBody;
		const errorCode = json.error || json.error_description || 'unknown_error';
		const errorMessage = json.error_description || json.message || 'Unknown error occurred';

		if (status === 401) {
			return new AuthenticationError(errorMessage, errorCode);
		} else if (status === 429) {
			const retryAfter = headerRetryAfter || json.retry_after || 60;
			return new RateLimitError(errorMessage, retryAfter);
		} else {
			return new OneDriveError(errorMessage, errorCode, status);
		}
	} catch {
		if (status === 429) {
			return new RateLimitError(`HTTP 429: ${body}`, headerRetryAfter || 60);
		}
		// Failed to parse JSON, return generic error
		return new OneDriveError(`HTTP ${status}: ${body}`, undefined, status);
	}
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: Error): boolean {
	if (error instanceof RateLimitError) {
		return true;
	}

	const retryableStatusCodes = [408, 423, 429, 500, 501, 502, 503, 504];

	if (error instanceof OneDriveError) {
		return error.statusCode ? retryableStatusCodes.includes(error.statusCode) : false;
	}

	// Graph SDK throws errors with statusCode property but not as OneDriveError instances
	if (error && typeof error === 'object' && 'statusCode' in error) {
		const statusCode = (error as unknown as { statusCode: number }).statusCode;
		if (typeof statusCode === 'number') {
			return retryableStatusCodes.includes(statusCode);
		}
	}

	// Network errors are retryable
	if (error.message.includes('network') || error.message.includes('timeout')) {
		return true;
	}

	return false;
}

/**
 * Check if an operation failure should be deferred and retried on a later sync.
 */
export function isDeferrableError(error: Error): boolean {
	const deferrableStatusCodes = [423, 501];

	if (error instanceof OneDriveError) {
		return error.statusCode ? deferrableStatusCodes.includes(error.statusCode) : false;
	}

	if (error && typeof error === 'object' && 'statusCode' in error) {
		const statusCode = (error as unknown as { statusCode: number }).statusCode;
		if (typeof statusCode === 'number') {
			return deferrableStatusCodes.includes(statusCode);
		}
	}

	return false;
}

/**
 * Extract retry delay from error
 */
export function getRetryDelay(error: Error): number | undefined {
	if (error instanceof RateLimitError) {
		return (error.retryAfter || 60) * 1000; // Convert to milliseconds
	}
	return undefined;
}
