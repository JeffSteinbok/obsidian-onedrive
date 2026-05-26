/**
 * Conflict detection and resolution
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
