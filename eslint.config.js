import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';
import sonarjs from 'eslint-plugin-sonarjs';
import unusedImports from 'eslint-plugin-unused-imports';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import jsdoc from 'eslint-plugin-jsdoc';
import security from 'eslint-plugin-security';
import regexp from 'eslint-plugin-regexp';

export default tseslint.config(
    // Ignore generated and build files
    {
        ignores: [
            'dist/**',
            'node_modules/**',
            '*.cjs',
            '*.config.js',
            '*.config.ts',
            '*.config.mjs',
            'eslint.config.js'
        ]
    },
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    unicorn.configs.recommended,
    sonarjs.configs.recommended,
    security.configs.recommended,
    regexp.configs['flat/recommended'],
    {
        plugins: {
            'unused-imports': unusedImports,
            'simple-import-sort': simpleImportSort,
            jsdoc
        },
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            parserOptions: {
                projectService: {
                    allowDefaultProject: ['scripts/*.ts', 'src/*.test.ts'],
                    defaultProject: './tsconfig.eslint.json',
                    maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 20
                },
                tsconfigRootDir: import.meta.dirname
            },
            globals: {
                console: 'readonly',
                process: 'readonly',
                globalThis: 'readonly'
            }
        },
        rules: {
            // Unused imports with autofix
            'unused-imports/no-unused-imports': 'error',
            'unused-imports/no-unused-vars': ['error', {
                vars: 'all',
                varsIgnorePattern: '^_',
                args: 'after-used',
                argsIgnorePattern: '^_'
            }],
            '@typescript-eslint/no-unused-vars': 'off',

            'no-console': 'off',
            'eqeqeq': 'error',
            'curly': 'error',
            'no-var': 'error',
            'prefer-const': 'error',
            'no-multiple-empty-lines': ['error', { max: 1 }],
            'semi': ['error', 'always'],
            'quotes': ['error', 'single', { avoidEscape: true }],

            // Import sorting
            'simple-import-sort/imports': 'error',
            'simple-import-sort/exports': 'error',

            // Zero any
            '@typescript-eslint/no-explicit-any': 'error',

            // JSDoc enforcement
            'jsdoc/require-jsdoc': ['error', {
                publicOnly: true,
                require: { FunctionDeclaration: true, ArrowFunctionExpression: false, MethodDefinition: false }
            }],
            'jsdoc/require-description': ['error', { descriptionStyle: 'body' }],
            'jsdoc/require-returns': 'error',
            'jsdoc/require-param': 'warn',
            'jsdoc/require-param-description': 'error',
            'jsdoc/check-param-names': 'error',
            'jsdoc/check-types': 'error',
            'jsdoc/no-undefined-types': 'error',

            // Security
            'security/detect-object-injection': 'off',
            'security/detect-non-literal-regexp': 'off',
            'security/detect-non-literal-fs-filename': 'off',

            // Regex quality
            'regexp/no-misleading-capturing-group': 'error',
            'regexp/no-super-linear-backtracking': 'error',
            'regexp/prefer-named-capture-group': 'error',
            'regexp/no-empty-character-class': 'error',
            'regexp/no-useless-backreference': 'error',

            // Complexity rules
            'complexity': ['error', { max: 12 }],
            'max-depth': ['error', { max: 4 }],
            'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
            'max-lines-per-function': ['error', { max: 75, skipBlankLines: true, skipComments: true }],
            'max-params': ['error', { max: 5 }],
            'max-nested-callbacks': ['error', { max: 3 }],

            // SonarJS
            'sonarjs/cognitive-complexity': ['error', 15],
            'sonarjs/no-duplicate-string': ['error', { threshold: 4 }],
            'sonarjs/no-identical-functions': 'error',
            'sonarjs/no-collapsible-if': 'error',
            'sonarjs/no-nested-switch': 'error',
            'sonarjs/no-inconsistent-returns': 'error',
            'sonarjs/no-redundant-parentheses': 'error',
            'sonarjs/no-wildcard-import': 'error',
            'sonarjs/prefer-immediate-return': 'error',
            'sonarjs/prefer-object-literal': 'error',
            'sonarjs/nested-control-flow': 'error',
            'sonarjs/max-union-size': 'error',
            'sonarjs/shorthand-property-grouping': 'error',
            'sonarjs/too-many-break-or-continue-in-loop': 'error',
            'sonarjs/bool-param-default': 'error',

            // Unicorn
            'unicorn/filename-case': ['error', { cases: { kebabCase: true, camelCase: true } }],
            'unicorn/prevent-abbreviations': 'error',
            'unicorn/no-null': 'error',
            'unicorn/no-array-reduce': 'error',
            'unicorn/no-array-for-each': 'error',
            'unicorn/prefer-module': 'error',
            'unicorn/prefer-top-level-await': 'error',
            'unicorn/consistent-function-scoping': 'error',
            'unicorn/no-array-callback-reference': 'error',
            'unicorn/prefer-global-this': 'error',

            // Type-checked rules
            '@typescript-eslint/no-non-null-assertion': 'error',
            '@typescript-eslint/restrict-template-expressions': ['error', {
                allowNumber: true,
                allowBoolean: true
            }],
            '@typescript-eslint/no-unnecessary-condition': 'error',
            '@typescript-eslint/no-unnecessary-type-parameters': 'error',
            '@typescript-eslint/no-confusing-void-expression': 'off',
            '@typescript-eslint/restrict-plus-operands': ['error', {
                allowNumberAndString: true
            }],
            '@typescript-eslint/no-misused-spread': 'error',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/require-await': 'error',
            '@typescript-eslint/no-unnecessary-type-assertion': 'error',
            '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
            '@typescript-eslint/no-deprecated': 'error',
            '@typescript-eslint/prefer-readonly': 'error',
            '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
            '@typescript-eslint/consistent-type-exports': 'error',
            '@typescript-eslint/no-unsafe-type-assertion': 'error',
            '@typescript-eslint/prefer-nullish-coalescing': 'error',
            '@typescript-eslint/prefer-optional-chain': 'error'
        }
    },
    // Shared pure-function modules (tile-coords, tile-pyramid)
    {
        files: ['src/tile-coords.ts', 'src/tile-pyramid.ts'],
        rules: {
            'functional/immutable-data': 'off',
            'functional/no-let': 'off',
            'functional/prefer-tacit': 'off',
            'max-lines-per-function': 'off',
            'max-params': 'off',
            '@typescript-eslint/no-unnecessary-type-parameters': 'off',
            '@typescript-eslint/no-unsafe-type-assertion': 'off'
        }
    },
    // bluemap-provider.ts iterates strings with Array.from()
    {
        files: ['src/providers/bluemap-provider.ts'],
        rules: {
            '@typescript-eslint/consistent-type-imports': 'off',
            'unicorn/prefer-spread': 'off'
        }
    },
    // Relaxed rules for CLI build scripts
    {
        files: ['scripts/*.ts'],
        rules: {
            'max-lines': 'off',
            'unicorn/no-process-exit': 'off',
            'unicorn/prefer-top-level-await': 'off',
            'complexity': ['error', { max: 25 }],
            'sonarjs/cognitive-complexity': 'off',
            'max-lines-per-function': ['error', { max: 150, skipBlankLines: true, skipComments: true }],
            'max-params': ['error', { max: 10 }],
            'unicorn/no-array-for-each': 'off',
            'unicorn/no-null': 'off',
            'unicorn/prevent-abbreviations': ['error', {
                replacements: {
                    dir: false,
                    msg: false,
                    err: false,
                    i: false,
                    utils: false
                }
            }],
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            'sonarjs/no-duplicate-string': 'off',
            'sonarjs/deprecation': 'off',
            'unicorn/no-array-callback-reference': 'off',
            'functional/immutable-data': 'off',
            'functional/no-let': 'off',
            'functional/prefer-immutable-types': 'off',
            'functional/prefer-tacit': 'off',
            'functional/prefer-property-signatures': 'off',
            'jsdoc/require-jsdoc': 'off',
            'no-restricted-syntax': 'off',
            '@typescript-eslint/prefer-nullish-coalescing': 'off',
            '@typescript-eslint/prefer-readonly': 'off'
        }
    },
    // Relaxed rules for unit tests
    {
        files: ['**/*.test.ts'],
        rules: {
            '@typescript-eslint/no-unsafe-type-assertion': 'off',
            'max-lines': 'off',
            'max-lines-per-function': 'off',
            'sonarjs/no-duplicate-string': 'off',
            'max-nested-callbacks': ['error', { max: 6 }],
            'unicorn/no-null': 'off',
            'unicorn/no-array-callback-reference': 'off',
            'sonarjs/no-element-overwrite': 'off',
            'functional/immutable-data': 'off',
            'functional/no-let': 'off',
            'functional/prefer-immutable-types': 'off',
            'jsdoc/require-jsdoc': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            'no-restricted-syntax': 'off',
            '@typescript-eslint/prefer-nullish-coalescing': 'off',
            '@typescript-eslint/no-dynamic-delete': 'off',
            '@typescript-eslint/no-empty-function': 'off',
            '@typescript-eslint/no-unnecessary-type-parameters': 'off'
        }
    }
);
