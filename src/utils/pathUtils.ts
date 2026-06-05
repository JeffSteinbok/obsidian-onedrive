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

function getSyncableObsidianPluginManifests(configDir: string): Set<string> {
	return new Set([
		buildConfigPath(configDir, 'community-plugins.json'),
		buildConfigPath(configDir, 'core-plugins.json'),
	]);
}

function isInstalledPluginManifestPath(path: string, configDir: string): boolean {
	const normalizedConfigDir = escapeRegExp(normalizeConfigDir(configDir));
	return new RegExp(`^${normalizedConfigDir}/plugins/[^/]+/manifest\\.json$`).test(path);
}

function isInstalledPluginBinaryPath(path: string, configDir: string): boolean {
	const normalizedConfigDir = escapeRegExp(normalizeConfigDir(configDir));
	return new RegExp(`^${normalizedConfigDir}/plugins/[^/]+/(main\\.js|styles\\.css)$`).test(path);
}

function getWorkspaceStatePattern(configDir: string): RegExp {
	const normalizedConfigDir = escapeRegExp(normalizeConfigDir(configDir));
	return new RegExp(`^${normalizedConfigDir}/workspace(-[^/]+)?\\.json$`);
}

/**
 * Check whether a vault path should be synced.
 */
export function shouldSyncVaultPath(
	path: string,
	syncPluginManifests = false,
	syncAppSettings = false,
	configDir: string
): boolean {
	const normalized = normalizePath(path);
	const normalizedConfigDir = normalizeConfigDir(configDir);
	const configDirPrefix = `${normalizedConfigDir}/`;
	const syncableObsidianAppSettings = getSyncableObsidianAppSettings(normalizedConfigDir);
	const syncableObsidianPluginManifests = getSyncableObsidianPluginManifests(normalizedConfigDir);
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

	if (!normalized.startsWith(configDirPrefix)) {
		return true;
	}

	if (syncAppSettings && syncableObsidianAppSettings.has(normalized)) {
		return true;
	}

	if (!syncPluginManifests) {
		return false;
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
