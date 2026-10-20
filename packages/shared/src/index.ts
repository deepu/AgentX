/**
 * @memwise/shared
 *
 * Shared business logic for MemWise.
 * Used by the Electron app.
 *
 * Import specific modules via subpath exports:
 *   import { MemWiseAgent } from '@memwise/shared/agent';
 *   import { loadStoredConfig } from '@memwise/shared/config';
 *   import { getCredentialManager } from '@memwise/shared/credentials';
 *   import { MemWiseMcpClient } from '@memwise/shared/mcp';
 *   import { debug } from '@memwise/shared/utils';
 *   import { loadSource, createSource, getSourceCredentialManager } from '@memwise/shared/sources';
 *   import { createWorkspace, loadWorkspace } from '@memwise/shared/workspaces';
 *
 * Available modules:
 *   - agent: MemWiseAgent SDK wrapper, plan tools
 *   - auth: OAuth, token management, auth state
 *   - clients: Craft API client
 *   - config: Storage, models, preferences
 *   - credentials: Encrypted credential storage
 *   - mcp: MCP client, connection validation
 *   - prompts: System prompt generation
 *   - sources: Workspace-scoped source management (MCP, API, local)
 *   - utils: Debug logging, file handling, summarization
 *   - validation: URL validation
 *   - version: Version and installation management
 *   - workspaces: Workspace management (top-level organizational unit)
 */

// Export branding (standalone, no dependencies)
export * from './branding.ts';
