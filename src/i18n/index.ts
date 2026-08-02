/**
 * Internationalization (i18n) Module
 *
 * Provides localized strings for the OneDrive Sync plugin UI. Uses Obsidian's
 * language detection to select the appropriate locale, falling back to English.
 *
 * ## Adding a New Locale
 *
 * 1. Create `src/i18n/locales/<code>.ts` (e.g., `de.ts` for German)
 * 2. Export a `LocaleStrings` object with all required keys (copy `en.ts` as template)
 * 3. Import and register in the `locales` map below
 *
 * ## Usage
 *
 * ```typescript
 * import { t } from '../i18n';
 *
 * // Simple string
 * const message = t('notices.sync.started');
 *
 * // With interpolation
 * const progress = t('notices.sync.progress', { current: 5, total: 10 });
 * ```
 *
 * @module i18n
 */

import { getLanguage } from 'obsidian';
import { en, type LocaleStrings } from './locales/en';
import { zhCn } from './locales/zh-cn';

type TranslationParams = Record<string, string | number>;

const locales: Record<string, LocaleStrings> = {
	en,
	'zh-cn': zhCn,
	zh: zhCn,
};

function normalizeLanguage(language: string): string {
	return language.toLowerCase().replace(/_/g, '-');
}

function getLocale(): LocaleStrings {
	let language = 'en';

	try {
		if (typeof getLanguage === 'function') {
			language = normalizeLanguage(getLanguage());
		}
	} catch {
		language = 'en';
	}

	return locales[language] || locales[language.split('-')[0]] || (en);
}

function interpolate(template: string, params?: TranslationParams): string {
	if (!params) {
		return template;
	}

	return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
		const value = params[key];
		return value === undefined ? match : String(value);
	});
}

export function t(key: string, params?: TranslationParams): string {
	const locale = getLocale() as unknown as Record<string, unknown>;
	const fallback = en as unknown as Record<string, unknown>;
	const path = key.split('.');
	let value: unknown = locale;
	let fallbackValue: unknown = fallback;

	for (const segment of path) {
		value =
			typeof value === 'object' && value !== null
				? (value as Record<string, unknown>)[segment]
				: undefined;
		fallbackValue =
			typeof fallbackValue === 'object' && fallbackValue !== null
				? (fallbackValue as Record<string, unknown>)[segment]
				: undefined;
	}

	const template =
		typeof value === 'string' ? value : typeof fallbackValue === 'string' ? fallbackValue : key;

	return interpolate(template, params);
}
