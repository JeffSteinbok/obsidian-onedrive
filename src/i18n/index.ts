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

	return locales[language] || locales[language.split('-')[0]] || (en as LocaleStrings);
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
