/**
 * ESLint Configuration for Electron App
 *
 * Uses flat config format (ESLint 9+).
 * Includes custom navigation rule to enforce navigate() usage.
 */

import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import noDirectNavigationState from './eslint-rules/no-direct-navigation-state.cjs'
import noLocalStorage from './eslint-rules/no-localstorage.cjs'
import noDirectPlatformCheck from './eslint-rules/no-direct-platform-check.cjs'
import noHardcodedPathSeparator from './eslint-rules/no-hardcoded-path-separator.cjs'
import noDirectFileOpen from './eslint-rules/no-direct-file-open.cjs'
import noInlineSourceAuthCheck from './eslint-rules/no-inline-source-auth-check.cjs'
import noHardcodedZIndex from './eslint-rules/no-hardcoded-z-index.cjs'
import noNonstandardShadows from './eslint-rules/no-nonstandard-shadows.cjs'
// Design-system guardrails shared with packages/ui (one implementation)
import noMotionAntipatterns from '../../packages/ui/eslint-rules/no-motion-antipatterns.cjs'
import noRawPaletteColors from '../../packages/ui/eslint-rules/no-raw-palette-colors.cjs'

export default [
  // Ignore patterns
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'release/**',
      '*.cjs',
      'eslint-rules/**',
    ],
  },

  // TypeScript/React files
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      // Custom plugin for MemWise rules
      'memwise': {
        rules: {
          'no-direct-navigation-state': noDirectNavigationState,
          'no-localstorage': noLocalStorage,
        },
      },
      // Custom plugin for platform detection rules
      'craft-platform': {
        rules: {
          'no-direct-platform-check': noDirectPlatformCheck,
        },
      },
      // Custom plugin for cross-platform path rules
      'craft-paths': {
        rules: {
          'no-hardcoded-path-separator': noHardcodedPathSeparator,
        },
      },
      // Custom plugin for link interceptor enforcement
      'craft-links': {
        rules: {
          'no-direct-file-open': noDirectFileOpen,
        },
      },
      // Custom plugin for source auth checks (shared with packages/shared)
      'craft-sources': {
        rules: {
          'no-inline-source-auth-check': noInlineSourceAuthCheck,
        },
      },
      // Custom style rules
      'memwise-styles': {
        rules: {
          'no-hardcoded-z-index': noHardcodedZIndex,
          'no-nonstandard-shadows': noNonstandardShadows,
          'no-motion-antipatterns': noMotionAntipatterns,
          'no-raw-palette-colors': noRawPaletteColors,
        },
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      // React Hooks rules
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Custom MemWise rules
      'memwise/no-direct-navigation-state': 'error',
      'memwise/no-localstorage': 'warn',

      // Custom platform detection rule
      'craft-platform/no-direct-platform-check': 'error',

      // Custom cross-platform path rule
      'craft-paths/no-hardcoded-path-separator': 'warn',

      // Custom link interceptor rule — prevents bypassing in-app file preview
      'craft-links/no-direct-file-open': 'error',

      // Custom source auth check rule — use isSourceUsable() instead of inline checks
      'craft-sources/no-inline-source-auth-check': 'error',

      // Custom style rule — use z-index token scale instead of hardcoded literals
      'memwise-styles/no-hardcoded-z-index': 'error',

      // Custom style rule — enforce approved shadow classes/tokens only
      'memwise-styles/no-nonstandard-shadows': ['error', {
        allowedClasses: [
          'shadow-none',
          'shadow-xs',
          'shadow-elev-0',
          'shadow-elev-1',
          'shadow-elev-2',
          'shadow-elev-3',
          'shadow-minimal',
          'shadow-tinted',
          'shadow-thin',
          'shadow-middle',
          'shadow-strong',
          'shadow-panel-focused',
          'shadow-modal-small',
          'shadow-dragging',
          'shadow-bottom-border',
          'shadow-bottom-border-thin',
        ],
        allowInlineNone: true,
      }],

      // Design-system guardrails (implementation plan A0): warn until the class codemod (A3–B9) lands
      'memwise-styles/no-motion-antipatterns': 'warn',
      'memwise-styles/no-raw-palette-colors': 'warn',

      // Enforce centralized action registry for keyboard shortcuts
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: 'react-hotkeys-hook',
            message: 'Use useAction from @/actions instead. See actions/index.ts'
          }
        ],
      }],
    },
  },

  // Temporary exceptions for unresolved shadow migrations.
  {
    files: [
      'src/renderer/components/ui/sortable-list.tsx',
      'src/main/browser-pane-manager.ts',
      'src/shared/browser-live-fx.ts',
      'src/renderer/components/KeyboardShortcutsDialog.tsx',
      'src/renderer/playground/**/*.{ts,tsx}',
    ],
    rules: {
      'memwise-styles/no-nonstandard-shadows': 'off',
    },
  },

  // Playground demos show raw colors on purpose (swatches, before/after)
  {
    files: ['src/renderer/playground/**/*.{ts,tsx}'],
    rules: {
      'memwise-styles/no-raw-palette-colors': 'off',
    },
  },

  // Enforce backend abstraction boundary in Electron main process.
  {
    files: ['src/main/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: '@memwise/shared/codex',
            message: 'Use provider-agnostic APIs from @memwise/shared/agent/backend instead.',
          },
          {
            name: '@memwise/shared/agent/claude-agent',
            message: 'Provider backends must stay behind @memwise/shared/agent/backend.',
          },
          {
            name: '@memwise/shared/agent/pi-agent',
            message: 'Provider backends must stay behind @memwise/shared/agent/backend.',
          },
        ],
      }],
    },
  },

  // Keep main model fetchers provider-agnostic (delegate to shared backend APIs only).
  {
    files: ['src/main/model-fetchers/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.name='fetch']",
          message: 'Do not call provider APIs directly in Electron model fetchers. Delegate to fetchBackendModels() from @memwise/shared/agent/backend.',
        },
        {
          selector: "ImportDeclaration[source.value='@anthropic-ai/claude-agent-sdk']",
          message: 'Provider SDK usage must stay in backend drivers under packages/shared/src/agent/backend/internal/drivers.',
        },
        {
          selector: "ImportDeclaration[source.value='@earendil-works/pi-ai']",
          message: 'Provider SDK usage must stay in backend drivers under packages/shared/src/agent/backend/internal/drivers.',
        },
        {
          selector: "ImportDeclaration[source.value='@earendil-works/pi-coding-agent']",
          message: 'Provider SDK usage must stay in backend drivers under packages/shared/src/agent/backend/internal/drivers.',
        },
      ],
    },
  },
]
