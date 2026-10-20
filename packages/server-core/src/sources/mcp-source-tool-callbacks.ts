/**
 * MCP Source Tool Callbacks
 *
 * Backend for the agent-facing source_list_resources / source_read_resource /
 * source_list_prompts / source_get_prompt session tools. SessionManager wires
 * one instance per session into the session-scoped tool callback registry
 * (next to `pages`).
 *
 * Every call reads the session's MCP pool and enabled sources at call time
 * (getOrCreateAgent replaces the pool when it recreates the agent) and only
 * reaches sources enabled in the session. The pool itself rejects sources that
 * are not connected, API sources and servers without the capability, and does
 * the protocol work (pagination, blob files, large-result guard). This module
 * maps its SDK objects onto the plain session-tools-core shapes.
 */

import type { McpClientPool, McpPromptListing, McpResourceListing } from '@memwise/shared/mcp'
import type {
  McpSourcePrompt,
  McpSourceResource,
  McpSourceResourceTemplate,
  McpSourceToolCallbacks,
} from '@memwise/session-tools-core'

/** The pool methods the callbacks use (a structural slice, so tests can pass a fake). */
export type McpSourcePool = Pick<McpClientPool, 'listResources' | 'readResource' | 'listPrompts' | 'getPrompt'>

export interface McpSourceToolCallbacksDeps {
  /** The session's MCP pool, read on every call. */
  getPool: () => McpSourcePool | undefined
  /** The session's enabled source slugs, read on every call. */
  getEnabledSourceSlugs: () => readonly string[] | undefined
}

// Only the fields an agent needs: icons, annotations and _meta would cost tokens for nothing.
function toResource(resource: McpResourceListing['resources'][number]): McpSourceResource {
  const { uri, name, title, description, mimeType, size } = resource
  return { uri, name, title, description, mimeType, size }
}

function toResourceTemplate(template: McpResourceListing['resourceTemplates'][number]): McpSourceResourceTemplate {
  const { uriTemplate, name, title, description, mimeType } = template
  return { uriTemplate, name, title, description, mimeType }
}

function toPrompt(prompt: McpPromptListing['prompts'][number]): McpSourcePrompt {
  const { name, title, description } = prompt
  return {
    name,
    title,
    description,
    arguments: prompt.arguments?.map(arg => ({ name: arg.name, description: arg.description, required: arg.required })),
  }
}

export function buildMcpSourceToolCallbacks(deps: McpSourceToolCallbacksDeps): McpSourceToolCallbacks {
  // The pool only holds the session's enabled sources; checking the slug here
  // also covers the moment a source change is still being applied to it.
  const poolFor = (sourceSlug: string): McpSourcePool => {
    const enabled = deps.getEnabledSourceSlugs() ?? []
    if (!enabled.includes(sourceSlug)) {
      throw new Error(enabled.length > 0
        ? `Source "${sourceSlug}" is not enabled in this session (enabled: ${enabled.join(', ')}).`
        : `Source "${sourceSlug}" is not enabled in this session (no sources are enabled).`)
    }
    const pool = deps.getPool()
    if (!pool) throw new Error(`Source "${sourceSlug}" is not connected yet.`)
    return pool
  }

  return {
    async listResources(sourceSlug) {
      const listing = await poolFor(sourceSlug).listResources(sourceSlug)
      return {
        resources: listing.resources.map(toResource),
        resourceTemplates: listing.resourceTemplates.map(toResourceTemplate),
        ...(listing.truncated ? { truncated: true } : {}),
      }
    },
    async readResource(sourceSlug, uri) {
      return poolFor(sourceSlug).readResource(sourceSlug, uri)
    },
    async listPrompts(sourceSlug) {
      const listing = await poolFor(sourceSlug).listPrompts(sourceSlug)
      return {
        prompts: listing.prompts.map(toPrompt),
        ...(listing.truncated ? { truncated: true } : {}),
      }
    },
    async getPrompt(sourceSlug, name, args) {
      return poolFor(sourceSlug).getPrompt(sourceSlug, name, args)
    },
  }
}
