/**
 * Unit tests for path utilities
 */

import { describe, it, expect } from 'vitest';
import {
	normalizePath,
	joinPath,
	getParentPath,
	getFileName,
	getFileExtension,
	getFileNameWithoutExtension,
	sanitizeFileName,
	createConflictFileName,
	toOneDrivePath,
	toVaultPath,
} from '../../../src/utils/pathUtils';

describe('pathUtils', () => {
	describe('normalizePath', () => {
		it('should convert backslashes to forward slashes', () => {
			expect(normalizePath('foo\\bar\\baz')).toBe('foo/bar/baz');
			expect(normalizePath('C:\\Users\\Name\\file.txt')).toBe('C:/Users/Name/file.txt');
		});

		it('should leave forward slashes unchanged', () => {
			expect(normalizePath('foo/bar/baz')).toBe('foo/bar/baz');
		});
	});

	describe('joinPath', () => {
		it('should join path segments with forward slashes', () => {
			expect(joinPath('foo', 'bar', 'baz')).toBe('foo/bar/baz');
		});

		it('should handle leading/trailing slashes', () => {
			expect(joinPath('/foo/', '/bar/', '/baz/')).toBe('foo/bar/baz');
		});

		it('should filter out empty segments', () => {
			expect(joinPath('foo', '', 'bar')).toBe('foo/bar');
		});
	});

	describe('getParentPath', () => {
		it('should return parent directory', () => {
			expect(getParentPath('foo/bar/file.txt')).toBe('foo/bar');
			expect(getParentPath('foo/file.txt')).toBe('foo');
		});

		it('should return empty string for root-level files', () => {
			expect(getParentPath('file.txt')).toBe('');
		});
	});

	describe('getFileName', () => {
		it('should extract filename from path', () => {
			expect(getFileName('foo/bar/file.txt')).toBe('file.txt');
			expect(getFileName('file.txt')).toBe('file.txt');
		});
	});

	describe('getFileExtension', () => {
		it('should extract file extension including dot', () => {
			expect(getFileExtension('file.txt')).toBe('.txt');
			expect(getFileExtension('archive.tar.gz')).toBe('.gz');
		});

		it('should return empty string for files without extension', () => {
			expect(getFileExtension('README')).toBe('');
		});
	});

	describe('getFileNameWithoutExtension', () => {
		it('should return filename without extension', () => {
			expect(getFileNameWithoutExtension('file.txt')).toBe('file');
			expect(getFileNameWithoutExtension('archive.tar.gz')).toBe('archive.tar');
		});

		it('should return full name for files without extension', () => {
			expect(getFileNameWithoutExtension('README')).toBe('README');
		});
	});

	describe('sanitizeFileName', () => {
		it('should remove invalid characters', () => {
			expect(sanitizeFileName('file<name>.txt')).toBe('file_name_.txt');
			expect(sanitizeFileName('file|name')).toBe('file_name');
		});

		it('should handle reserved names', () => {
			expect(sanitizeFileName('con')).toBe('_con');
			expect(sanitizeFileName('CON')).toBe('_CON');
		});

		it('should remove leading/trailing dots and spaces', () => {
			expect(sanitizeFileName('  .file.txt  ')).toBe('file.txt');
		});

		it('should return "unnamed" for empty result', () => {
			expect(sanitizeFileName('...')).toBe('unnamed');
		});
	});

	describe('createConflictFileName', () => {
		it('should add conflict marker with timestamp', () => {
			const result = createConflictFileName('note.md');
			expect(result).toMatch(/^note \(conflict \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\)\.md$/);
		});

		it('should work with files without extension', () => {
			const result = createConflictFileName('README');
			expect(result).toMatch(/^README \(conflict \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\)$/);
		});
	});

	describe('toOneDrivePath', () => {
		it('should prepend remote root to vault path', () => {
			expect(toOneDrivePath('notes/file.md', '/vault')).toBe('/vault/notes/file.md');
		});

		it('should handle empty remote root', () => {
			expect(toOneDrivePath('notes/file.md', '')).toBe('notes/file.md');
		});
	});

	describe('toVaultPath', () => {
		it('should remove remote root from OneDrive path', () => {
			expect(toVaultPath('/vault/notes/file.md', '/vault')).toBe('notes/file.md');
		});

		it('should return path as-is if not under root', () => {
			expect(toVaultPath('/other/file.md', '/vault')).toBe('/other/file.md');
		});
	});
});
