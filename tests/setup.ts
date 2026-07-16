/**
 * Test setup file for Vitest
 * Mocks Obsidian API and other dependencies
 */

import { vi, beforeEach } from 'vitest';
import { TFile, TFolder } from 'obsidian';

// Mock Obsidian API
export const mockApp = {
	vault: {
		configDir: '.obsidian',
		adapter: {
			list: vi.fn(),
			read: vi.fn(),
			write: vi.fn(),
			remove: vi.fn(),
			exists: vi.fn(),
			stat: vi.fn(),
			writeBinary: vi.fn().mockResolvedValue(undefined),
			readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
			mkdir: vi.fn().mockResolvedValue(undefined),
			rmdir: vi.fn().mockResolvedValue(undefined),
			getBasePath: vi.fn().mockReturnValue('/mock/vault'),
		},
		on: vi.fn().mockReturnValue({ id: 'mock-event-ref' }),
		off: vi.fn(),
		offref: vi.fn(),
		getAbstractFileByPath: vi.fn(),
		getFiles: vi.fn().mockReturnValue([]),
		getRoot: vi.fn().mockReturnValue({ path: '', children: [] }),
		readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
		delete: vi.fn().mockResolvedValue(undefined),
	},
	fileManager: {
		trashFile: vi.fn().mockResolvedValue(undefined),
	},
	workspace: {
		on: vi.fn(),
		getLeavesOfType: vi.fn().mockReturnValue([]),
	},
};

export const mockPlugin = {
	app: mockApp,
	manifest: {
		id: 'onedrive-sync',
		name: 'OneDrive Sync',
		version: '0.1.0',
	},
	loadData: vi.fn().mockResolvedValue({}),
	saveData: vi.fn().mockResolvedValue(undefined),
	addRibbonIcon: vi.fn(),
	addStatusBarItem: vi.fn().mockReturnValue({
		setText: vi.fn(),
	}),
	addSettingTab: vi.fn(),
	registerEvent: vi.fn(),
	registerDomEvent: vi.fn(),
	registerObsidianProtocolHandler: vi.fn(),
};

// Mock requestUrl (Obsidian's HTTP client)
export const mockRequestUrl = vi.fn();

// Mock Notice
export class Notice {
	constructor(
		public message: string,
		public timeout?: number
	) {}
	setMessage(message: string) { this.message = message; }
	hide() {}
}

/**
 * Helper to create a mock TFile instance that passes instanceof checks
 */
export function makeTFile(path: string, size: number = 0, mtime: number = Date.now()): TFile {
	const file = new TFile();
	file.path = path;
	file.stat = { mtime, size, ctime: mtime };
	file.name = path.split('/').pop() || path;
	file.basename = file.name.replace(/\.[^.]+$/, '');
	file.extension = file.name.includes('.') ? file.name.split('.').pop() || '' : '';
	return file;
}

/**
 * Helper to create a mock TFolder instance that passes instanceof checks
 */
export function makeTFolder(path: string): TFolder {
	const folder = new TFolder();
	folder.path = path;
	folder.name = path.split('/').pop() || path;
	folder.children = [];
	return folder;
}

// Global mocks
(global as typeof global & { requestUrl: typeof mockRequestUrl }).requestUrl = mockRequestUrl;
(global as typeof global & { Notice: typeof Notice }).Notice = Notice;

// Provide window with timer methods for timerApi.ts (Obsidian always has window)
if (typeof window === 'undefined') {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
	(global as any).window = {
		setTimeout: globalThis.setTimeout.bind(globalThis),
		clearTimeout: globalThis.clearTimeout.bind(globalThis),
		setInterval: globalThis.setInterval.bind(globalThis),
		clearInterval: globalThis.clearInterval.bind(globalThis),
		console: globalThis.console,
	};
}

// Reset all mocks before each test
beforeEach(() => {
	vi.clearAllMocks();
	mockRequestUrl.mockReset();
});
