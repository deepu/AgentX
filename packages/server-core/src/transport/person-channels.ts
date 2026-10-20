/**
 * What a person's own sign-in may call (19 §2). A personal token or a web login is for the
 * playbook screens only; the shared server token stays the machine/admin credential with the
 * whole API. Chats, sources, credentials and settings run with the server's own power, so a
 * person connection gets the `memwise:*` channels plus the few read-only calls the web shell
 * needs to boot and draw itself (setup check, workspace, theme, release notes).
 *
 * Enforced once, in WsRpcServer's request dispatch, and advertised in handshake_ack so the
 * renderer hides what would only be refused.
 */
import { RPC_CHANNELS } from '@memwise/shared/protocol'

const MEMWISE_PREFIX = 'memwise:'

/**
 * `memwise:*` channels a person may not call: an anchored chat is an agent session on the server,
 * and building a playbook opens one.
 */
const MEMWISE_EXCLUDED: ReadonlySet<string> = new Set([RPC_CHANNELS.memwise.CHAT_OPEN, RPC_CHANNELS.memwise.PLAYBOOKS_BUILD])

/** Read-only shell channels outside `memwise:*` (plus switching which workspace this connection follows). */
export const PERSON_SHELL_CHANNELS: ReadonlySet<string> = new Set<string>([
  // Boot: "is the app set up" decides between onboarding and the app; the workspace to show
  RPC_CHANNELS.onboarding.GET_AUTH_STATE,
  RPC_CHANNELS.workspaces.GET,
  RPC_CHANNELS.window.SWITCH_WORKSPACE,
  // Look: theme and appearance reads
  RPC_CHANNELS.theme.GET_APP,
  RPC_CHANNELS.theme.GET_PRESETS,
  RPC_CHANNELS.theme.LOAD_PRESET,
  RPC_CHANNELS.theme.GET_COLOR_THEME,
  RPC_CHANNELS.theme.GET_WORKSPACE_COLOR_THEME,
  RPC_CHANNELS.theme.GET_ALL_WORKSPACE_THEMES,
  RPC_CHANNELS.theme.GET_SYSTEM_PREFERENCE,
  RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS,
  RPC_CHANNELS.toolIcons.GET_MAPPINGS,
  RPC_CHANNELS.notification.GET_ENABLED,
  RPC_CHANNELS.input.GET_AUTO_CAPITALISATION,
  RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.GET_SPELL_CHECK,
  // About / What's New
  RPC_CHANNELS.system.VERSIONS,
  RPC_CHANNELS.releaseNotes.GET,
  RPC_CHANNELS.releaseNotes.GET_LATEST_VERSION,
])

/** Whether a connection signed in as a person may call this channel. */
export function personMayCall(channel: string): boolean {
  if (channel.startsWith(MEMWISE_PREFIX)) return !MEMWISE_EXCLUDED.has(channel)
  return PERSON_SHELL_CHANNELS.has(channel)
}
