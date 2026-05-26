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
export class TFile {
	path: string = '';
	stat: { mtime: number; size: number; ctime: number } = { mtime: 0, size: 0, ctime: 0 };
	basename: string = '';
	extension: string = '';
	name: string = '';
}
export class TAbstractFile {
	path: string = '';
}
export type EventRef = unknown;

export function setIcon(_el: HTMLElement, _icon: string) {}
export function requestUrl(_options: unknown): Promise<unknown> {
	return Promise.resolve({});
}
export function normalizePath(path: string): string {
	return path;
}
