/**
 * Progress-bar Notice helper.
 *
 * Creates a persistent Obsidian Notice with an embedded progress bar
 * that can be updated in-place as operations complete. Falls back to
 * a plain text Notice when DOM APIs are unavailable (e.g. tests).
 */

import { Notice, ProgressBarComponent } from 'obsidian';

import { t } from '../i18n';

export class ProgressNotice {
	private notice: Notice;
	private textEl: HTMLElement | null = null;
	private progressBar: ProgressBarComponent | null = null;
	private total: number;

	constructor(label: string, total: number) {
		this.total = total;

		if (typeof activeDocument !== 'undefined') {
			const fragment = createFragment();

			this.textEl = fragment.createDiv({
				text: t('progress.notice', {
					label,
					progress: t('progress.files', { completed: 0, total }),
				}),
				cls: 'onedrive-sync-progress-notice-text',
			});

			const barContainer = fragment.createDiv({
				cls: 'onedrive-sync-notice-bar-container',
			});
			this.progressBar = new ProgressBarComponent(barContainer);
			this.progressBar.setValue(0);

			this.notice = new Notice(fragment, 0);
		} else {
			this.notice = new Notice(
				t('progress.noticeWithEllipsis', {
					label,
					progress: t('progress.files', { completed: 0, total }),
				}),
				0
			);
		}
	}

	update(completed: number, label: string): void {
		const pct = this.total > 0 ? Math.round((completed / this.total) * 100) : 0;
		const progress = t('progress.files', { completed, total: this.total });
		if (this.textEl && this.progressBar) {
			this.textEl.setText(t('progress.notice', { label, progress }));
			this.progressBar.setValue(pct);
		} else {
			this.notice.setMessage(t('progress.noticeWithEllipsis', { label, progress }));
		}
	}

	hide(): void {
		this.notice.hide();
	}
}
