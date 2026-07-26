import { beforeEach, describe, expect, it, vi } from 'vitest';

const { NoticeMock } = vi.hoisted(() => ({
	NoticeMock: vi.fn(function (this: { message: string; timeout?: number }, message: string, timeout?: number) {
		this.message = message;
		this.timeout = timeout;
	}),
}));

vi.mock('obsidian', async () => {
	const actual = await vi.importActual<typeof import('obsidian')>('obsidian');
	return {
		...actual,
		Notice: NoticeMock,
	};
});

import {
	getRetryDelay,
	handleAuthErrors,
	handleSyncErrors,
	isDeferrableError,
	isRetryableError,
	parseHttpError,
} from '../../../src/utils/errors';
import { AuthenticationError, OneDriveError, RateLimitError } from '../../../src/types';
import { logger } from '../../../src/utils/logger';

function applyDecorator(
	decorator: (target: unknown, propertyKey: string, descriptor: PropertyDescriptor) => PropertyDescriptor,
	propertyKey: string,
	error: unknown
): () => Promise<unknown> {
	const descriptor: PropertyDescriptor = {
		value: vi.fn().mockRejectedValue(error),
	};

	decorator({}, propertyKey, descriptor);
	return descriptor.value as () => Promise<unknown>;
}

describe('errors utils', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(logger, 'error').mockImplementation(() => undefined);
		vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
	});

	describe('handleSyncErrors', () => {
		it('catches AuthenticationError, logs it, shows a notice, and re-throws', async () => {
			const error = new AuthenticationError('Token expired', 'invalid_grant');
			const wrapped = applyDecorator(handleSyncErrors, 'sync', error);

			await expect(wrapped()).rejects.toBe(error);
			expect(logger.error).toHaveBeenCalledWith('Authentication error during sync:', error);
			expect(NoticeMock).toHaveBeenCalledWith(
				'OneDrive authentication failed. Please reconnect in settings.'
			);
		});

		it('catches RateLimitError, logs it, shows a retry notice, and re-throws', async () => {
			const error = new RateLimitError('Too many requests', 120);
			const wrapped = applyDecorator(handleSyncErrors, 'sync', error);

			await expect(wrapped()).rejects.toBe(error);
			expect(logger.warn).toHaveBeenCalledWith('Rate limit reached. Retry after 120 seconds');
			expect(NoticeMock).toHaveBeenCalledWith(
				'OneDrive rate limit reached. Will retry in 120 seconds...',
				5000
			);
		});

		it('catches OneDriveError, logs it, shows a notice, and re-throws', async () => {
			const error = new OneDriveError('API failed', 'bad_request', 400);
			const wrapped = applyDecorator(handleSyncErrors, 'sync', error);

			await expect(wrapped()).rejects.toBe(error);
			expect(logger.error).toHaveBeenCalledWith('OneDrive API error:', error);
			expect(NoticeMock).toHaveBeenCalledWith('OneDrive error: API failed', 5000);
		});

		it('catches unexpected errors, logs them, shows a notice, and re-throws', async () => {
			const error = new Error('boom');
			const wrapped = applyDecorator(handleSyncErrors, 'sync', error);

			await expect(wrapped()).rejects.toBe(error);
			expect(logger.error).toHaveBeenCalledWith('Unexpected error during sync:', error);
			expect(NoticeMock).toHaveBeenCalledWith(
				'An unexpected error occurred during sync. Check console for details.'
			);
		});
	});

	describe('handleAuthErrors', () => {
		it('shows a cancellation notice for access_denied errors', async () => {
			const error = new Error('access_denied: cancelled');
			const wrapped = applyDecorator(handleAuthErrors, 'authenticate', error);

			await expect(wrapped()).rejects.toBe(error);
			expect(logger.error).toHaveBeenCalledWith('Authentication error in authenticate:', error);
			expect(NoticeMock).toHaveBeenCalledWith('Authentication was cancelled. Please try again.');
		});

		it('re-throws authorization_pending errors without showing a notice', async () => {
			const error = new Error('authorization_pending');
			const wrapped = applyDecorator(handleAuthErrors, 'authenticate', error);

			await expect(wrapped()).rejects.toBe(error);
			expect(logger.error).toHaveBeenCalledWith('Authentication error in authenticate:', error);
			expect(NoticeMock).not.toHaveBeenCalled();
		});

		it('shows an expired-token notice', async () => {
			const error = new Error('expired_token');
			const wrapped = applyDecorator(handleAuthErrors, 'authenticate', error);

			await expect(wrapped()).rejects.toBe(error);
			expect(NoticeMock).toHaveBeenCalledWith('Authentication code expired. Please try again.');
		});

		it('shows a generic authentication error notice', async () => {
			const error = new Error('Unexpected auth failure');
			const wrapped = applyDecorator(handleAuthErrors, 'authenticate', error);

			await expect(wrapped()).rejects.toBe(error);
			expect(NoticeMock).toHaveBeenCalledWith('Authentication failed: Unexpected auth failure');
		});
	});

	describe('parseHttpError', () => {
		it('returns AuthenticationError for 401 responses', () => {
			const error = parseHttpError(
				401,
				JSON.stringify({ error: 'invalid_grant', error_description: 'Token expired' })
			);

			expect(error).toBeInstanceOf(AuthenticationError);
			expect(error).toMatchObject({
				message: 'Token expired',
				code: 'invalid_grant',
				statusCode: 401,
			});
		});

		it('returns RateLimitError for 429 responses', () => {
			const error = parseHttpError(
				429,
				JSON.stringify({ message: 'Slow down', retry_after: 90 })
			);

			expect(error).toBeInstanceOf(RateLimitError);
			expect(error).toMatchObject({
				message: 'Slow down',
				retryAfter: 90,
				statusCode: 429,
			});
		});

		it.each([-5, 0, 'bad-value'])(
			'falls back to default retryAfter for invalid 429 retry_after body value (%s)',
			(retryAfterValue) => {
				const error = parseHttpError(
					429,
					JSON.stringify({ message: 'Slow down', retry_after: retryAfterValue })
				);

				expect(error).toBeInstanceOf(RateLimitError);
				expect(error).toMatchObject({
					message: 'Slow down',
					retryAfter: 60,
					statusCode: 429,
				});
			}
		);

		it('returns OneDriveError for other statuses', () => {
			const error = parseHttpError(
				500,
				JSON.stringify({ error: 'server_error', message: 'Internal failure' })
			);

			expect(error).toBeInstanceOf(OneDriveError);
			expect(error).toMatchObject({
				message: 'Internal failure',
				code: 'server_error',
				statusCode: 500,
			});
		});

		it('returns a generic OneDriveError for malformed JSON bodies', () => {
			const error = parseHttpError(502, 'not-json');

			expect(error).toBeInstanceOf(OneDriveError);
			expect(error).toMatchObject({
				message: 'HTTP 502: not-json',
				statusCode: 502,
			});
		});
	});

	describe('isRetryableError', () => {
		it('returns true for RateLimitError', () => {
			expect(isRetryableError(new RateLimitError('Too many requests', 30))).toBe(true);
		});

		it.each([408, 423, 429, 500, 501, 502, 503, 504])(
			'returns true for retryable OneDriveError status %s',
			(statusCode) => {
				expect(isRetryableError(new OneDriveError('Retry me', 'code', statusCode))).toBe(true);
			}
		);

		it.each([400, 404])('returns false for non-retryable OneDriveError status %s', (statusCode) => {
			expect(isRetryableError(new OneDriveError('Do not retry', 'code', statusCode))).toBe(false);
		});

		it('returns true for network and timeout errors', () => {
			expect(isRetryableError(new Error('network request failed'))).toBe(true);
			expect(isRetryableError(new Error('timeout while waiting for response'))).toBe(true);
		});

		it.each([408, 423, 429, 500, 501, 502, 503, 504])(
			'returns true for Graph SDK errors with retryable statusCode %s',
			(statusCode) => {
				const error = Object.assign(new Error('Graph SDK error'), { statusCode, code: 'UnknownError' });
				expect(isRetryableError(error)).toBe(true);
			}
		);

		it('returns true for retryable numeric-string status codes', () => {
			const oneDriveError = Object.assign(new OneDriveError('Retry me', 'code', 400), { statusCode: '423' });
			const graphError = Object.assign(new Error('Graph SDK error'), { statusCode: '423' });
			expect(isRetryableError(oneDriveError)).toBe(true);
			expect(isRetryableError(graphError)).toBe(true);
		});

		it.each([400, 404])('returns false for Graph SDK errors with non-retryable statusCode %s', (statusCode) => {
			const error = Object.assign(new Error('Graph SDK error'), { statusCode, code: 'BadRequest' });
			expect(isRetryableError(error)).toBe(false);
		});

		it('returns false for generic errors', () => {
			expect(isRetryableError(new Error('some other error'))).toBe(false);
		});
	});

	describe('isDeferrableError', () => {
		it.each([423, 501])('returns true for deferrable OneDriveError status %s', (statusCode) => {
			expect(isDeferrableError(new OneDriveError('Retry later', 'code', statusCode))).toBe(true);
		});

		it.each([423, 501])('returns true for Graph SDK errors with deferrable statusCode %s', (statusCode) => {
			const error = Object.assign(new Error('Graph SDK error'), { statusCode });
			expect(isDeferrableError(error)).toBe(true);
		});

		it('returns true for deferrable numeric-string status codes', () => {
			const oneDriveError = Object.assign(new OneDriveError('Retry later', 'code', 400), { statusCode: '423' });
			const graphError = Object.assign(new Error('Graph SDK error'), { statusCode: '501' });
			expect(isDeferrableError(oneDriveError)).toBe(true);
			expect(isDeferrableError(graphError)).toBe(true);
		});

		it.each([400, 404, 500])('returns false for non-deferrable status %s', (statusCode) => {
			expect(isDeferrableError(new OneDriveError('Not deferred', 'code', statusCode))).toBe(false);
		});
	});

	describe('getRetryDelay', () => {
		it('returns retryAfter in milliseconds for RateLimitError', () => {
			expect(getRetryDelay(new RateLimitError('Too many requests', 45))).toBe(45000);
		});

		it('falls back to default delay for invalid RateLimitError retryAfter values', () => {
			expect(getRetryDelay(new RateLimitError('Too many requests', -5))).toBe(60000);
			expect(getRetryDelay(new RateLimitError('Too many requests', 0))).toBe(60000);
		});

		it('returns undefined for non-rate-limit errors', () => {
			expect(getRetryDelay(new OneDriveError('API failed', 'bad_request', 400))).toBeUndefined();
			expect(getRetryDelay(new Error('boom'))).toBeUndefined();
		});
	});
});
