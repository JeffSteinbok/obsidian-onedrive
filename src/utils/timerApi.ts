/**
 * Cross-environment timer API.
 *
 * Obsidian runs in a browser context where `window` provides timers.
 * Our test suite runs under Node (vitest, environment: 'node') where
 * `window` may be undefined or stubbed without timer methods.
 *
 * Centralising this here avoids repeating the pattern in every file.
 * Timer methods are accessed lazily so vi.useFakeTimers() works in tests.
 */

export const timerApi = {
	setTimeout: (handler: () => void, timeout?: number): number =>
		window.setTimeout(handler, timeout) as unknown as number,
	clearTimeout: (id?: number): void =>
		window.clearTimeout(id),
	setInterval: (handler: () => void, timeout?: number): number =>
		window.setInterval(handler, timeout) as unknown as number,
	clearInterval: (id?: number): void =>
		window.clearInterval(id),
};
