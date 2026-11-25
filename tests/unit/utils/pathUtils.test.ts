/**
 * Unit tests for path utilities
 */

import { describe, it, expect } from 'vitest';
import {
	normalizePath,
	normalizeAdditionalSyncFolders,
	validateAdditionalSyncFolders,
	isInHiddenTopLevelFolder,
	isOutOfDeviceScope,
	getFoldersEnteringScope,
	isInAdditionalSyncFolder,
	getAdditionalFolderSyncPaths,
	joinPath,
	getParentPath,
	getFileName,
	getFileExtension,
	getFileNameWithoutExtension,
	sanitizeFileName,
	createConflictFileName,
	isConflictCopyPath,
	toOneDrivePath,
	toVaultPath,
	encodePathForGraph,
	stripGraphPrefix,
	shouldSyncVaultPath,
	getInstalledPluginSyncPaths,
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

		it.each([
			['notes/archive/report.v2.md', /^notes\/archive\/report\.v2 \(conflict .*\)\.md$/],
			['.claude/CLAUDE.md', /^\.claude\/CLAUDE \(conflict .*\)\.md$/],
			['docs.v2/README', /^docs\.v2\/README \(conflict .*\)$/],
			['.claude/.env', /^\.claude\/\.env \(conflict .*\)$/],
		])('keeps the parent and basename of %s', (path, expected) => {
			const copy = createConflictFileName(path);
			expect(copy).toMatch(expected);
			expect(isConflictCopyPath(copy)).toBe(true);
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

		it('should preserve a sibling folder whose name starts with the remote root name', () => {
			expect(toVaultPath('/vault-backup/notes/file.md', '/vault')).toBe('/vault-backup/notes/file.md');
		});

		it('should handle shared drive paths after prefix stripping', () => {
			// After stripGraphPrefix removes /drives/{id}/root:, the remaining path
			// needs to have the shared folder root stripped
			const pathAfterStrip = '/Documents/ObsidianVaults/JeffBrain/notes/daily.md';
			const remoteRoot = '/Documents/ObsidianVaults/JeffBrain';
			expect(toVaultPath(pathAfterStrip, remoteRoot)).toBe('notes/daily.md');
		});

		it('should handle root-level files in shared folder', () => {
			const pathAfterStrip = '/Documents/ObsidianVaults/JeffBrain/Welcome.md';
			const remoteRoot = '/Documents/ObsidianVaults/JeffBrain';
			expect(toVaultPath(pathAfterStrip, remoteRoot)).toBe('Welcome.md');
		});

		it('should handle .obsidian paths for filtering', () => {
			const pathAfterStrip = '/Documents/ObsidianVaults/JeffBrain/.obsidian/app.json';
			const remoteRoot = '/Documents/ObsidianVaults/JeffBrain';
			const vaultPath = toVaultPath(pathAfterStrip, remoteRoot);
			expect(vaultPath).toBe('.obsidian/app.json');
			expect(vaultPath.startsWith('.obsidian/')).toBe(true);
			});

			it('should handle empty remote root', () => {
				expect(toVaultPath('notes/file.md', '')).toBe('notes/file.md');
			});
	});

	describe('encodePathForGraph', () => {
		it('should encode individual path segments', () => {
			expect(encodePathForGraph('/JeffBrain/file.md')).toBe('JeffBrain/file.md');
		});

		it('should encode special characters in segments', () => {
			expect(encodePathForGraph('/My Folder/file name.md')).toBe('My%20Folder/file%20name.md');
		});

		it('should preserve slashes between segments', () => {
			expect(encodePathForGraph('/a/b/c/d.txt')).toBe('a/b/c/d.txt');
		});

		it('should encode hash and question mark', () => {
			expect(encodePathForGraph('/notes/file#1.md')).toBe('notes/file%231.md');
		});

		it('should handle single segment', () => {
			expect(encodePathForGraph('file.md')).toBe('file.md');
		});

		it('should handle empty path', () => {
			expect(encodePathForGraph('')).toBe('');
		});
	});

	describe('stripGraphPrefix', () => {
		it('should strip /drive/root: prefix', () => {
			expect(stripGraphPrefix('/drive/root:/Documents/file.md')).toBe('/Documents/file.md');
		});

		it('should strip /drive/special/approot: prefix', () => {
			expect(stripGraphPrefix('/drive/special/approot:/notes/file.md')).toBe('/notes/file.md');
		});

		it('should strip /drives/{driveId}/root: prefix', () => {
			expect(
				stripGraphPrefix(
					'/drives/48043224b16ff524/root:/Documents/ObsidianVaults/JeffBrain/file.md'
				)
			).toBe('/Documents/ObsidianVaults/JeffBrain/file.md');
		});

		it('should handle uppercase drive IDs', () => {
			expect(stripGraphPrefix('/drives/48043224B16FF524/root:/Documents/file.md')).toBe(
				'/Documents/file.md'
			);
		});

		it('should handle alphanumeric+special drive IDs', () => {
			expect(stripGraphPrefix('/drives/ABC123!def/root:/file.md')).toBe('/file.md');
		});

		it('should return path unchanged if no prefix matches', () => {
			expect(stripGraphPrefix('/Documents/file.md')).toBe('/Documents/file.md');
		});

		it('should return empty-ish path for root-only prefix', () => {
			expect(stripGraphPrefix('/drive/root:')).toBe('');
		});

		it('should handle full shared drive delta path end-to-end', () => {
			// Simulates what remotePathToVaultPath does:
			// 1. Delta item has parentReference.path + name
			const parentPath = '/drives/48043224B16FF524/root:/Documents/ObsidianVaults/JeffBrain';
			const name = 'Welcome.md';
			const fullPath = `${parentPath}/${name}`;

			// 2. Strip the Graph prefix
			const stripped = stripGraphPrefix(fullPath);
			expect(stripped).toBe('/Documents/ObsidianVaults/JeffBrain/Welcome.md');

			// 3. Then toVaultPath strips the remote root
			const vaultPath = toVaultPath(stripped, '/Documents/ObsidianVaults/JeffBrain');
			expect(vaultPath).toBe('Welcome.md');
		});

		it('should handle nested file in shared drive end-to-end', () => {
			const parentPath =
				'/drives/48043224B16FF524/root:/Documents/ObsidianVaults/JeffBrain/subfolder';
			const name = 'note.md';
			const fullPath = `${parentPath}/${name}`;

			const stripped = stripGraphPrefix(fullPath);
			const vaultPath = toVaultPath(stripped, '/Documents/ObsidianVaults/JeffBrain');
			expect(vaultPath).toBe('subfolder/note.md');
		});

		it('should correctly identify .obsidian files for filtering', () => {
			const parentPath =
				'/drives/48043224B16FF524/root:/Documents/ObsidianVaults/JeffBrain/.obsidian';
			const name = 'workspace.json';
			const fullPath = `${parentPath}/${name}`;

			const stripped = stripGraphPrefix(fullPath);
			const vaultPath = toVaultPath(stripped, '/Documents/ObsidianVaults/JeffBrain');
			expect(vaultPath).toBe('.obsidian/workspace.json');
			expect(vaultPath.startsWith('.obsidian/')).toBe(true);
		});
	});

	describe('shouldSyncVaultPath', () => {
		it('applies exact config file settings to their dated conflict copies', () => {
			const appCopy = createConflictFileName('.obsidian/app.json');
			const pluginCopy = createConflictFileName('.obsidian/plugins/calendar/data.json');
			const ownCopy = createConflictFileName('.obsidian/plugins/onedrive-sync/data.json');
			expect(shouldSyncVaultPath(appCopy, false, true, '.obsidian')).toBe(true);
			expect(shouldSyncVaultPath(appCopy, false, false, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath(pluginCopy, true, false, '.obsidian', false, false, true)).toBe(true);
			expect(shouldSyncVaultPath(pluginCopy, true, false, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath(ownCopy, true, true, '.obsidian', true, true, true)).toBe(false);
		});

		it('should sync non-.obsidian files by default', () => {
			expect(shouldSyncVaultPath('notes/file.md', false, false, '.obsidian')).toBe(true);
		});

		it('should exclude .obsidian files by default', () => {
			expect(shouldSyncVaultPath('.obsidian/workspace.json', false, false, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/plugins/calendar/manifest.json', false, false, '.obsidian')).toBe(false);
		});

		it('respects a custom vault config directory', () => {
			expect(shouldSyncVaultPath('.config/app.json', false, true, '.config')).toBe(true);
			expect(shouldSyncVaultPath('.config/plugins/calendar/main.js', true, false, '.config')).toBe(
				true
			);
			expect(shouldSyncVaultPath('.config/workspace.json', true, true, '.config')).toBe(false);
			// Another vault's stray `.obsidian/` is just a hidden folder here:
			// out of scope unless this device opts in to it.
			expect(shouldSyncVaultPath('.obsidian/app.json', false, true, '.config')).toBe(false);
			expect(
				shouldSyncVaultPath('.obsidian/app.json', false, true, '.config', false, false, false, {
					includeHiddenFolders: ['.obsidian'],
				})
			).toBe(true);
		});

		it('should sync app settings files when syncAppSettings is enabled', () => {
			expect(shouldSyncVaultPath('.obsidian/app.json', false, true, '.obsidian')).toBe(true);
			expect(shouldSyncVaultPath('.obsidian/appearance.json', false, true, '.obsidian')).toBe(true);
			expect(shouldSyncVaultPath('.obsidian/hotkeys.json', false, true, '.obsidian')).toBe(true);
		});

		it('should exclude non-allowlisted .obsidian files even when syncAppSettings is enabled', () => {
			expect(shouldSyncVaultPath('.obsidian/workspace.json', false, true, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/plugins/calendar/data.json', false, true, '.obsidian')).toBe(false);
		});

		it('should allow selected plugin manifest files when syncPluginManifests is opted in', () => {
			expect(shouldSyncVaultPath('.obsidian/community-plugins.json', true, false, '.obsidian')).toBe(true);
			expect(shouldSyncVaultPath('.obsidian/core-plugins.json', true, false, '.obsidian')).toBe(true);
		});

		it('should sync plugin binaries when syncPluginManifests is opted in', () => {
			expect(shouldSyncVaultPath('.obsidian/plugins/calendar/manifest.json', true, false, '.obsidian')).toBe(true);
			expect(shouldSyncVaultPath('.obsidian/plugins/calendar/main.js', true, false, '.obsidian')).toBe(true);
			expect(shouldSyncVaultPath('.obsidian/plugins/calendar/styles.css', true, false, '.obsidian')).toBe(true);
		});

		it('should exclude plugin data files when syncPluginManifests is opted in', () => {
			expect(shouldSyncVaultPath('.obsidian/plugins/calendar/data.json', true, false, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/plugins/calendar/subdir/manifest.json', true, false, '.obsidian')).toBe(
				false
			);
		});

		it('should sync plugin data files when both plugin options are enabled', () => {
			expect(
				shouldSyncVaultPath(
					'.obsidian/plugins/calendar/data.json', true, false, '.obsidian', false, false, true
				)
			).toBe(true);
			expect(
				shouldSyncVaultPath(
					'.obsidian/plugins/calendar/settings.json', true, false, '.obsidian', false, false, true
				)
			).toBe(false);
		});

		it('should sync app settings and plugin files simultaneously when both are enabled', () => {
			expect(shouldSyncVaultPath('.obsidian/app.json', true, true, '.obsidian')).toBe(true);
			expect(shouldSyncVaultPath('.obsidian/plugins/calendar/main.js', true, true, '.obsidian')).toBe(true);
			expect(shouldSyncVaultPath('.obsidian/workspace.json', true, true, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/plugins/calendar/data.json', true, true, '.obsidian')).toBe(false);
		});

		it('always excludes the per-device debug log folder from sync', () => {
			expect(shouldSyncVaultPath('_OneDriveSyncLogs', false, false, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath('_OneDriveSyncLogs/2026-06-04.md', false, false, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath('_OneDriveSyncLogs/sub/dir/note.md', true, true, '.obsidian')).toBe(false);
			// Files that just look similar should still sync — exclusion is
			// folder-scoped, not name-scoped, so moving a log out of the folder
			// makes it syncable again.
			expect(shouldSyncVaultPath('_OneDriveSyncLogs-2026-06-04.md', false, false, '.obsidian')).toBe(true);
			expect(shouldSyncVaultPath('_OneDriveSyncLogsBackup/foo.md', false, false, '.obsidian')).toBe(true);
			expect(shouldSyncVaultPath('notes/_OneDriveSyncLogs/x.md', false, false, '.obsidian')).toBe(true);
		});

		it('never syncs the OneDrive plugin\'s own folder, even with plugin sync enabled', () => {
			expect(shouldSyncVaultPath('.obsidian/plugins/onedrive-sync', false, false, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/plugins/onedrive-sync/main.js', true, true, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/plugins/onedrive-sync/manifest.json', true, true, '.obsidian')).toBe(false);
			expect(
				shouldSyncVaultPath(
					'.obsidian/plugins/onedrive-sync/data.json', true, true, '.obsidian', false, false, true
				)
			).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/plugins/onedrive-sync/styles.css', true, true, '.obsidian')).toBe(false);
			// Old plugin folder should also be excluded (migration safety)
			expect(shouldSyncVaultPath('.obsidian/plugins/obsidian-onedrive', false, false, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/plugins/obsidian-onedrive/main.js', true, true, '.obsidian')).toBe(false);
			// Other plugins are unaffected.
			expect(shouldSyncVaultPath('.obsidian/plugins/calendar/main.js', true, false, '.obsidian')).toBe(true);
		});

		it('never syncs Obsidian per-device workspace state files', () => {
			expect(shouldSyncVaultPath('.obsidian/workspace.json', true, true, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/workspace-mobile.json', true, true, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/workspace-JEFFSTEISL7.json', true, true, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/workspace-JEFFOFFICE3-6.json', true, true, '.obsidian')).toBe(false);
			// Other .obsidian files still follow the normal rules.
			expect(shouldSyncVaultPath('.obsidian/app.json', false, true, '.obsidian')).toBe(true);
		});

		it('should NOT sync CSS snippets when syncCssSnippets is disabled (default)', () => {
			expect(shouldSyncVaultPath('.obsidian/snippets/my-style.css', false, false, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/snippets/another.css', false, false, '.obsidian')).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/snippets', false, false, '.obsidian')).toBe(false);
		});

		it('should sync CSS snippet files when syncCssSnippets is enabled', () => {
			expect(shouldSyncVaultPath('.obsidian/snippets/my-style.css', false, false, '.obsidian', true)).toBe(true);
			expect(shouldSyncVaultPath('.obsidian/snippets/another.css', false, false, '.obsidian', true)).toBe(true);
		});

		it('should sync snippets folder itself when syncCssSnippets is enabled', () => {
			expect(shouldSyncVaultPath('.obsidian/snippets', false, false, '.obsidian', true)).toBe(true);
		});

		it('should NOT sync non-css files in snippets folder', () => {
			expect(shouldSyncVaultPath('.obsidian/snippets/note.md', false, false, '.obsidian', true)).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/snippets/style.json', false, false, '.obsidian', true)).toBe(false);
		});

		it('should NOT sync files in subdirectories of snippets folder', () => {
			expect(shouldSyncVaultPath('.obsidian/snippets/sub/style.css', false, false, '.obsidian', true)).toBe(false);
		});

		it('should sync CSS snippets independently of app settings and plugin manifests', () => {
			expect(shouldSyncVaultPath('.obsidian/snippets/my-style.css', true, true, '.obsidian', true)).toBe(true);
			expect(shouldSyncVaultPath('.obsidian/snippets/my-style.css', false, false, '.obsidian', true)).toBe(true);
		});

		it('should work with custom configDir for snippets', () => {
			expect(shouldSyncVaultPath('.config/snippets/my-style.css', false, false, '.config', true)).toBe(true);
			// .obsidian/ is not the configDir here -- it is a hidden folder, synced only when opted in
			expect(shouldSyncVaultPath('.obsidian/snippets/my-style.css', false, false, '.config', true)).toBe(false);
			expect(shouldSyncVaultPath('.obsidian/snippets/my-style.css', false, false, '.config', false)).toBe(false);
		});

		it('should NOT sync bookmarks when syncBookmarks is disabled (default)', () => {
			expect(shouldSyncVaultPath('.obsidian/bookmarks.json', false, false, '.obsidian')).toBe(false);
		});

		it('should sync bookmarks.json when syncBookmarks is enabled', () => {
			expect(shouldSyncVaultPath('.obsidian/bookmarks.json', false, false, '.obsidian', false, true)).toBe(true);
		});

		it('should sync bookmarks independently of app settings and plugin manifests', () => {
			expect(shouldSyncVaultPath('.obsidian/bookmarks.json', true, true, '.obsidian', false, true)).toBe(true);
			expect(shouldSyncVaultPath('.obsidian/bookmarks.json', false, false, '.obsidian', false, true)).toBe(true);
		});

		it('should NOT sync bookmarks when syncBookmarks is disabled even if other settings are on', () => {
			expect(shouldSyncVaultPath('.obsidian/bookmarks.json', true, true, '.obsidian', true, false)).toBe(false);
		});

		it('should work with custom configDir for bookmarks', () => {
			expect(shouldSyncVaultPath('.config/bookmarks.json', false, false, '.config', false, true)).toBe(true);
			// .obsidian/ is not the configDir here -- it is a hidden folder, synced only when opted in
			expect(shouldSyncVaultPath('.obsidian/bookmarks.json', false, false, '.config', false, true)).toBe(false);
		});
	});

	describe('getInstalledPluginSyncPaths', () => {
		it('includes data.json only when plugin data sync is enabled', async () => {
			const adapter = { list: async () => ({ folders: ['.obsidian/plugins/calendar'] }) };

			expect(await getInstalledPluginSyncPaths('.obsidian', adapter, false)).not.toContain(
				'.obsidian/plugins/calendar/data.json'
			);
			expect(await getInstalledPluginSyncPaths('.obsidian', adapter, true)).toContain(
				'.obsidian/plugins/calendar/data.json'
			);
		});
	});
});

describe('additional sync folders', () => {
	it('normalizes user input', () => {
		expect(
			normalizeAdditionalSyncFolders([' .claude ', '.claude/', '\\.xyz', '', '../x', 'a/../b'], '.obsidian')
		).toEqual(['.claude', '.xyz']);
	});

	it('rejects non-hidden folders and the config dir with a reason', () => {
		expect(
			validateAdditionalSyncFolders(['.claude', 'Attachments', 'notes/.hidden', '.obsidian', '.obsidian/x', '../x'], '.obsidian')
		).toEqual({
			folders: ['.claude'],
			rejected: [
				{ folder: 'Attachments', reason: 'not-hidden' },
				{ folder: 'notes/.hidden', reason: 'not-hidden' },
				{ folder: '.obsidian', reason: 'config-dir' },
				{ folder: '.obsidian/x', reason: 'config-dir' },
				{ folder: '../x', reason: 'invalid' },
			],
		});
	});

	it('ignores a non-array stored value instead of iterating a string', () => {
		expect(normalizeAdditionalSyncFolders('.claude', '.obsidian')).toEqual([]);
		expect(normalizeAdditionalSyncFolders(undefined, '.obsidian')).toEqual([]);
	});

	it('matches paths inside configured folders', () => {
		expect(isInAdditionalSyncFolder('.claude/a/b.md', ['.claude'])).toBe(true);
		expect(isInAdditionalSyncFolder('.claude', ['.claude'])).toBe(true);
		expect(isInAdditionalSyncFolder('.claudex/a.md', ['.claude'])).toBe(false);
	});

	it('lists files recursively through the adapter', async () => {
		const tree: Record<string, { folders: string[]; files: string[] }> = {
			'.claude': { folders: ['.claude/sub'], files: ['.claude/a.json'] },
			'.claude/sub': { folders: [], files: ['.claude/sub/b.md'] },
		};
		const adapter = {
			list: async (p: string) => {
				if (!tree[p]) throw new Error('missing');
				return tree[p];
			},
		};
		expect(await getAdditionalFolderSyncPaths(['.claude', '.missing'], adapter)).toEqual([
			'.claude/a.json',
			'.claude/sub/b.md',
		]);
	});
});

describe('per-device sync filter in shouldSyncVaultPath', () => {
	const sync = (path: string, filter = {}) =>
		shouldSyncVaultPath(path, true, true, '.obsidian', true, true, true, filter);

	it('keeps hidden top-level folders out of scope unless included', () => {
		expect(sync('.claude/settings.json')).toBe(false);
		expect(sync('.trash/old.md')).toBe(false);
		expect(sync('.claude/settings.json', { includeHiddenFolders: ['.claude'] })).toBe(true);
		expect(sync('.git/HEAD', { includeHiddenFolders: ['.claude'] })).toBe(false);
	});

	it('leaves normal paths, root dot files and the config dir to the regular rules', () => {
		expect(sync('notes/a.md')).toBe(true);
		expect(sync('.syncIgnore')).toBe(true);
		expect(sync('.obsidian/app.json')).toBe(true);
		expect(sync('.obsidian/workspace.json', { includeHiddenFolders: ['.claude'] })).toBe(false);
	});

	it('never syncs .obsidian paths inside an included folder past the own-plugin exclusion', () => {
		const filter = { includeHiddenFolders: ['.claude'] };
		expect(sync('.claude/.obsidian/app.json', filter)).toBe(true);
		expect(sync('.obsidian/plugins/onedrive-sync/data.json', filter)).toBe(false);
	});

	it('excludes win over includes and over normal vault paths (both directions)', () => {
		expect(sync('PDFs/big.pdf', { excludeFolders: ['PDFs'] })).toBe(false);
		expect(sync('PDFsX/big.pdf', { excludeFolders: ['PDFs'] })).toBe(true);
		expect(
			sync('.claude/cache/x', { includeHiddenFolders: ['.claude'], excludeFolders: ['.claude/cache'] })
		).toBe(false);
	});

	it('identifies hidden top-level folders', () => {
		expect(isInHiddenTopLevelFolder('.claude/a')).toBe(true);
		expect(isInHiddenTopLevelFolder('.syncIgnore')).toBe(false);
		expect(isInHiddenTopLevelFolder('notes/.hidden/a')).toBe(false);
	});
});

describe('device scope helpers', () => {
	it('never syncs this plugin\'s folder inside an included folder (another config layout)', () => {
		const filter = { includeHiddenFolders: ['.obsidian'] };
		const sync = (p: string) => shouldSyncVaultPath(p, true, true, '.config', true, true, true, filter);
		expect(sync('.obsidian/app.json')).toBe(true);
		expect(sync('.obsidian/plugins/onedrive-sync/data.json')).toBe(false);
		expect(sync('.obsidian/plugins/obsidian-onedrive/data.json')).toBe(false);
	});

	it('judges files and folders against the filter', () => {
		const filter = { includeHiddenFolders: ['.claude'], excludeFolders: ['PDFs'] };
		expect(isOutOfDeviceScope('.git/HEAD', '.obsidian', filter)).toBe(true);
		expect(isOutOfDeviceScope('.git', '.obsidian', filter, true)).toBe(true);
		expect(isOutOfDeviceScope('.claude', '.obsidian', filter, true)).toBe(false);
		expect(isOutOfDeviceScope('PDFs', '.obsidian', filter, true)).toBe(true);
		expect(isOutOfDeviceScope('PDFs/a.pdf', '.obsidian', filter)).toBe(true);
		expect(isOutOfDeviceScope('notes/a.md', '.obsidian', filter)).toBe(false);
		expect(isOutOfDeviceScope('.obsidian/app.json', '.obsidian', filter)).toBe(false);
	});

	it('lists folders entering scope: new includes and dropped excludes', () => {
		expect(getFoldersEnteringScope(undefined, {})).toEqual([]);
		expect(getFoldersEnteringScope(undefined, { includeHiddenFolders: ['.claude'] })).toEqual(['.claude']);
		expect(
			getFoldersEnteringScope(
				{ includeHiddenFolders: ['.claude'], excludeFolders: ['PDFs', 'Big'] },
				{ includeHiddenFolders: ['.claude', '.cursor'], excludeFolders: ['Big'] }
			)
		).toEqual(['.cursor', 'PDFs']);
		expect(getFoldersEnteringScope({ includeHiddenFolders: ['.claude'] }, {})).toEqual([]);
	});
});
