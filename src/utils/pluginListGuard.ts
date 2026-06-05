/**
 * Community plugins list self-heal utilities.
 */

import { logger } from './logger';

export const COMMUNITY_PLUGINS_LIST_PATH = '.obsidian/community-plugins.json';

export interface CommunityPluginsAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
}

export async function ensureSelfInCommunityPluginsList(
	adapter: CommunityPluginsAdapter,
	pluginId: string,
	log: Pick<typeof logger, 'warn' | 'info'> = logger
): Promise<void> {
	if (!pluginId) {
		return;
	}

	try {
		let list: string[] = [];
		if (await adapter.exists(COMMUNITY_PLUGINS_LIST_PATH)) {
			const raw = await adapter.read(COMMUNITY_PLUGINS_LIST_PATH);
			try {
				const parsed = JSON.parse(raw);
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
		await adapter.write(COMMUNITY_PLUGINS_LIST_PATH, JSON.stringify(list, null, 2));
		log.info(`Self-healed: added ${pluginId} back to community-plugins.json`);
	} catch (error) {
		log.warn('Failed to self-heal community-plugins.json:', error);
	}
}
