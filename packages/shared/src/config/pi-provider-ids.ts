/**
 * MemWise ↔ Pi SDK provider ids.
 *
 * MemWise keeps the provider ids it persists on LLM connections
 * (`LlmConnection.piAuthProvider`, the API-key presets) and translates them
 * where they cross into the Pi SDK, so an upstream rename never needs a config
 * migration and a downgrade keeps working. MemWise's preset keys are already a
 * MemWise namespace (`openai-eu`, `minimax-global`, …).
 *
 * - `azure-openai-responses` → `azure` (Pi 1.0.3). Only the provider id moved;
 *   the API name `azure-openai-responses` and the `AZURE_OPENAI_*` env vars are
 *   unchanged.
 *
 * Pure (no Pi imports) so the Pi subprocess and renderer-safe code can use it.
 */
const MEMWISE_TO_PI_PROVIDER_ID: Readonly<Record<string, string>> = {
  'azure-openai-responses': 'azure',
};

const PI_TO_MEMWISE_PROVIDER_ID: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MEMWISE_TO_PI_PROVIDER_ID).map(([craftId, piId]) => [piId, craftId]),
);

/** The Pi SDK provider id for a provider id MemWise stores. */
export function toPiProviderId(craftProviderId: string): string {
  return MEMWISE_TO_PI_PROVIDER_ID[craftProviderId] ?? craftProviderId;
}

/** The provider id MemWise stores for a Pi SDK provider id. */
export function fromPiProviderId(piProviderId: string): string {
  return PI_TO_MEMWISE_PROVIDER_ID[piProviderId] ?? piProviderId;
}
