import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
	{ ignores: ['node_modules/**', 'main.js', '*.mjs', 'coverage/**', 'dev/**', 'tests/**', 'eslint-plugin-obsidian-compat/**'] },
	...obsidianmd.configs.recommended,
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: './tsconfig.json',
				sourceType: 'module',
			},
		},
		rules: {
			'no-console': 'warn',
		},
	},
]);
