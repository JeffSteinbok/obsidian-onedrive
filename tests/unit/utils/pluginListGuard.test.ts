/**
 * Unit tests for plugin list guard utilities
 */

import { describe, it, expect, vi } from 'vitest';
import {
	getCommunityPluginsListPath,
	ensureSelfInCommunityPluginsList,
} from '../../../src/utils/pluginListGuard';

describe('pluginListGuard', () => {
	it('creates the community plugin list when missing', async () => {
		const adapter = {
			exists: vi.fn().mockResolvedValue(false),
			read: vi.fn(),
			write: vi.fn().mockResolvedValue(undefined),
		};
		const log = {
			warn: vi.fn(),
			info: vi.fn(),
		};

		await ensureSelfInCommunityPluginsList(adapter, 'onedrive-sync', '.obsidian', log);

		expect(adapter.write).toHaveBeenCalledWith(
			getCommunityPluginsListPath(),
			JSON.stringify(['onedrive-sync'], null, 2)
		);
		expect(log.info).toHaveBeenCalledWith(
			'Self-healed: added onedrive-sync back to community-plugins.json'
		);
	});

	it('does nothing when the plugin is already listed', async () => {
		const adapter = {
			exists: vi.fn().mockResolvedValue(true),
			read: vi.fn().mockResolvedValue(JSON.stringify(['onedrive-sync'])),
			write: vi.fn(),
		};
		const log = {
			warn: vi.fn(),
			info: vi.fn(),
		};

		await ensureSelfInCommunityPluginsList(adapter, 'onedrive-sync', '.obsidian', log);

		expect(adapter.write).not.toHaveBeenCalled();
		expect(log.info).not.toHaveBeenCalled();
	});

	it('filters non-string entries before appending the plugin id', async () => {
		const adapter = {
			exists: vi.fn().mockResolvedValue(true),
			read: vi.fn().mockResolvedValue(JSON.stringify(['calendar', 123, null])),
			write: vi.fn().mockResolvedValue(undefined),
		};
		const log = {
			warn: vi.fn(),
			info: vi.fn(),
		};

		await ensureSelfInCommunityPluginsList(adapter, 'onedrive-sync', '.obsidian', log);

		expect(adapter.write).toHaveBeenCalledWith(
			getCommunityPluginsListPath(),
			JSON.stringify(['calendar', 'onedrive-sync'], null, 2)
		);
	});

	it('rewrites malformed json with only the current plugin id', async () => {
		const adapter = {
			exists: vi.fn().mockResolvedValue(true),
			read: vi.fn().mockResolvedValue('{not json'),
			write: vi.fn().mockResolvedValue(undefined),
		};
		const log = {
			warn: vi.fn(),
			info: vi.fn(),
		};

		await ensureSelfInCommunityPluginsList(adapter, 'onedrive-sync', '.obsidian', log);

		expect(log.warn).toHaveBeenCalledWith(
			'community-plugins.json is malformed; rewriting with just onedrive-sync'
		);
		expect(adapter.write).toHaveBeenCalledWith(
			getCommunityPluginsListPath(),
			JSON.stringify(['onedrive-sync'], null, 2)
		);
	});

	it('logs and swallows adapter errors', async () => {
		const error = new Error('disk full');
		const adapter = {
			exists: vi.fn().mockRejectedValue(error),
			read: vi.fn(),
			write: vi.fn(),
		};
		const log = {
			warn: vi.fn(),
			info: vi.fn(),
		};

		await ensureSelfInCommunityPluginsList(adapter, 'onedrive-sync', '.obsidian', log);

		expect(log.warn).toHaveBeenCalledWith('Failed to self-heal community-plugins.json:', error);
	});
});
