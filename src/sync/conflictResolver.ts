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
	resolveConflict(conflictInfo: ConflictInfo): {
		direction: SyncDirection;
		newPath?: string;
	} {
		logger.debug('Resolving conflict:', conflictInfo);

		switch (this.strategy) {
			case ConflictResolutionStrategy.LAST_WRITE_WINS:
				return this.resolveLastWriteWins(conflictInfo);

			case ConflictResolutionStrategy.CREATE_DUPLICATE:
				return this.resolveCreateDuplicate(conflictInfo);

			case ConflictResolutionStrategy.MANUAL:
				return { direction: SyncDirection.CONFLICT };

			default:
				logger.warn('Unknown conflict resolution strategy, using last-write-wins');
				return this.resolveLastWriteWins(conflictInfo);
		}
	}

	private resolveLastWriteWins(conflictInfo: ConflictInfo): {
		direction: SyncDirection;
	} {
		if (conflictInfo.localModifiedTime > conflictInfo.remoteModifiedTime) {
			logger.debug('Local file is newer, will upload');
			return { direction: SyncDirection.UPLOAD };
		} else {
			logger.debug('Remote file is newer, will download');
			return { direction: SyncDirection.DOWNLOAD };
		}
	}

	private resolveCreateDuplicate(conflictInfo: ConflictInfo): {
		direction: SyncDirection;
		newPath: string;
	} {
		const conflictPath = createConflictFileName(conflictInfo.path);
		logger.debug('Creating duplicate file for conflict:', conflictPath);

		return {
			direction: SyncDirection.DOWNLOAD,
			newPath: conflictPath,
		};
	}
}
