/**
 * Test setup file for Vitest
 * Mocks Obsidian API and other dependencies
 */

import { vi, beforeEach } from 'vitest';
import { TFile } from 'obsidian';

// Mock Obsidian API
export const mockApp = {
	vault: {
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
		getFiles: vi.fn(),
		readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
		delete: vi.fn().mockResolvedValue(undefined),
	},
	workspace: {
		on: vi.fn(),
	},
};

export const mockPlugin = {
	app: mockApp,
	manifest: {
		id: 'obsidian-onedrive',
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

// Global mocks
(global as typeof global & { requestUrl: typeof mockRequestUrl }).requestUrl = mockRequestUrl;
(global as typeof global & { Notice: typeof Notice }).Notice = Notice;

// Reset all mocks before each test
beforeEach(() => {
	vi.clearAllMocks();
	mockRequestUrl.mockReset();
});
