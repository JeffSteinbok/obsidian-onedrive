/**
 * Retry logic with exponential backoff
 */

import { logger } from './logger';
import { isRetryableError, getRetryDelay } from './errors';

type DecoratedAsyncMethod = (this: object, ...args: unknown[]) => Promise<unknown>;

function getDecoratedMethod(descriptor: PropertyDescriptor): DecoratedAsyncMethod {
	if (typeof descriptor.value !== 'function') {
		throw new Error('Decorator can only be applied to methods');
	}

	return descriptor.value as DecoratedAsyncMethod;
}

import { timerApi } from './timerApi';

export interface RetryOptions {
	maxAttempts?: number;
	initialDelay?: number; // milliseconds
	maxDelay?: number; // milliseconds
	backoffMultiplier?: number;
	onRetry?: (attempt: number, delay: number, error: Error) => void;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
	maxAttempts: 3,
	initialDelay: 1000, // 1 second
	maxDelay: 30000, // 30 seconds
	backoffMultiplier: 2,
	onRetry: () => {}, // No-op by default
};

/**
 * Retry a function with exponential backoff
 */
export async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {}
): Promise<T> {
	const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
	let lastError: Error;
	let delay = opts.initialDelay;

	for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error as Error;

			// Don't retry if it's the last attempt
			if (attempt === opts.maxAttempts) {
				throw lastError;
			}

			// Check if error is retryable
			if (!isRetryableError(lastError)) {
				logger.debug(`Error is not retryable, stopping retry attempts`, lastError);
				throw lastError;
			}

			// Use custom retry delay if provided by error (e.g., rate limit)
			const customDelay = getRetryDelay(lastError);
			if (customDelay) {
				delay = customDelay;
			}

			// Cap delay at maxDelay
			delay = Math.min(delay, opts.maxDelay);

			logger.debug(
				`Attempt ${attempt}/${opts.maxAttempts} failed, retrying in ${delay}ms`,
				lastError.message
			);

			opts.onRetry(attempt, delay, lastError);

			// Wait before retrying
			await sleep(delay);

			// Exponential backoff for next attempt
			delay *= opts.backoffMultiplier;
		}
	}

	// Should never reach here, but TypeScript needs it
	throw lastError!;
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => timerApi.setTimeout(resolve, ms));
}

/**
 * Decorator to automatically retry failed async methods
 */
export function retry(options: RetryOptions = {}) {
	return function (target: unknown, propertyKey: string, descriptor: PropertyDescriptor) {
		const originalMethod = getDecoratedMethod(descriptor);

		descriptor.value = async function (this: object, ...args: unknown[]) {
			return retryWithBackoff(() => Reflect.apply(originalMethod, this, args), options);
		};

		return descriptor;
	};
}
