/**
 * Test setup file for Vitest
 * Mocks Obsidian API and other dependencies
 */

import { vi, beforeEach } from 'vitest';

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
		},
		on: vi.fn(),
		off: vi.fn(),
		getAbstractFileByPath: vi.fn(),
		getFiles: vi.fn(),
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
}

// Global mocks
(global as typeof global & { requestUrl: typeof mockRequestUrl }).requestUrl = mockRequestUrl;
(global as typeof global & { Notice: typeof Notice }).Notice = Notice;

// Reset all mocks before each test
beforeEach(() => {
	vi.clearAllMocks();
	mockRequestUrl.mockReset();
});
