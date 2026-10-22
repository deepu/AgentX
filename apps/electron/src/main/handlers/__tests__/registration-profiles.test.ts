import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { RpcServer } from '@memwise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

const registeredChannels: string[] = []

mock.module('electron', () => ({
  ipcMain: {
    handle: () => {},
    on: () => {},
  },
  app: {
    isPackaged: false,
    getAppPath: () => '/',
    quit: () => {},
    dock: { setIcon: () => {}, setBadge: () => {} },
  },
  nativeTheme: { shouldUseDarkColors: false },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createFromDataURL: () => ({}),
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showMessageBox: async () => ({ response: 0 }),
  },
  shell: {
    openExternal: async () => {},
    openPath: async () => '',
    showItemInFolder: () => {},
  },
  BrowserWindow: {
    fromWebContents: () => null,
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
  BrowserView: class {},
  Menu: {
    buildFromTemplate: () => ({ popup: () => {} }),
  },
  session: {},
}))

function createMockServer(): RpcServer {
  return {
    handle(channel: string, _handler: unknown) {
      registeredChannels.push(channel)
    },
    push() {},
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
}

function createMockDeps(): HandlerDeps {
  return {
    sessionManager: {} as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: console,
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
    windowManager: {} as HandlerDeps['windowManager'],
    browserPaneManager: {
      onStateChange: () => {},
      onRemoved: () => {},
      onInteracted: () => {},
    } as unknown as NonNullable<HandlerDeps['browserPaneManager']>,
    oauthFlowStore: {
      store: () => {},
      getByState: () => null,
      remove: () => {},
      cleanup: () => {},
      dispose: () => {},
      size: 0,
    } as unknown as HandlerDeps['oauthFlowStore'],
  }
}

async function getExpectedCoreChannels(): Promise<Set<string>> {
  // Core handler channels (now in server-core)
  const [
    auth,
    automations,
    files,
    labels,
    llm,
    oauth,
    pages,
    projects,
    sessions,
    settings,
    skills,
    sources,
    statuses,
    system,
    tasks,
    workspace,
    onboarding,
    resources,
    transfer,
    decisions,
    memwise,
    memwiseRegulated,
  ] = await Promise.all([
    import('@memwise/server-core/handlers/rpc/auth'),
    import('@memwise/server-core/handlers/rpc/automations'),
    import('@memwise/server-core/handlers/rpc/files'),
    import('@memwise/server-core/handlers/rpc/labels'),
    import('@memwise/server-core/handlers/rpc/llm-connections'),
    import('@memwise/server-core/handlers/rpc/oauth'),
    import('@memwise/server-core/handlers/rpc/pages'),
    import('@memwise/server-core/handlers/rpc/projects'),
    import('@memwise/server-core/handlers/rpc/sessions'),
    import('@memwise/server-core/handlers/rpc/settings'),
    import('@memwise/server-core/handlers/rpc/skills'),
    import('@memwise/server-core/handlers/rpc/sources'),
    import('@memwise/server-core/handlers/rpc/statuses'),
    import('@memwise/server-core/handlers/rpc/system'),
    import('@memwise/server-core/handlers/rpc/tasks'),
    import('@memwise/server-core/handlers/rpc/workspace'),
    import('@memwise/server-core/handlers/rpc/onboarding'),
    import('@memwise/server-core/handlers/rpc/resources'),
    import('@memwise/server-core/handlers/rpc/transfer'),
    import('@memwise/server-core/handlers/rpc/decisions'),
    import('@memwise/server-core/handlers/rpc/memwise'),
    import('@memwise/server-core/handlers/rpc/memwise-regulated'),
  ])

  return new Set([
    ...auth.HANDLED_CHANNELS,
    ...automations.HANDLED_CHANNELS,
    ...files.HANDLED_CHANNELS,
    ...labels.HANDLED_CHANNELS,
    ...llm.HANDLED_CHANNELS,
    ...oauth.HANDLED_CHANNELS,
    ...projects.HANDLED_CHANNELS,
    ...pages.HANDLED_CHANNELS,
    ...sessions.HANDLED_CHANNELS,
    ...settings.HANDLED_CHANNELS,
    ...skills.HANDLED_CHANNELS,
    ...sources.HANDLED_CHANNELS,
    ...statuses.HANDLED_CHANNELS,
    ...system.CORE_HANDLED_CHANNELS,
    ...tasks.HANDLED_CHANNELS,
    ...workspace.CORE_HANDLED_CHANNELS,
    ...onboarding.HANDLED_CHANNELS,
    ...resources.HANDLED_CHANNELS,
    ...transfer.HANDLED_CHANNELS,
    ...decisions.HANDLED_CHANNELS,
    ...memwise.HANDLED_CHANNELS,
    ...memwiseRegulated.HANDLED_CHANNELS,
  ])
}

async function getExpectedGuiChannels(): Promise<Set<string>> {
  const [browser, system, workspace, settings] = await Promise.all([
    import('../browser'),
    import('../system'),
    import('../workspace'),
    import('../settings'),
  ])

  return new Set([
    ...browser.HANDLED_CHANNELS,
    ...system.GUI_HANDLED_CHANNELS,
    ...workspace.GUI_HANDLED_CHANNELS,
    ...settings.GUI_HANDLED_CHANNELS,
  ])
}

describe('RPC handler profile registration', () => {
  beforeEach(() => {
    registeredChannels.length = 0
  })

  it('registerCoreRpcHandlers registers only core channels', async () => {
    const expected = await getExpectedCoreChannels()
    const { registerCoreRpcHandlers } = await import('../index')

    registerCoreRpcHandlers(createMockServer(), createMockDeps())

    const actual = new Set(registeredChannels.filter(ch => ch.includes(':')))
    expect([...expected].filter(ch => !actual.has(ch))).toEqual([])
    expect([...actual].filter(ch => !expected.has(ch))).toEqual([])
  })

  it('registerGuiRpcHandlers registers only gui channels', async () => {
    const expected = await getExpectedGuiChannels()
    const { registerGuiRpcHandlers } = await import('../index')

    registerGuiRpcHandlers(createMockServer(), createMockDeps())

    const actual = new Set(registeredChannels.filter(ch => ch.includes(':')))
    expect([...expected].filter(ch => !actual.has(ch))).toEqual([])
    expect([...actual].filter(ch => !expected.has(ch))).toEqual([])
  })
})
