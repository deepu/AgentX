/**
 * Policy layers and the effective policy a step runs under (docs/memwise/08-policy-and-control.md §2).
 *
 * PHASE 1 CONTRACT. `@memwise/gateway` consumes `EffectivePolicy` and `PolicyDecision`;
 * `@memwise/runtime` builds layers and calls `compilePolicy`. Change only additively.
 */
import type { EffectClass, Money, PolicyDoc, Treatment } from '@memwise/defs';

/** Layers, top to bottom. `platform` holds the built-in defaults. */
/** Phase 6 (24 §2): `workspace` (house rules above every domain) sits between plugins and the domain. */
export const LAYER_KINDS = ['platform', 'plugin', 'workspace', 'domain', 'workflow', 'step'] as const;
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
      /** Enforced by the tool gateway when it is given a rate counter (19 §7). */
      rateLimit?: Sourced<{ count: number; perMs: number }>;
    }>;
  };
  /** The tightest budget of every layer. A step-layer budget applies to one step run, any other to the whole run. */
  budgets: PolicyBudgets;
  /**
   * The budgets set above the step layer (platform, plugin, domain, workflow): run budgets,
   * checked against what the whole run spent. Kept apart because a step that tightens a budget
   * hides the run's in `budgets`. Absent in a policy compiled before this field existed.
   */
  runBudgets?: PolicyBudgets;
  /** null: any role. */
  modelRoles: Sourced<string[]> | null;
  /**
   * Roles that may decide effect approvals: the intersection of every layer's `approvals.by`
   * (19 §1). Absent: no layer says; the step's assignee role, else the workflow owner, else any
   * signed-in person decides.
   */
  approvers?: Sourced<string[]>;
  taint: { enabled: Sourced<boolean>; outboundWhenTainted: Sourced<Treatment> };
  /** The layers this was compiled from, top to bottom. */
  layers: { kind: LayerKind; name: string; source?: string }[];
}

export interface PolicyBudgets {
  tokens?: Sourced<number>;
  timeMs?: Sourced<number>;
  modelCalls?: Sourced<number>;
  /** Enforced by the step engine when the model role has a price in the same currency (19 §7). */
  money?: Sourced<Money>;
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
