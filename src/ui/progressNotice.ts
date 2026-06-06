/**
 * Progress-bar Notice helper.
 *
 * Creates a persistent Obsidian Notice with an embedded progress bar
 * that can be updated in-place as operations complete. Falls back to
 * a plain text Notice when DOM APIs are unavailable (e.g. tests).
 */

import { Notice, ProgressBarComponent } from 'obsidian';

export class ProgressNotice {
	private notice: Notice;
	private textEl: HTMLElement | null = null;
	private progressBar: ProgressBarComponent | null = null;
	private total: number;

	constructor(label: string, total: number) {
		this.total = total;

		if (typeof activeDocument !== 'undefined') {
			const fragment = activeDocument.createDocumentFragment();

			this.textEl = fragment.createEl('div', {
				text: `${label}: 0/${total} files`,
				cls: 'onedrive-sync-progress-notice-text',
			});

			const barContainer = fragment.createEl('div', {
				cls: 'onedrive-sync-notice-bar-container',
			});
			this.progressBar = new ProgressBarComponent(barContainer);
			this.progressBar.setValue(0);

			this.notice = new Notice(fragment, 0);
		} else {
			this.notice = new Notice(`${label}: 0/${total} files...`, 0);
		}
	}

	update(completed: number, label: string): void {
		const pct = this.total > 0 ? Math.round((completed / this.total) * 100) : 0;
		if (this.textEl && this.progressBar) {
			this.textEl.setText(`${label}: ${completed}/${this.total} files`);
			this.progressBar.setValue(pct);
		} else {
			this.notice.setMessage(`${label}: ${completed}/${this.total} files...`);
		}
	}

	hide(): void {
		this.notice.hide();
	}
}
