/**
 * Content hashing for local↔remote comparison.
 *
 * OneDrive Personal returns a `sha1Hash` in the driveItem hashes facet
 * (uppercase hex). Computing the same hash locally lets us verify that
 * a same-size local file really has the same content as the remote copy,
 * instead of relying on the size heuristic alone.
 */

/**
 * Compute the SHA-1 of a buffer as an uppercase hex string (the format
 * OneDrive uses for `sha1Hash`). Returns undefined when WebCrypto is
 * unavailable so callers can fall back to the size heuristic.
 */
export async function sha1HexUpper(data: ArrayBuffer): Promise<string | undefined> {
	if (typeof crypto === 'undefined' || !crypto.subtle) {
		return undefined;
	}
	const digest = await crypto.subtle.digest('SHA-1', data);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.toUpperCase();
}
