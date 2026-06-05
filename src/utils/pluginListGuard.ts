/**
 * Community plugins list self-heal utilities.
 */

import { logger } from './logger';
import { normalizePath } from './pathUtils';

export function getCommunityPluginsListPath(configDir: string): string {
	const normalizedConfigDir = normalizePath(configDir).replace(/\/+$/g, '');
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
	configDir: string,
	log: Pick<typeof logger, 'warn' | 'info'> = logger
): Promise<void> {
	if (!pluginId) {
		return;
	}

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
				log.warn(`community-plugins.json is malformed; rewriting with just ${pluginId}`);
			}
		}

		if (list.includes(pluginId)) {
			return;
		}

		list.push(pluginId);
		await adapter.write(communityPluginsListPath, JSON.stringify(list, null, 2));
		log.info(`Self-healed: added ${pluginId} back to community-plugins.json`);
	} catch (error) {
		log.warn('Failed to self-heal community-plugins.json:', error);
	}
}
