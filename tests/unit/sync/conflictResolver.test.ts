/**
 * Unit tests for ConflictResolver
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictResolver } from '../../../src/sync/conflictResolver';
import { ConflictResolutionStrategy, SyncDirection } from '../../../src/types';

vi.mock('../../../src/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

describe('ConflictResolver', () => {
	let resolver: ConflictResolver;

	const makeConflictInfo = (localTime: number, remoteTime: number) => ({
		path: 'test/file.md',
		localModifiedTime: localTime,
		remoteModifiedTime: remoteTime,
		localSize: 100,
		remoteSize: 150,
	});

	describe('LAST_WRITE_WINS strategy', () => {
		beforeEach(() => {
			resolver = new ConflictResolver(ConflictResolutionStrategy.LAST_WRITE_WINS);
		});

		it('should upload when local is newer', () => {
			const result = resolver.resolveConflict(makeConflictInfo(2000, 1000));
			expect(result).toEqual({ kind: 'converge', direction: SyncDirection.UPLOAD });
		});

		it('should download when remote is newer', () => {
			const result = resolver.resolveConflict(makeConflictInfo(1000, 2000));
			expect(result).toEqual({ kind: 'converge', direction: SyncDirection.DOWNLOAD });
		});

		it('should download when times are equal (remote wins tie)', () => {
			const result = resolver.resolveConflict(makeConflictInfo(1000, 1000));
			expect(result).toEqual({ kind: 'converge', direction: SyncDirection.DOWNLOAD });
		});
	});

	describe('CREATE_DUPLICATE strategy', () => {
		beforeEach(() => {
			resolver = new ConflictResolver(ConflictResolutionStrategy.CREATE_DUPLICATE);
		});

		it('should return a duplicate result carrying the conflict path', () => {
			const result = resolver.resolveConflict(makeConflictInfo(2000, 1000));
			// CREATE_DUPLICATE keeps the remote version under a new dated path;
			// the discriminated union guarantees the path is always present.
			expect(result.kind).toBe('duplicate');
			if (result.kind !== 'duplicate') throw new Error('expected duplicate');
			expect(result.duplicatePath).toContain('file (conflict');
			expect(result.duplicatePath).toContain(').md');
		});
	});

	describe('MANUAL strategy', () => {
		beforeEach(() => {
			resolver = new ConflictResolver(ConflictResolutionStrategy.MANUAL);
		});

		it('should return a manual result with no direction or path', () => {
			const result = resolver.resolveConflict(makeConflictInfo(2000, 1000));
			expect(result).toEqual({ kind: 'manual' });
		});
	});

	describe('setStrategy', () => {
		it('should change the resolution strategy', () => {
			resolver = new ConflictResolver(ConflictResolutionStrategy.LAST_WRITE_WINS);

			// Initially uses LAST_WRITE_WINS
			let result = resolver.resolveConflict(makeConflictInfo(2000, 1000));
			expect(result).toEqual({ kind: 'converge', direction: SyncDirection.UPLOAD });

			// Change to MANUAL
			resolver.setStrategy(ConflictResolutionStrategy.MANUAL);
			result = resolver.resolveConflict(makeConflictInfo(2000, 1000));
			expect(result).toEqual({ kind: 'manual' });
		});
	});

	describe('unknown strategy fallback', () => {
		it('should fall back to LAST_WRITE_WINS for unknown strategy', () => {
			resolver = new ConflictResolver('unknown-strategy' as ConflictResolutionStrategy);
			const result = resolver.resolveConflict(makeConflictInfo(2000, 1000));
			// Should use last-write-wins fallback
			expect(result).toEqual({ kind: 'converge', direction: SyncDirection.UPLOAD });
		});
	});
});

