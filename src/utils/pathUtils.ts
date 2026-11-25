/**
 * Path manipulation utilities for cross-platform compatibility
 */

/**
 * Normalize path separators to forward slashes
 */
export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/');
}

/**
 * Join path segments with forward slashes
 */
export function joinPath(...segments: string[]): string {
	return segments
		.map((segment) => segment.replace(/^\/+|\/+$/g, '')) // Remove leading/trailing slashes
		.filter((segment) => segment.length > 0)
		.join('/');
}

/**
 * Get parent directory path
 */
export function getParentPath(path: string): string {
	const normalized = normalizePath(path);
	const lastSlash = normalized.lastIndexOf('/');
	return lastSlash > 0 ? normalized.substring(0, lastSlash) : '';
}

/**
 * Get filename from path
 */
export function getFileName(path: string): string {
	const normalized = normalizePath(path);
	const lastSlash = normalized.lastIndexOf('/');
	return lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
}

/**
 * Get file extension (including dot)
 */
export function getFileExtension(path: string): string {
	const fileName = getFileName(path);
	const lastDot = fileName.lastIndexOf('.');
	return lastDot >= 0 ? fileName.substring(lastDot) : '';
}

/**
 * Get filename without extension
 */
export function getFileNameWithoutExtension(path: string): string {
	const fileName = getFileName(path);
	const lastDot = fileName.lastIndexOf('.');
	return lastDot >= 0 ? fileName.substring(0, lastDot) : fileName;
}

/**
 * Check if path is absolute
 */
export function isAbsolutePath(path: string): boolean {
	return path.startsWith('/') || /^[a-zA-Z]:/.test(path); // Unix or Windows
}

/**
 * Sanitize filename to remove invalid characters
 */
export function sanitizeFileName(name: string): string {
	// Remove or replace characters that are invalid in Windows/OneDrive filenames
	// eslint-disable-next-line no-control-regex -- Matching control characters that are invalid in Windows/OneDrive filenames
	const invalidChars = /[<>:"|?*\x00-\x1F]/g;
	const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

	let sanitized = name.replace(invalidChars, '_');

	// Handle reserved names
	if (reserved.test(sanitized)) {
		sanitized = `_${sanitized}`;
	}

	// Remove leading/trailing dots and spaces (invalid in OneDrive)
	sanitized = sanitized.replace(/^[.\s]+|[.\s]+$/g, '');

	// Ensure not empty
	return sanitized.length > 0 ? sanitized : 'unnamed';
}

/**
 * Encode a file path for use in Microsoft Graph API URLs.
 * Encodes each segment individually so slashes are preserved.
 */
export function encodePathForGraph(path: string): string {
	return path
		.split('/')
		.filter((s) => s.length > 0)
		.map((segment) => encodeURIComponent(segment))
		.join('/');
}

/**
 * Convert vault path to OneDrive path
 */
export function toOneDrivePath(vaultPath: string, remoteRoot: string): string {
	const normalized = normalizePath(vaultPath);
	if (!remoteRoot) {
		return normalized;
	}
	// Normalize remote root and ensure leading slash
	const normalizedRoot = normalizePath(remoteRoot);
	const rootWithSlash = normalizedRoot.startsWith('/') ? normalizedRoot : `/${normalizedRoot}`;
	// Manually join to preserve leading slash
	return `${rootWithSlash}/${normalized}`;
}

/**
 * Convert OneDrive path to vault path
 */
export function toVaultPath(oneDrivePath: string, remoteRoot: string): string {
	const normalized = normalizePath(oneDrivePath);
	const rootNormalized = normalizePath(remoteRoot);

	if (normalized.startsWith(rootNormalized)) {
		const relativePath = normalized.substring(rootNormalized.length);
		return relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
	}

	return normalized;
}

/**
 * Strip Microsoft Graph API prefixes from a path.
 * Handles /drive/root:, /drive/special/approot:, and /drives/{driveId}/root: prefixes.
 */
export function stripGraphPrefix(path: string): string {
	let result = path;
	result = result.replace(/^\/drives\/[^/]+\/root:/, '');
	result = result.replace(/^\/drive\/root:/, '');
	result = result.replace(/^\/drive\/special\/approot:/, '');
	return result;
}

const LOG_NOTE_FOLDER = '_OneDriveSyncLogs/';

function normalizeConfigDir(configDir: string): string {
	const normalized = normalizePath(configDir).replace(/\/+$/g, '');
	return normalized;
}

function buildConfigPath(configDir: string, ...segments: string[]): string {
	return joinPath(normalizeConfigDir(configDir), ...segments);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSyncableObsidianAppSettings(configDir: string): Set<string> {
	return new Set([
		buildConfigPath(configDir, 'app.json'),
		buildConfigPath(configDir, 'appearance.json'),
		buildConfigPath(configDir, 'hotkeys.json'),
	]);
}

function getSyncableObsidianBookmarks(configDir: string): Set<string> {
	return new Set([buildConfigPath(configDir, 'bookmarks.json')]);
}

function getSyncableObsidianPluginManifests(configDir: string): Set<string> {
	return new Set([
		buildConfigPath(configDir, 'community-plugins.json'),
		buildConfigPath(configDir, 'core-plugins.json'),
	]);
}

/**
 * Return all fixed (non-dynamic) config file paths that may be synced,
 * depending on the current settings. Used by config-file polling to
 * detect local changes to `.obsidian/` files that Obsidian's vault
 * events don't fire for.
 */
export function getFixedSyncableConfigPaths(
	configDir: string,
	syncPluginManifests: boolean,
	syncAppSettings: boolean,
	syncBookmarks = false
): string[] {
	const paths: string[] = [];
	if (syncAppSettings) {
		for (const p of getSyncableObsidianAppSettings(configDir)) {
			paths.push(p);
		}
	}
	if (syncPluginManifests) {
		for (const p of getSyncableObsidianPluginManifests(configDir)) {
			paths.push(p);
		}
	}
	if (syncBookmarks) {
		for (const p of getSyncableObsidianBookmarks(configDir)) {
			paths.push(p);
		}
	}
	return paths;
}

/**
 * Return the per-plugin syncable file paths (manifest.json, main.js,
 * styles.css) for all plugins found inside `<configDir>/plugins/`.
 * Requires the vault adapter to list directories.
 */
export async function getInstalledPluginSyncPaths(
	configDir: string,
	adapter: { list(path: string): Promise<{ folders: string[] }> },
	includePluginData = false
): Promise<string[]> {
	const pluginsDir = buildConfigPath(configDir, 'plugins');
	const paths: string[] = [];
	try {
		const listing = await adapter.list(pluginsDir);
		for (const folder of listing.folders) {
			const folderName = folder.split('/').pop() || '';
			if (!folderName) continue;
			paths.push(buildConfigPath(configDir, 'plugins', folderName, 'manifest.json'));
			paths.push(buildConfigPath(configDir, 'plugins', folderName, 'main.js'));
			paths.push(buildConfigPath(configDir, 'plugins', folderName, 'styles.css'));
			if (includePluginData) {
				paths.push(buildConfigPath(configDir, 'plugins', folderName, 'data.json'));
			}
		}
	} catch {
		// plugins folder may not exist
	}
	return paths;
}

/**
 * Return the CSS snippet file paths for all snippets found inside
 * `<configDir>/snippets/`.
 * Requires the vault adapter to list files.
 */
export async function getInstalledSnippetSyncPaths(
	configDir: string,
	adapter: { list(path: string): Promise<{ files: string[] }> }
): Promise<string[]> {
	const snippetsDir = buildConfigPath(configDir, 'snippets');
	const paths: string[] = [];
	try {
		const listing = await adapter.list(snippetsDir);
		for (const file of listing.files) {
			if (file.endsWith('.css')) {
				paths.push(file);
			}
		}
	} catch {
		// snippets folder may not exist
	}
	return paths;
}

/**
 * Get all syncable config paths (fixed + installed plugins + snippets).
 * Combines getFixedSyncableConfigPaths, getInstalledPluginSyncPaths,
 * and getInstalledSnippetSyncPaths into a single call for convenience.
 *
 * @param configDir - The vault's config directory (e.g., '.obsidian')
 * @param adapter - Vault adapter for listing plugin directories and snippet files
 * @param shouldSyncPath - Function to check if a path should be synced
 * @returns Array of all syncable config file paths
 */
export async function getAllSyncableConfigPaths(
	configDir: string,
	adapter: { list(path: string): Promise<{ folders: string[]; files: string[] }> },
	shouldSyncPath: (path: string) => boolean,
	additionalSyncFolders: readonly string[] = []
): Promise<string[]> {
	const syncPlugins = shouldSyncPath(`${configDir}/community-plugins.json`);
	const syncPluginData = shouldSyncPath(`${configDir}/plugins/example-plugin/data.json`);
	const syncAppSettings = shouldSyncPath(`${configDir}/app.json`);
	const syncSnippets = shouldSyncPath(`${configDir}/snippets`);
	const syncBookmarks = shouldSyncPath(`${configDir}/bookmarks.json`);

	const fixedPaths = getFixedSyncableConfigPaths(configDir, syncPlugins, syncAppSettings, syncBookmarks);
	const pluginPaths = syncPlugins
		? await getInstalledPluginSyncPaths(configDir, adapter, syncPluginData)
		: [];
	const snippetPaths = syncSnippets
		? await getInstalledSnippetSyncPaths(configDir, adapter)
		: [];

	const additionalPaths = (await getAdditionalFolderSyncPaths(additionalSyncFolders, adapter)).filter(
		(p) => shouldSyncPath(p)
	);

	return [...fixedPaths, ...pluginPaths, ...snippetPaths, ...additionalPaths];
}

function isInstalledPluginManifestPath(path: string, configDir: string): boolean {
	const normalizedConfigDir = escapeRegExp(normalizeConfigDir(configDir));
	return new RegExp(`^${normalizedConfigDir}/plugins/[^/]+/manifest\\.json$`).test(path);
}

function isInstalledPluginBinaryPath(path: string, configDir: string): boolean {
	const normalizedConfigDir = escapeRegExp(normalizeConfigDir(configDir));
	return new RegExp(`^${normalizedConfigDir}/plugins/[^/]+/(main\\.js|styles\\.css)$`).test(path);
}

function isInstalledPluginDataPath(path: string, configDir: string): boolean {
	const normalizedConfigDir = escapeRegExp(normalizeConfigDir(configDir));
	return new RegExp(`^${normalizedConfigDir}/plugins/[^/]+/data\\.json$`).test(path);
}

function isCssSnippetPath(path: string, configDir: string): boolean {
	const normalizedConfigDir = escapeRegExp(normalizeConfigDir(configDir));
	// Match the snippets folder itself or any .css file directly inside it (no subdirectories)
	return new RegExp(`^${normalizedConfigDir}/snippets(/[^/]+\\.css)?$`).test(path);
}

function getWorkspaceStatePattern(configDir: string): RegExp {
	const normalizedConfigDir = escapeRegExp(normalizeConfigDir(configDir));
	return new RegExp(`^${normalizedConfigDir}/workspace(-[^/]+)?\\.json$`);
}

/**
 * Per-device sync filter. It lives in this plugin's own data.json, which is
 * never synced, so each device keeps its own. `shouldSyncVaultPath` applies it
 * to both directions: a path the filter rejects is neither uploaded from this
 * device nor downloaded to it, and dropping a path from scope never turns into
 * a remote delete.
 */
export interface DeviceSyncFilter {
	/**
	 * Hidden top-level folders (first segment starts with `.`, e.g. `.claude`)
	 * that this device syncs. Every other hidden top-level folder (except the
	 * config dir, which has its own settings) is out of scope on this device.
	 * Expected to be already normalized (see `validateAdditionalSyncFolders`).
	 */
	includeHiddenFolders?: readonly string[];
	/**
	 * Vault folders this device never syncs, in either direction. Wins over
	 * every include. Expected to be normalized folder paths without slashes at
	 * either end.
	 */
	excludeFolders?: readonly string[];
}

const OWN_PLUGIN_FOLDER_ANYWHERE = /(^|\/)plugins\/(onedrive-sync|obsidian-onedrive)(\/|$)/;

export type AdditionalSyncFolderRejection = 'not-hidden' | 'config-dir' | 'invalid';

export interface AdditionalSyncFolderValidation {
	folders: string[];
	rejected: Array<{ folder: string; reason: AdditionalSyncFolderRejection }>;
}

function isHiddenSegment(segment: string): boolean {
	return segment.startsWith('.') && segment !== '.' && segment !== '..';
}

/**
 * True for a path inside a hidden top-level folder (e.g. `.claude/x.md` or
 * `.trash/old.md`). Obsidian never indexes these, so they only sync when the
 * device opts in. Root-level dot files such as `.syncIgnore` are not folders
 * and are not affected.
 */
export function isInHiddenTopLevelFolder(path: string): boolean {
	const normalized = normalizePath(path);
	const slash = normalized.indexOf('/');
	if (slash <= 0) return false;
	return isHiddenSegment(normalized.slice(0, slash));
}

/**
 * Normalize and validate the user-entered list of additional folders to sync.
 * Only hidden top-level folders are accepted: normal folders are already
 * synced through the vault index, and listing one would make the engine track
 * the same files through two paths (a rename would then also emit a remote
 * delete of the old path). The config dir is rejected because it has its own
 * opt-in settings that must not be bypassed.
 */
export function validateAdditionalSyncFolders(
	folders: unknown,
	configDir: string
): AdditionalSyncFolderValidation {
	const result: AdditionalSyncFolderValidation = { folders: [], rejected: [] };
	if (!Array.isArray(folders)) return result;
	const normalizedConfigDir = normalizeConfigDir(configDir);
	for (const raw of folders as unknown[]) {
		if (typeof raw !== 'string') continue;
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const folder = normalizePath(trimmed).replace(/^(\.\/)+/, '').replace(/^\/+|\/+$/g, '');
		if (!folder || folder === '.' || folder.split('/').some((seg) => seg === '..' || seg === '.')) {
			result.rejected.push({ folder: trimmed, reason: 'invalid' });
			continue;
		}
		if (folder === normalizedConfigDir || folder.startsWith(`${normalizedConfigDir}/`)) {
			result.rejected.push({ folder, reason: 'config-dir' });
			continue;
		}
		if (!isHiddenSegment(folder.split('/')[0])) {
			result.rejected.push({ folder, reason: 'not-hidden' });
			continue;
		}
		if (!result.folders.includes(folder)) result.folders.push(folder);
	}
	return result;
}

/** Validate vault-relative folder prefixes before stripping trailing separators. */
export function validateExcludedSyncFolders(folders: unknown): AdditionalSyncFolderValidation {
	const result: AdditionalSyncFolderValidation = { folders: [], rejected: [] };
	if (!Array.isArray(folders)) return result;
	for (const raw of folders as unknown[]) {
		if (typeof raw !== 'string') continue;
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const path = normalizePath(trimmed);
		const segments = path.split('/').filter(Boolean);
		if (/^(?:\/|[a-z]:)/i.test(path) || segments.some((segment) => segment === '.' || segment === '..')) {
			result.rejected.push({ folder: trimmed, reason: 'invalid' });
			continue;
		}
		const folder = segments.join('/');
		if (!result.folders.includes(folder)) result.folders.push(folder);
	}
	return result;
}

/**
 * Normalize the stored list of additional sync folders, silently dropping
 * entries `validateAdditionalSyncFolders` would reject.
 */
export function normalizeAdditionalSyncFolders(folders: unknown, configDir: string): string[] {
	return validateAdditionalSyncFolders(folders, configDir).folders;
}

/**
 * True if the path is one of the given (already normalized) folders or lives
 * inside one.
 */
export function isInAdditionalSyncFolder(path: string, folders: readonly string[]): boolean {
	return isInAnyFolder(normalizePath(path), folders);
}

function isInAnyFolder(normalizedPath: string, folders: readonly string[] | undefined): boolean {
	if (!folders) return false;
	for (const folder of folders) {
		if (normalizedPath === folder || normalizedPath.startsWith(`${folder}/`)) return true;
	}
	return false;
}

/**
 * Apply the per-device filter. Returns false when the device filter keeps
 * the path out of scope, true when it explicitly opts the path in, and
 * undefined when the filter has no opinion (the regular rules decide).
 */
function applyDeviceSyncFilter(
	normalizedPath: string,
	normalizedConfigDir: string,
	filter: DeviceSyncFilter
): boolean | undefined {
	if (isInAnyFolder(normalizedPath, filter.excludeFolders)) return false;
	if (isInAnyFolder(normalizedPath, filter.includeHiddenFolders)) {
		// An included folder may hold another device's config layout
		// (e.g. `.obsidian` when this vault uses a custom config dir). This
		// plugin's own folder holds auth tokens and must never sync.
		return !OWN_PLUGIN_FOLDER_ANYWHERE.test(normalizedPath);
	}
	if (
		isInHiddenTopLevelFolder(normalizedPath) &&
		normalizedPath !== normalizedConfigDir &&
		!normalizedPath.startsWith(`${normalizedConfigDir}/`)
	) {
		return false;
	}
	return undefined;
}

/**
 * True when the per-device filter keeps `path` out of scope on this device.
 * Pass `isFolder` for a folder path, so the folder itself (e.g. `.claude`)
 * is judged like the files inside it.
 */
export function isOutOfDeviceScope(
	path: string,
	configDir: string,
	filter: DeviceSyncFilter,
	isFolder = false
): boolean {
	const normalized = normalizePath(path).replace(/\/+$/, '');
	const probe = isFolder ? `${normalized}/_` : normalized;
	return applyDeviceSyncFilter(probe, normalizeConfigDir(configDir), filter) === false;
}

/**
 * Folders that came into scope between two filters: newly included hidden
 * folders, and folders no longer excluded. An undefined `previous` (no scope
 * recorded yet) counts as the empty filter.
 */
export function getFoldersEnteringScope(
	previous: DeviceSyncFilter | undefined,
	next: DeviceSyncFilter
): string[] {
	const prevInclude = new Set(previous?.includeHiddenFolders ?? []);
	const nextExclude = new Set(next.excludeFolders ?? []);
	return [
		...(next.includeHiddenFolders ?? []).filter((f) => !prevInclude.has(f)),
		...(previous?.excludeFolders ?? []).filter((f) => !nextExclude.has(f)),
	];
}

/**
 * Recursively list every file inside the additional sync folders. Hidden
 * folders are not indexed by the vault, so the adapter must be used.
 */
export async function getAdditionalFolderSyncPaths(
	folders: readonly string[],
	adapter: { list(path: string): Promise<{ folders: string[]; files: string[] }> }
): Promise<string[]> {
	const paths: string[] = [];
	const visit = async (dir: string): Promise<void> => {
		let listing: { folders: string[]; files: string[] };
		try {
			listing = await adapter.list(dir);
		} catch {
			return; // folder may not exist locally
		}
		for (const file of listing.files) paths.push(normalizePath(file));
		for (const sub of listing.folders) await visit(normalizePath(sub));
	};
	for (const folder of folders) {
		await visit(folder);
	}
	return paths;
}

/**
 * Check whether a vault path should be synced.
 */
export function shouldSyncVaultPath(
	path: string,
	syncPluginManifests = false,
	syncAppSettings = false,
	configDir: string,
	syncCssSnippets = false,
	syncBookmarks = false,
	syncPluginData = false,
	deviceFilter: DeviceSyncFilter = {}
): boolean {
	const normalized = normalizePath(path);
	const normalizedConfigDir = normalizeConfigDir(configDir);
	const configDirPrefix = `${normalizedConfigDir}/`;
	const syncableObsidianAppSettings = getSyncableObsidianAppSettings(normalizedConfigDir);
	const syncableObsidianPluginManifests = getSyncableObsidianPluginManifests(normalizedConfigDir);
	const syncableObsidianBookmarks = getSyncableObsidianBookmarks(normalizedConfigDir);
	const ownPluginFolder = buildConfigPath(normalizedConfigDir, 'plugins', 'onedrive-sync');
	// Exclude the old plugin folder too, so upgrades don't sync stale auth/state
	const oldPluginFolder = buildConfigPath(normalizedConfigDir, 'plugins', 'obsidian-onedrive');

	// Plugin debug log notes live in a dedicated folder so each device keeps its
	// own. The leading underscore is on the folder, so users who want to share a
	// specific day's log can simply move that file out of the folder.
	if (normalized === LOG_NOTE_FOLDER.slice(0, -1) || normalized.startsWith(LOG_NOTE_FOLDER)) {
		return false;
	}

	// Never sync the OneDrive plugin's own folder. Auth state in data.json must
	// stay device-local, and syncing main.js across devices would let an older
	// install on one device silently downgrade a newer install on another.
	if (normalized === ownPluginFolder || normalized.startsWith(`${ownPluginFolder}/`)) {
		return false;
	}

	// Also exclude the old plugin folder (pre-rename) so upgrades don't sync stale data
	if (normalized === oldPluginFolder || normalized.startsWith(`${oldPluginFolder}/`)) {
		return false;
	}

	// Never sync Obsidian's per-device workspace state.
	if (getWorkspaceStatePattern(normalizedConfigDir).test(normalized)) {
		return false;
	}

	// Per-device include/exclude. Applies to uploads and downloads alike.
	const deviceDecision = applyDeviceSyncFilter(normalized, normalizedConfigDir, deviceFilter);
	if (deviceDecision !== undefined) {
		return deviceDecision;
	}

	if (!normalized.startsWith(configDirPrefix)) {
		return true;
	}

	if (syncAppSettings && syncableObsidianAppSettings.has(normalized)) {
		return true;
	}

	if (syncBookmarks && syncableObsidianBookmarks.has(normalized)) {
		return true;
	}

	if (syncCssSnippets && isCssSnippetPath(normalized, normalizedConfigDir)) {
		return true;
	}

	if (!syncPluginManifests) {
		return false;
	}

	if (syncPluginData && isInstalledPluginDataPath(normalized, normalizedConfigDir)) {
		return true;
	}

	return (
		syncableObsidianPluginManifests.has(normalized) ||
		isInstalledPluginManifestPath(normalized, normalizedConfigDir) ||
		isInstalledPluginBinaryPath(normalized, normalizedConfigDir)
	);
}

/**
 * Check if path is within root directory
 */
export function isPathWithinRoot(path: string, root: string): boolean {
	const normalizedPath = normalizePath(path);
	const normalizedRoot = normalizePath(root);
	return normalizedPath.startsWith(normalizedRoot);
}

/**
 * Create conflict filename with timestamp
 * Example: "note.md" -> "note (conflict 2026-05-25 12-30-45).md"
 */
export function createConflictFileName(originalPath: string): string {
	const nameWithoutExt = getFileNameWithoutExtension(originalPath);
	const ext = getFileExtension(originalPath);
	const now = new Date();
	const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;

	return `${nameWithoutExt} (conflict ${timestamp})${ext}`;
}

/**
 * True if a path looks like a conflict copy produced by
 * {@link createConflictFileName}.
 *
 * The bracketed part is matched loosely rather than against the current
 * timestamp format: earlier builds stamped date-only copies, and those still
 * exist in long-lived vaults.
 */
export function isConflictCopyPath(path: string): boolean {
	return / \(conflict [^)]*\)$/.test(getFileNameWithoutExtension(path));
}

/**
 * Known text file extensions (for diff display in conflict resolution)
 */
const TEXT_EXTENSIONS = new Set([
	'.md',
	'.txt',
	'.markdown',
	'.mdown',
	'.mkd',
	'.mkdn',
	'.json',
	'.yaml',
	'.yml',
	'.toml',
	'.xml',
	'.html',
	'.htm',
	'.css',
	'.js',
	'.ts',
	'.jsx',
	'.tsx',
	'.mjs',
	'.cjs',
	'.py',
	'.rb',
	'.java',
	'.c',
	'.cpp',
	'.h',
	'.hpp',
	'.sh',
	'.bash',
	'.zsh',
	'.bat',
	'.ps1',
	'.csv',
	'.tsv',
	'.log',
	'.ini',
	'.cfg',
	'.conf',
	'.tex',
	'.latex',
	'.bib',
	'.org',
	'.rst',
	'.adoc',
	'.svg',
	'.graphql',
	'.sql',
	'.r',
	'.lua',
	'.go',
]);

/**
 * Check if a file path has a known text extension
 */
export function isTextExtension(path: string): boolean {
	const ext = getFileExtension(path).toLowerCase();
	return TEXT_EXTENSIONS.has(ext);
}
