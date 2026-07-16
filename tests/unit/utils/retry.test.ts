/**
 * Unit tests for retry logic
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retryWithBackoff, sleep, retry } from '../../../src/utils/retry';
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

	it.each([423, 501])('should retry deferrable HTTP %s errors', async (statusCode) => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new OneDriveError(`HTTP ${statusCode}`, 'transient', statusCode))
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

	it('should cap delay at maxDelay', async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new OneDriveError('Error 1', 'error', 500))
			.mockRejectedValueOnce(new OneDriveError('Error 2', 'error', 500))
			.mockResolvedValue('success');

		const onRetry = vi.fn();
		const startTime = Date.now();

		await retryWithBackoff(fn, {
			maxAttempts: 5,
			initialDelay: 100,
			maxDelay: 150, // Cap at 150ms even with backoff
			backoffMultiplier: 10, // Would grow to 1000ms without cap
			onRetry,
		});

		const endTime = Date.now();
		// With cap, total delay should be ~250ms (100 + 150), not 1100ms (100 + 1000)
		expect(endTime - startTime).toBeLessThan(500);
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('should use default options when not provided', async () => {
		const fn = vi.fn().mockResolvedValue('result');

		const result = await retryWithBackoff(fn);

		expect(result).toBe('result');
		expect(fn).toHaveBeenCalledTimes(1);
	});
});

describe('sleep', () => {
	it('should wait for specified milliseconds', async () => {
		const startTime = Date.now();
		await sleep(100);
		const endTime = Date.now();

		expect(endTime - startTime).toBeGreaterThanOrEqual(90);
	});

	it('should resolve after delay', async () => {
		const result = await Promise.race([
			sleep(50).then(() => 'slept'),
			new Promise((resolve) => setTimeout(() => resolve('timeout'), 200)),
		]);

		expect(result).toBe('slept');
	});
});

describe('retry decorator', () => {
	it('should wrap method with retry logic', async () => {
		class TestClass {
			callCount = 0;

			@retry({ maxAttempts: 3, initialDelay: 10 })
			async fetchData(): Promise<string> {
				this.callCount++;
				if (this.callCount < 2) {
					throw new OneDriveError('Temporary failure', 'error', 500);
				}
				return 'data';
			}
		}

		const instance = new TestClass();
		const result = await instance.fetchData();

		expect(result).toBe('data');
		expect(instance.callCount).toBe(2);
	});

	it('should preserve method context (this)', async () => {
		class TestClass {
			value = 'test-value';

			@retry({ maxAttempts: 2, initialDelay: 10 })
			async getValue(): Promise<string> {
				return this.value;
			}
		}

		const instance = new TestClass();
		const result = await instance.getValue();

		expect(result).toBe('test-value');
	});
});
