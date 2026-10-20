export type CliDomainNamespace = 'label' | 'source' | 'skill' | 'automation' | 'permission' | 'theme'

export interface CliDomainPolicy {
  namespace: CliDomainNamespace
  helpCommand: string
  workspacePathScopes: string[]
  readActions: string[]
  quickExamples: string[]
  /** Optional workspace-relative paths guarded for direct Bash operations */
  bashGuardPaths?: string[]
}

const POLICIES: Record<CliDomainNamespace, CliDomainPolicy> = {
  label: {
    namespace: 'label',
    helpCommand: 'memwise label --help',
    workspacePathScopes: ['labels/**'],
    readActions: ['list', 'get', 'auto-rule-list', 'auto-rule-validate'],
    quickExamples: [
      'memwise label list',
      'memwise label create --name "Bug" --color "accent"',
      'memwise label update bug --json \'{"name":"Bug Report"}\'',
    ],
    bashGuardPaths: ['labels/**'],
  },
  source: {
    namespace: 'source',
    helpCommand: 'memwise source --help',
    workspacePathScopes: ['sources/**'],
    readActions: ['list', 'get', 'validate', 'test', 'auth-help'],
    quickExamples: [
      'memwise source list',
      'memwise source get <slug>',
      'memwise source update <slug> --json "{...}"',
      'memwise source validate <slug>',
    ],
  },
  skill: {
    namespace: 'skill',
    helpCommand: 'memwise skill --help',
    workspacePathScopes: ['skills/**'],
    readActions: ['list', 'get', 'validate', 'where'],
    quickExamples: [
      'memwise skill list',
      'memwise skill get <slug>',
      'memwise skill update <slug> --json "{...}"',
      'memwise skill validate <slug>',
    ],
  },
  automation: {
    namespace: 'automation',
    helpCommand: 'memwise automation --help',
    workspacePathScopes: ['automations.json', 'automations-history.jsonl'],
    readActions: ['list', 'get', 'validate', 'history', 'last-executed', 'test', 'lint'],
    quickExamples: [
      'memwise automation list',
      'memwise automation create --event UserPromptSubmit --prompt "Summarize this prompt"',
      'memwise automation update <id> --json "{\"enabled\":false}"',
      'memwise automation history <id> --limit 20',
      'memwise automation validate',
    ],
    bashGuardPaths: ['automations.json', 'automations-history.jsonl'],
  },
  permission: {
    namespace: 'permission',
    helpCommand: 'memwise permission --help',
    workspacePathScopes: ['permissions.json', 'sources/*/permissions.json'],
    readActions: ['list', 'get', 'validate'],
    quickExamples: [
      'memwise permission list',
      'memwise permission get --source linear',
      'memwise permission add-mcp-pattern "list" --comment "All list ops" --source linear',
      'memwise permission validate',
    ],
    bashGuardPaths: ['permissions.json', 'sources/*/permissions.json'],
  },
  theme: {
    namespace: 'theme',
    helpCommand: 'memwise theme --help',
    workspacePathScopes: ['config.json', 'theme.json', 'themes/*.json'],
    readActions: ['get', 'validate', 'list-presets', 'get-preset'],
    quickExamples: [
      'memwise theme get',
      'memwise theme list-presets',
      'memwise theme set-color-theme nord',
      'memwise theme set-workspace-color-theme default',
      'memwise theme set-override --json "{\"accent\":\"#3b82f6\"}"',
    ],
    bashGuardPaths: ['config.json', 'theme.json', 'themes/*.json'],
  },
}

export const CLI_DOMAIN_POLICIES = POLICIES

export interface CliDomainScopeEntry {
  namespace: CliDomainNamespace
  scope: string
}

function dedupeScopes(scopes: string[]): string[] {
  return [...new Set(scopes)]
}

/**
 * Canonical workspace-relative path scopes owned by memwise CLI domains.
 * Use these for file-path ownership checks to avoid drift across call sites.
 */
export const MEMWISE_CLI_OWNED_WORKSPACE_PATH_SCOPES = dedupeScopes(
  Object.values(POLICIES).flatMap(policy => policy.workspacePathScopes)
)

/**
 * Canonical workspace-relative path scopes guarded for direct Bash operations.
 */
export const MEMWISE_CLI_OWNED_BASH_GUARD_PATH_SCOPES = dedupeScopes(
  Object.values(POLICIES).flatMap(policy => policy.bashGuardPaths ?? [])
)

/**
 * Namespace-aware workspace scope entries for memwise CLI owned paths.
 */
export const MEMWISE_CLI_WORKSPACE_SCOPE_ENTRIES: CliDomainScopeEntry[] = Object.values(POLICIES)
  .flatMap(policy => policy.workspacePathScopes.map(scope => ({ namespace: policy.namespace, scope })))

/**
 * Namespace-aware Bash guard scope entries.
 */
export const MEMWISE_CLI_BASH_GUARD_SCOPE_ENTRIES: CliDomainScopeEntry[] = Object.values(POLICIES)
  .flatMap(policy => (policy.bashGuardPaths ?? []).map(scope => ({ namespace: policy.namespace, scope })))

export interface BashPatternRule {
  pattern: string
  comment: string
}

/**
 * Derive the canonical Explore-mode read-only memwise bash patterns from
 * CLI domain policies. Keeps permissions regexes aligned with command metadata.
 */
export function getMemWiseAgentReadOnlyBashPatterns(): BashPatternRule[] {
  const namespaces = Object.keys(POLICIES) as CliDomainNamespace[]
  const namespaceAlternation = namespaces.join('|')

  const rules: BashPatternRule[] = namespaces.map((namespace) => {
    const policy = POLICIES[namespace]
    const actions = policy.readActions.join('|')
    return {
      pattern: `^memwise\\s+${namespace}\\s+(${actions})\\b`,
      comment: `memwise ${namespace} read-only operations`,
    }
  })

  rules.push(
    { pattern: '^memwise\\s*$', comment: 'memwise bare invocation (prints help)' },
    { pattern: `^memwise\\s+(${namespaceAlternation})\\s*$`, comment: 'memwise entity help' },
    { pattern: `^memwise\\s+(${namespaceAlternation})\\s+--help\\b`, comment: 'memwise entity help flags' },
    { pattern: '^memwise\\s+--(help|version|discover)\\b', comment: 'memwise global flags' },
  )

  return rules
}

export function getCliDomainPolicy(namespace: CliDomainNamespace): CliDomainPolicy {
  return POLICIES[namespace]
}
