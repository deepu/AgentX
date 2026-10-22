/**
 * The host's secrets for builtin tools (Stage 6): a builtin that declares `secrets` (the Medidata
 * Rave connection) gets them from the host's settings, injected by the tool gateway, which also
 * redacts them from the tool's results and errors. Only names a builtin declares are served, so a
 * plugin tool naming some other variable gets nothing from here.
 */

import type { SecretProvider, ToolDefinition } from '@memwise/gateway'

export function builtinSecrets(builtins: ToolDefinition[], env: Record<string, string | undefined> = process.env): SecretProvider {
  const declared = new Set(builtins.filter((t) => !!t.source?.plugin).flatMap((t) => t.secrets ?? []))
  return {
    async get(name) {
      if (!declared.has(name)) return undefined
      const v = env[name]
      return v === undefined || v === '' ? undefined : v
    },
  }
}
