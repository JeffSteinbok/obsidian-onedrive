/**
 * Status bar indicator for sync status
 */

import { setIcon } from 'obsidian';
import { t } from '../i18n';
import { logger } from '../utils/logger';

export enum SyncStatus {
	IDLE = 'idle',
	SYNCING = 'syncing',
	ERROR = 'error',
	DISCONNECTED = 'disconnected',
}

/**
 * Status bar manager
 */
export class StatusBarManager {
	private statusBarItem: HTMLElement;
	private currentStatus: SyncStatus = SyncStatus.DISCONNECTED;
	private lastSyncTime?: number;
	private conflictCount = 0;
	private progressMessage?: string;

	constructor(
		statusBarItem: HTMLElement,
		private onSyncClick?: () => void
	) {
		this.statusBarItem = statusBarItem;
		this.statusBarItem.addClass('onedrive-status-bar', 'onedrive-sync-clickable');
		this.statusBarItem.addEventListener('click', () => {
			if (this.onSyncClick && this.currentStatus !== SyncStatus.SYNCING) {
				this.onSyncClick();
			}
		});
		this.updateDisplay();
	}

	/**
	 * Set sync status
	 */
	setStatus(status: SyncStatus): void {
		this.currentStatus = status;
		if (status !== SyncStatus.SYNCING) {
			this.progressMessage = undefined;
		}
		this.updateDisplay();
		logger.debug('Status bar updated:', status);
	}

	/**
	 * Set a free-form progress message shown while SYNCING (e.g. "42/361 files").
	 * Cleared automatically when status changes away from SYNCING.
	 */
	setProgress(message: string | undefined): void {
		this.progressMessage = message;
		if (this.currentStatus === SyncStatus.SYNCING) {
			this.updateDisplay();
		}
	}

	/**
	 * Update last sync time
	 */
	setLastSyncTime(timestamp: number): void {
		this.lastSyncTime = timestamp;
		this.updateDisplay();
	}

	/**
	 * Set the number of pending conflicts
	 */
	setConflictCount(count: number): void {
		this.conflictCount = count;
		this.updateDisplay();
	}

	/**
	 * Update status bar display
	 */
	private updateDisplay(): void {
		// Clear previous content
		this.statusBarItem.empty();

		// Create icon element
		const iconEl = this.statusBarItem.createSpan({ cls: 'onedrive-status-icon' });

		// Create text element
		const textEl = this.statusBarItem.createSpan({ cls: 'onedrive-status-text' });

		// Set icon and text based on status
		switch (this.currentStatus) {
			case SyncStatus.IDLE:
				setIcon(iconEl, 'cloud');
				if (this.conflictCount > 0) {
					const conflictText = t(
						this.conflictCount === 1 ? 'statusBar.conflict' : 'statusBar.conflicts',
						{ count: this.conflictCount }
					);
					textEl.setText(`${this.getLastSyncText()} ⚠ ${conflictText}`);
				} else {
					textEl.setText(this.getLastSyncText());
				}
				this.statusBarItem.removeClass('is-syncing', 'has-error');
				break;

			case SyncStatus.SYNCING:
				setIcon(iconEl, 'cloud');
				textEl.setText(
					this.progressMessage
						? t('statusBar.syncingWithProgress', { progress: this.progressMessage })
						: t('statusBar.syncing')
				);
				this.statusBarItem.addClass('is-syncing');
				this.statusBarItem.removeClass('has-error');
				this.addLoadingAnimation(iconEl);
				break;

			case SyncStatus.ERROR:
				setIcon(iconEl, 'cloud-off');
				textEl.setText(t('statusBar.syncError'));
				this.statusBarItem.addClass('has-error');
				this.statusBarItem.removeClass('is-syncing');
				break;

			case SyncStatus.DISCONNECTED:
				setIcon(iconEl, 'cloud-off');
				textEl.setText(t('statusBar.notConnected'));
				this.statusBarItem.removeClass('is-syncing', 'has-error');
				break;
		}

		// Add tooltip
		this.statusBarItem.setAttribute('aria-label', this.getTooltip());
	}

	/**
	 * Get last sync time text
	 */
	private getLastSyncText(): string {
		if (!this.lastSyncTime) {
			return t('statusBar.notSyncedYet');
		}

		const now = Date.now();
		const diff = now - this.lastSyncTime;

		if (diff < 60000) {
			// Less than 1 minute
			return t('statusBar.syncedJustNow');
		} else if (diff < 3600000) {
			// Less than 1 hour
			const minutes = Math.floor(diff / 60000);
			return t('statusBar.syncedMinutesAgo', { minutes });
		} else if (diff < 86400000) {
			// Less than 1 day
			const hours = Math.floor(diff / 3600000);
			return t('statusBar.syncedHoursAgo', { hours });
		} else {
			// More than 1 day
			const days = Math.floor(diff / 86400000);
			return t('statusBar.syncedDaysAgo', { days });
		}
	}

	/**
	 * Get tooltip text
	 */
	private getTooltip(): string {
		switch (this.currentStatus) {
			case SyncStatus.IDLE:
				if (this.lastSyncTime) {
					return t('statusBar.tooltipLastSynced', {
						time: new Date(this.lastSyncTime).toLocaleTimeString(),
					});
				}
				return t('statusBar.tooltipReady');

			case SyncStatus.SYNCING:
				return t('statusBar.tooltipSyncing');

			case SyncStatus.ERROR:
				return t('statusBar.tooltipError');

			case SyncStatus.DISCONNECTED:
				return t('statusBar.tooltipDisconnected');

			default:
				return t('statusBar.tooltipDefault');
		}
	}

	/**
	 * Add loading animation to icon
	 */
	private addLoadingAnimation(iconEl: HTMLElement): void {
		iconEl.addClass('is-rotating');
	}
}
