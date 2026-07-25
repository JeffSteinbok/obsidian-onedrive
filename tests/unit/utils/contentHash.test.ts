/**
 * Unit tests for content hashing helper
 */

import { describe, it, expect } from 'vitest';
import { sha1HexUpper } from '../../../src/utils/contentHash';

const encode = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;

describe('sha1HexUpper', () => {
	it('computes the SHA-1 of an empty buffer as uppercase hex', async () => {
		expect(await sha1HexUpper(encode(''))).toBe('DA39A3EE5E6B4B0D3255BFEF95601890AFD80709');
	});

	it('computes a known SHA-1 vector as uppercase hex', async () => {
		expect(await sha1HexUpper(encode('abc'))).toBe('A9993E364706816ABA3E25717850C26C9CD0D89D');
	});

	it('returns undefined when WebCrypto is unavailable', async () => {
		const original = globalThis.crypto;
		try {
			Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
			expect(await sha1HexUpper(encode('abc'))).toBeUndefined();
		} finally {
			Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
		}
	});
});
