/**
 * Conflict Resolution - Handles sync conflicts when both local and remote changed
 *
 * A conflict occurs when:
 * 1. A file exists both locally and remotely
 * 2. Both have been modified since the last sync
 * 3. The sync engine cannot determine which version is authoritative
 *
 * ## Resolution Strategies
 *
 * - **LAST_WRITE_WINS**: Compare timestamps, newer version wins
 *   - Simple and automatic
 *   - Risk: May lose changes if clocks are skewed
 *
 * - **CREATE_DUPLICATE**: Keep both versions
 *   - Creates `filename (conflict YYYY-MM-DD).ext` for the remote version
 *   - User manually merges later
 *   - Safest option, no data loss
 *
 * - **MANUAL**: Queue for user review
 *   - Adds to ConflictQueue for later resolution
 *   - User sees both versions side-by-side
 *   - Best for important documents
 *
 * ## Usage
 *
 * ```typescript
 * const resolver = new ConflictResolver(ConflictResolutionStrategy.LAST_WRITE_WINS);
 * const result = resolver.resolveConflict({
 *   path: 'notes/meeting.md',
 *   localMtime: Date.now(),
 *   remoteMtime: Date.now() - 60000, // remote is older
 * });
 * // result.direction === SyncDirection.UPLOAD (local wins)
 * ```
 *
 * @see ConflictQueue for manual resolution UI
 * @see SyncEngine.planOperations for conflict detection
 */

import { ConflictInfo, ConflictResolutionStrategy, SyncDirection } from '../types';
import { logger } from '../utils/logger';
import { createConflictFileName } from '../utils/pathUtils';

/**
 * Outcome of resolving a conflict, modelled as a discriminated union so that
 * illegal states are unrepresentable:
 *
 * - `converge` — a single-file resolution: upload local or download remote onto
 *   the SAME path. Always carries a concrete UPLOAD/DOWNLOAD direction.
 * - `duplicate` — keep both versions: the remote copy is written to
 *   `duplicatePath` and the local version converges the base path. `duplicatePath`
 *   is required by the type, so a duplicate result can never be missing its path
 *   (the pre-#128 `{ direction, newPath? }` shape allowed exactly that mistake).
 * - `manual` — defer to the user; the caller queues the conflict.
 */
export type ConflictResolutionResult =
	| { kind: 'converge'; direction: SyncDirection.UPLOAD | SyncDirection.DOWNLOAD }
	| { kind: 'duplicate'; duplicatePath: string }
	| { kind: 'manual' };

/**
 * Resolves sync conflicts
 */
export class ConflictResolver {
	constructor(private strategy: ConflictResolutionStrategy) {}

	/**
	 * Set conflict resolution strategy
	 */
	setStrategy(strategy: ConflictResolutionStrategy): void {
		this.strategy = strategy;
		logger.debug('Conflict resolution strategy changed to:', strategy);
	}

	/**
	 * Resolve a conflict based on strategy
	 */
	resolveConflict(conflictInfo: ConflictInfo): ConflictResolutionResult {
		logger.debug('Resolving conflict:', conflictInfo);

		switch (this.strategy) {
			case ConflictResolutionStrategy.LAST_WRITE_WINS:
				return this.resolveLastWriteWins(conflictInfo);

			case ConflictResolutionStrategy.CREATE_DUPLICATE:
				return this.resolveCreateDuplicate(conflictInfo);

			case ConflictResolutionStrategy.MANUAL:
				return { kind: 'manual' };

			default:
				logger.warn('Unknown conflict resolution strategy, using last-write-wins');
				return this.resolveLastWriteWins(conflictInfo);
		}
	}

	private resolveLastWriteWins(conflictInfo: ConflictInfo): ConflictResolutionResult {
		if (conflictInfo.localModifiedTime > conflictInfo.remoteModifiedTime) {
			logger.debug('Local file is newer, will upload');
			return { kind: 'converge', direction: SyncDirection.UPLOAD };
		} else {
			logger.debug('Remote file is newer, will download');
			return { kind: 'converge', direction: SyncDirection.DOWNLOAD };
		}
	}

	private resolveCreateDuplicate(conflictInfo: ConflictInfo): ConflictResolutionResult {
		const conflictPath = createConflictFileName(conflictInfo.path);
		logger.debug('Creating duplicate file for conflict:', conflictPath);

		return {
			kind: 'duplicate',
			duplicatePath: conflictPath,
		};
	}
}
