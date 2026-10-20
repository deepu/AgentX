/**
 * Policy layers and the effective policy a step runs under (docs/memwise/08-policy-and-control.md §2).
 *
 * PHASE 1 CONTRACT. `@memwise/gateway` consumes `EffectivePolicy` and `PolicyDecision`;
 * `@memwise/runtime` builds layers and calls `compilePolicy`. Change only additively.
 */
import type { EffectClass, Money, PolicyDoc, Treatment } from '@memwise/defs';

/** Layers, top to bottom. `platform` holds the built-in defaults. */
export const LAYER_KINDS = ['platform', 'plugin', 'domain', 'workflow', 'step'] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];

export interface PolicyLayer {
  kind: LayerKind;
  /** e.g. `platform`, `domain`, `client-intake`, `client-intake/check`. */
  name: string;
  /** File relative to the project root, when the layer came from one. */
  source?: string;
  doc: PolicyDoc;
}

export interface RuleOrigin { layer: LayerKind; name: string; source?: string }

/** A value with the layer that set it, for the effective-policy view. */
export interface Sourced<T> { value: T; origin: RuleOrigin }

export interface EffectivePolicy {
  /** Treatment per effect class after every layer. */
  effects: Record<EffectClass, Sourced<Treatment>>;
  tools: {
    /** null: any tool bound in the domain. Otherwise the intersection of every layer's `allow`. */
    allowed: Sourced<string[]> | null;
    denied: Sourced<string>[];
    required: Sourced<string>[];
    perTool: Record<string, {
      treatment?: Sourced<Treatment>;
      rateLimit?: Sourced<{ count: number; perMs: number }>;
    }>;
  };
  budgets: {
    tokens?: Sourced<number>;
    timeMs?: Sourced<number>;
    modelCalls?: Sourced<number>;
    money?: Sourced<Money>;
  };
  /** null: any role. */
  modelRoles: Sourced<string[]> | null;
  taint: { enabled: Sourced<boolean>; outboundWhenTainted: Sourced<Treatment> };
  /** The layers this was compiled from, top to bottom. */
  layers: { kind: LayerKind; name: string; source?: string }[];
}

/** A lower layer tried to loosen a rule set above it (D30). */
export interface PolicyViolation {
  layer: LayerKind;
  name: string;
  source?: string;
  /** e.g. `effects.outbound`, `tools.allow`, `budgets.tokens`. */
  path: string;
  message: string;
  /** The rule it tried to loosen. */
  loosens: RuleOrigin;
}

export interface CompiledPolicy {
  effective: EffectivePolicy;
  violations: PolicyViolation[];
}

/** What the gateway asks before a tool call. */
export interface PolicyRequest {
  tool: string;
  effect: EffectClass;
  /** False when the tool declared no class and `effect` was defaulted to `irreversible`. */
  classified: boolean;
  /** The session has read untrusted content (07 §6). */
  tainted: boolean;
}

export interface PolicyDecision {
  /** `allow` runs; `preview` runs and records a preview; `approve` waits for a person; `deny` refuses. */
  verdict: Treatment;
  reason: string;
  /** The rules that produced the verdict (the strictest wins). */
  origins: RuleOrigin[];
}
