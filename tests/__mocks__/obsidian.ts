/**
 * Mock for Obsidian API
 */

export class App {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Notice {}
export class Modal {}
export class TFile {}
export class TAbstractFile {}
export type EventRef = unknown;

export function setIcon(_el: HTMLElement, _icon: string) {}
export function requestUrl(_options: unknown): Promise<unknown> {
	return Promise.resolve({});
}
