/**
 * Mock for Obsidian API
 */

export class App {}
export class Plugin {
	app: App = new App();
	loadData(): Promise<unknown> { return Promise.resolve({}); }
	saveData(_data: unknown): Promise<void> { return Promise.resolve(); }
	addRibbonIcon(_icon: string, _title: string, _callback: () => void) { return document.createElement('div'); }
	addCommand(_command: unknown) { return undefined as unknown; }
	addStatusBarItem() { return { setText: () => {}, empty: () => {}, createEl: () => document.createElement('div') }; }
	addSettingTab(_tab: unknown) {}
	registerView(_type: string, _viewCreator: unknown) {}
}
export class PluginSettingTab {}
export class Setting {}
export class Notice {
	message: string;
	constructor(message: string, _timeout?: number) {
		this.message = message;
	}
	setMessage(message: string) { this.message = message; }
	hide() {}
}
export class Modal {}
export class WorkspaceLeaf {}
export class ItemView {
	containerEl: HTMLElement = document.createElement('div');
	leaf: WorkspaceLeaf;
	constructor(leaf: WorkspaceLeaf) {
		this.leaf = leaf;
		// Create the two child divs that Obsidian ItemView expects
		this.containerEl.appendChild(document.createElement('div'));
		this.containerEl.appendChild(document.createElement('div'));
	}
	getViewType(): string { return ''; }
	getDisplayText(): string { return ''; }
	getIcon(): string { return ''; }
	async onOpen(): Promise<void> {}
	async onClose(): Promise<void> {}
}
export class TFile {
	path: string = '';
	stat: { mtime: number; size: number; ctime: number } = { mtime: 0, size: 0, ctime: 0 };
	basename: string = '';
	extension: string = '';
	name: string = '';
}
export class TFolder {
	path: string = '';
	name: string = '';
	children: Array<TFile | TFolder> = [];
}
export class TAbstractFile {
	path: string = '';
}
export type EventRef = unknown;

export function setIcon(_el: HTMLElement, _icon: string) {}
export function requestUrl(options: unknown): Promise<unknown> {
	const mockedRequestUrl = (globalThis as typeof globalThis & {
		requestUrl?: (requestOptions: unknown) => Promise<unknown>;
	}).requestUrl;
	return mockedRequestUrl ? mockedRequestUrl(options) : Promise.resolve({});
}
export function normalizePath(path: string): string {
	return path;
}
