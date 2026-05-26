/**
 * Unit tests for retry logic
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retryWithBackoff, sleep } from '../../../src/utils/retry';
import { OneDriveError, RateLimitError } from '../../../src/types';

// Import setup to initialize mocks
import '../../setup';

describe('retryWithBackoff', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should succeed on first attempt if no error', async () => {
		const fn = vi.fn().mockResolvedValue('success');

		const result = await retryWithBackoff(fn);

		expect(result).toBe('success');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('should retry on retryable errors', async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new OneDriveError('Server error', 'server_error', 500))
			.mockResolvedValue('success');

		const result = await retryWithBackoff(fn, {
			maxAttempts: 3,
			initialDelay: 10,
		});

		expect(result).toBe('success');
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('should not retry on non-retryable errors', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('Non-retryable error'));

		await expect(
			retryWithBackoff(fn, {
				maxAttempts: 3,
				initialDelay: 10,
			})
		).rejects.toThrow('Non-retryable error');

		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('should respect rate limit retry-after header', async () => {
		const rateLimitError = new RateLimitError('Rate limited', 2);
		const fn = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValue('success');

		const startTime = Date.now();
		const result = await retryWithBackoff(fn, {
			maxAttempts: 3,
			initialDelay: 10,
		});
		const endTime = Date.now();

		expect(result).toBe('success');
		expect(fn).toHaveBeenCalledTimes(2);
		// Should wait approximately 2 seconds (2000ms)
		expect(endTime - startTime).toBeGreaterThanOrEqual(1900);
	});

	it('should throw error after max attempts', async () => {
		const fn = vi.fn().mockRejectedValue(new OneDriveError('Server error', 'error', 500));

		await expect(
			retryWithBackoff(fn, {
				maxAttempts: 3,
				initialDelay: 10,
			})
		).rejects.toThrow('Server error');

		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('should call onRetry callback', async () => {
		const onRetry = vi.fn();
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new OneDriveError('Error', 'error', 500))
			.mockResolvedValue('success');

		await retryWithBackoff(fn, {
			maxAttempts: 3,
			initialDelay: 10,
			onRetry,
		});

		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(onRetry).toHaveBeenCalledWith(1, expect.any(Number), expect.any(OneDriveError));
	});
});

describe('sleep', () => {
	it('should wait for specified milliseconds', async () => {
		const startTime = Date.now();
		await sleep(100);
		const endTime = Date.now();

		expect(endTime - startTime).toBeGreaterThanOrEqual(90);
	});
});
