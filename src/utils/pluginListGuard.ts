/**
 * Community plugins list self-heal utilities.
 */

import { logger } from './logger';
import { normalizePath } from './pathUtils';

export function getCommunityPluginsListPath(configDir = '.obsidian'): string {
	const normalizedConfigDir = normalizePath(configDir).replace(/\/+$/g, '') || '.obsidian';
	return `${normalizedConfigDir}/community-plugins.json`;
}

export interface CommunityPluginsAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
}

export async function ensureSelfInCommunityPluginsList(
	adapter: CommunityPluginsAdapter,
	pluginId: string,
	configDirOrLog: string | Pick<typeof logger, 'warn' | 'info'> = '.obsidian',
	log: Pick<typeof logger, 'warn' | 'info'> = logger
): Promise<void> {
	if (!pluginId) {
		return;
	}

	const configDir = typeof configDirOrLog === 'string' ? configDirOrLog : '.obsidian';
	const effectiveLog = typeof configDirOrLog === 'string' ? log : configDirOrLog;
	const communityPluginsListPath = getCommunityPluginsListPath(configDir);

	try {
		let list: string[] = [];
		if (await adapter.exists(communityPluginsListPath)) {
			const raw = await adapter.read(communityPluginsListPath);
			try {
				const parsed = JSON.parse(raw) as unknown;
				if (Array.isArray(parsed)) {
					list = parsed.filter((item): item is string => typeof item === 'string');
				}
			} catch {
				effectiveLog.warn(`community-plugins.json is malformed; rewriting with just ${pluginId}`);
			}
		}

		if (list.includes(pluginId)) {
			return;
		}

		list.push(pluginId);
		await adapter.write(communityPluginsListPath, JSON.stringify(list, null, 2));
		effectiveLog.info(`Self-healed: added ${pluginId} back to community-plugins.json`);
	} catch (error) {
		effectiveLog.warn('Failed to self-heal community-plugins.json:', error);
	}
}
