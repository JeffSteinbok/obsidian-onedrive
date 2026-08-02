import tseslint from 'typescript-eslint';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const obsidianCompat = require('./eslint-plugin-obsidian-compat/index.js');

export default tseslint.config(
	{
		// Mirror old .eslintignore
		ignores: [
			'main.js',
			'**/*.js.map',
			'node_modules/**',
			'coverage/**',
			'eslint.config.mjs',
			'esbuild.config.mjs',
			'version-bump.mjs',
		],
	},
	{
		files: ['src/**/*.ts'],
		extends: tseslint.configs.recommendedTypeChecked,
		languageOptions: {
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: {
			'obsidian-compat': obsidianCompat,
		},
		rules: {
			'no-console': 'warn',
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/explicit-function-return-type': 'off',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
			'obsidian-compat/no-global-document': 'warn',
			'obsidian-compat/no-global-this': 'warn',
			'obsidian-compat/no-bare-timers': 'warn',
			'obsidian-compat/no-static-styles': 'warn',
			'obsidian-compat/no-deprecated-display': 'warn',
			'obsidian-compat/no-deprecated-slider-api': 'error',
			'obsidian-compat/no-missing-getSettingDefinitions': 'warn',
		},
	},
);
