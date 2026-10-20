/**
 * Feature flags for controlling experimental or in-development features.
 */

/** Safe accessor for process.env — returns undefined in browser/renderer contexts. */
function getEnv(key: string): string | undefined {
  if (typeof process !== 'undefined' && process.env) return process.env[key];
  return undefined;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

/**
 * Shared runtime detector for development/debug environments.
 *
 * Use this instead of app-specific debug flags (e.g., Electron main isDebugMode)
 * so behavior stays consistent across shared code and subprocess backends.
 */
export function isDevRuntime(): boolean {
  const nodeEnv = (getEnv('NODE_ENV') || '').toLowerCase();
  return nodeEnv === 'development' || nodeEnv === 'dev' || getEnv('MEMWISE_DEBUG') === '1';
}

/**
 * Runtime-evaluated check for developer feedback feature.
 * Explicit env override has precedence over dev-runtime defaults.
 */
export function isDeveloperFeedbackEnabled(): boolean {
  const override = parseBooleanEnv(getEnv('MEMWISE_FEATURE_DEVELOPER_FEEDBACK'));
  if (override !== undefined) return override;
  return isDevRuntime();
}

/**
 * Runtime-evaluated check for memwise-cli integration.
 *
 * Defaults to disabled. Override with MEMWISE_FEATURE_MEMWISE_CLI=1|0.
 */
export function isMemWiseCliEnabled(): boolean {
  const override = parseBooleanEnv(getEnv('MEMWISE_FEATURE_MEMWISE_CLI'));
  if (override !== undefined) return override;
  return false;
}

/**
 * Runtime-evaluated check for embedded server settings page.
 *
 * Defaults to disabled. Override with MEMWISE_FEATURE_EMBEDDED_SERVER=1|0.
 */
export function isEmbeddedServerEnabled(): boolean {
  const override = parseBooleanEnv(getEnv('MEMWISE_FEATURE_EMBEDDED_SERVER'));
  if (override !== undefined) return override;
  return false;
}

/**
 * Runtime-evaluated check for Pages sharing (Cloudflare publication).
 *
 * Server-evaluated: the renderer learns it via `pages:getShareCapabilities`,
 * never from its own process.env. Gates publish/update only — unpublish stays
 * available regardless, so disabling the flag never strands a published page.
 *
 * Defaults to DISABLED in MemWise: the publication Worker inherited from
 * Craft Agents is Craft's hosted service, not ours, so publishing would send
 * page bundles to a third party. Opt in with MEMWISE_FEATURE_PAGES_SHARING=1
 * (and point MEMWISE_PAGES_SHARE_API_URL at a Worker you run).
 */
export function isPagesSharingEnabled(): boolean {
  const override = parseBooleanEnv(getEnv('MEMWISE_FEATURE_PAGES_SHARING'));
  if (override !== undefined) return override;
  return false;
}

export const FEATURE_FLAGS = {
  /** Enable Opus 4.7 fast mode (speed:"fast" + beta header). 6x pricing. */
  fastMode: false,
  /**
   * Enable agent developer feedback tool.
   *
   * Defaults to enabled in explicit development runtimes; disabled otherwise.
   * Override with MEMWISE_FEATURE_DEVELOPER_FEEDBACK=1|0.
   */
  get developerFeedback(): boolean {
    return isDeveloperFeedbackEnabled();
  },
  /**
   * Enable memwise CLI guidance and guardrails.
   *
   * Defaults to disabled. Override with MEMWISE_FEATURE_MEMWISE_CLI=1|0.
   */
  get memwiseCli(): boolean {
    return isMemWiseCliEnabled();
  },
  /**
   * Enable embedded server settings page.
   *
   * Defaults to disabled. Override with MEMWISE_FEATURE_EMBEDDED_SERVER=1|0.
   */
  get embeddedServer(): boolean {
    return isEmbeddedServerEnabled();
  },
  /**
   * Enable Pages sharing (publish to Cloudflare).
   *
   * Defaults to DISABLED in MemWise (the inherited Worker is Craft's). Opt in
   * with MEMWISE_FEATURE_PAGES_SHARING=1.
   */
  get pagesSharing(): boolean {
    return isPagesSharingEnabled();
  },
} as const;
