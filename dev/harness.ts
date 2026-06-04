// Force shim side-effects to run
import '../dev/obsidian-shim';
import { OneDriveSettingTab } from '../src/ui/settings';

const mockPlugin = {
	manifest: { version: '0.1.2' },
	settings: {
		connectedUser: { displayName: 'Jeff Steinbok', userPrincipalName: 'jeffsteinbok@outlook.com' },
		accessMode: 'full-access',
		remotePath: '/Documents/ObsidianVaults/JeffBrain',
		syncInterval: 5,
		startupSyncDelay: 10,
		conflictResolution: 'last-write-wins',
		enableDebugLogging: false,
		useCustomClientId: false,
		customClientId: '',
		syncAppSettings: false,
		syncPluginManifests: false,
	},
	async saveSettings() { console.log('Settings saved:', JSON.stringify(this.settings, null, 2)); },
	async authenticate() { console.log('Authenticate called'); },
	disconnect() {
		this.settings.connectedUser = null;
		console.log('Disconnect called');
		render();
	},
	async triggerManualSync() { console.log('Manual sync triggered'); },
	async onAppSettingsSyncChanged(enabled: boolean) { console.log('App settings sync changed:', enabled); },
	async onPluginManifestSyncChanged(enabled: boolean) { console.log('Plugin manifest sync changed:', enabled); },
	async resetSyncToken() { console.log('Sync token reset'); },
};

function render() {
	const tab = new OneDriveSettingTab({} as any, mockPlugin as any);
	tab.containerEl = document.getElementById('settings-root')!;
	tab.containerEl.empty();
	tab.display();
}

render();
