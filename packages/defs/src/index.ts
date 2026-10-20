/**
 * @memwise/defs: file formats, JSON Schemas, checks and the definitions indexer.
 *
 * See README.md for what this package owns and docs/memwise/18-kernel-interfaces.md for
 * how the other kernel packages use it.
 */

export * from './types.ts';
export * from './contracts.ts';
export * from './draft-types.ts';
export * from './plugin-types.ts';
export type * from './external-types.ts';
export * from './domain-types.ts';
export { parseCondition, conditionNames, CONDITION_FUNCTIONS } from './condition.ts';
export { entityKey, keyOf, splitEntityKey, domainOf, scopedEntities, resolveEntity, domainEntities, hasRole, rolesIn } from './domains.ts';
export { crashPoint } from './testing.ts';

export { parseValueType, formatValueType, sameValueType, parseDuration, parseCount, parseRate } from './value-types.ts';
export { parseWorkflowFile, parseExampleFile, type WorkflowShape } from './parse-workflow.ts';
export { parseStepFile, splitFrontMatter, argSource, DEFAULT_MIN_CONFIDENCE } from './parse-step.ts';
export { parseCaseFile, parseEntityFile, parseRolesFile } from './parse-types.ts';
// Phase 6: domains and records (docs/memwise/24-phase-6-interfaces.md).
export { parseWorkspaceFile, parseDomainFile, parsePageFile, parseViewFile, defaultDomainName } from './parse-domain.ts';
export { defaultPageLayout, listTransition, PAGE_BLOCK_KINDS, LAYOUT_AREAS } from './parse-records.ts';
export { parseTriggers, handoffArg } from './parse-handoffs.ts';
export { checkCondition, entityConditionScope, kindOfType, type ConditionKind, type ConditionName, type ConditionScope, type ConditionCheckOptions, type ConditionProblem } from './condition-check.ts';
export { relationshipInverse, handoffFields, callOutcomes, blockEvents, MESSAGE_FIELDS } from './check-domains.ts';
export { entityToolNames, entityTools, ENTITY_TOOL_VERBS, ENTITY_TOOL_EFFECTS, type EntityToolVerb } from './entity-tools.ts';
export { parsePolicyFile, policyToRaw, formatDuration } from './parse-policy.ts';
export { sha256, type ParseResult } from './source.ts';
export { loadProject, loadWorkflow } from './load.ts';
export { pinnedPlugin, type LoadProjectOptions } from './project-plugins.ts';
export { checkWorkflow, checkProject, systemOutcome, isConversationStep, BUILTIN_OUTCOMES, ENGINE_TOOLS, type CheckOptions } from './check.ts';
export { validateValue, valueTypeToJsonSchema, IDENTIFIER_PATTERNS, type RecordTypes } from './values.ts';
export { jsonSchemas, formats, type FormatName } from './formats.ts';
export { indexProject, DOMAIN_POLICY_ID } from './index-project.ts';
export { lineDiff, structuralDiff, describeStructuralDiff, stepParts, splitLines, type DiffNameKind } from './diff.ts';
export {
  createDraft, listDrafts, readDraft, updateDraftMeta, writeDraftFiles, setDraftEditStatus, discardDraftEdit,
  draftContentHash, loadDraft, diffDraft, applyDraft, writeDraftReport, draftDir, badDraftPath, setWorkflowVersion,
  DraftConflictError, DraftStaleError, WORKFLOW_ID_PATTERN, type CreateDraftInput, type DraftFiles, type WriteDraftOptions,
  createBindingDraft, type CreateBindingDraftInput,
} from './drafts.ts';
export { exampleToYaml } from './example-yaml.ts';
export { initProject, INTAKE_TEMPLATE_DIR, META_PLAYBOOKS, type InitOptions } from './init.ts';
export { convertTaskYaml, type ConvertOptions } from './convert.ts';

// Phase 4: plugins and bindings (docs/memwise/22-phase-4-interfaces.md).
export { parsePluginManifest, pluginManifestToYaml, isSemver, compareSemver, SEMVER_PATTERN } from './plugin-manifest.ts';
export { importClaudePlugin, withDiscoveredTools, slugifyName, singular, type DiscoveredTool } from './claude-import.ts';
export { loadPlugin, loadInstalledPlugins, newestPlugins, installPlugin, pluginsDirOf, pluginFiles } from './plugins.ts';
export { parseBindingFile, bindingToYaml, pluginSlug, pluginIdOfSlug, bindingPath, toTransform } from './binding-file.ts';
export { resolveWorkflow, resolvePluginPolicy, bindingRenames, snakeName, domainToolName, type BindingRenames } from './resolve.ts';
export { boundPluginTools, checkBindings, RESERVED_TOOL_PREFIXES, stricterClass, type BoundPluginTool } from './binding-checks.ts';
export { proposeBinding, matchField, type ProposeBindingInput } from './propose.ts';
export { compileRecordMapping, applyTransform, mapField, roundTripProblem, valueAt, fillTemplate } from './mapping.ts';
export { matchRecord, nameSimilarity, normaliseKey, jaroWinkler } from './identity.ts';
