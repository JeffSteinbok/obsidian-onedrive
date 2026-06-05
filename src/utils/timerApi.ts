/**
 * Cross-environment timer API.
 *
 * Obsidian runs in a browser context where `window` provides timers.
 * Our test suite runs under Node (vitest, environment: 'node') where
 * `window` is undefined, so we fall back to the global scope.
 *
 * Centralising this here avoids repeating the pattern in every file.
 * Timer methods are accessed lazily so vi.useFakeTimers() works in tests.
 */

/**
 * Timer API that delegates to window (Obsidian) or global scope (Node tests).
 * Returns number for timer IDs to match browser/Obsidian semantics.
 */
export const timerApi = {
	setTimeout: (handler: TimerHandler, timeout?: number, ...args: unknown[]): number =>
		setTimeout(handler, timeout, ...args) as unknown as number,
	clearTimeout: (id?: number): void =>
		clearTimeout(id),
	setInterval: (handler: TimerHandler, timeout?: number, ...args: unknown[]): number =>
		setInterval(handler, timeout, ...args) as unknown as number,
	clearInterval: (id?: number): void =>
		clearInterval(id),
};
