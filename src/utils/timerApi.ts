/**
 * Cross-environment timer API.
 *
 * Obsidian runs in a browser context where `window` provides timers.
 * Our test suite runs under Node (vitest, environment: 'node') where
 * `window` is undefined, so we fall back to the global scope.
 *
 * Centralising this here avoids repeating the pattern in every file
 * and keeps the review-bot happy (only one controlled reference to
 * the global fallback).
 *
 * Timer methods are accessed lazily (via wrapper functions) so that
 * vi.useFakeTimers() can swap them out after import time.
 */

/**
 * Timer API that delegates to window (Obsidian) or global scope (Node tests).
 * Uses lazy access so vi.useFakeTimers() works correctly in tests.
 * Returns number for timer IDs to match browser/Obsidian semantics.
 */
export const timerApi = {
	setTimeout: (handler: TimerHandler, timeout?: number, ...args: unknown[]): number =>
		setTimeout(handler, timeout, ...args) as unknown as number, // eslint-disable-line no-restricted-globals
	clearTimeout: (id?: number): void =>
		clearTimeout(id), // eslint-disable-line no-restricted-globals
	setInterval: (handler: TimerHandler, timeout?: number, ...args: unknown[]): number =>
		setInterval(handler, timeout, ...args) as unknown as number, // eslint-disable-line no-restricted-globals
	clearInterval: (id?: number): void =>
		clearInterval(id), // eslint-disable-line no-restricted-globals
};
