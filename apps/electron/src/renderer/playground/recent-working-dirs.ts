export type RecentDirScenario = 'none' | 'few' | 'many'

const RECENT_DIR_SCENARIO_DATA: Record<RecentDirScenario, string[]> = {
  none: [],
  few: [
    '/Users/demo/projects/memwise',
    '/Users/demo/projects/memwise/apps/electron',
    '/Users/demo/projects/memwise/packages/shared',
  ],
  many: [
    '/Users/demo/projects/memwise',
    '/Users/demo/projects/memwise/apps/electron',
    '/Users/demo/projects/memwise/apps/viewer',
    '/Users/demo/projects/memwise/apps/cli',
    '/Users/demo/projects/memwise/packages/shared',
    '/Users/demo/projects/memwise/packages/server-core',
    '/Users/demo/projects/memwise/packages/pi-agent-server',
    '/Users/demo/projects/memwise/packages/ui',
    '/Users/demo/projects/memwise/scripts',
  ],
}

/** Return a copy of the fixture list for the selected scenario. */
export function getRecentDirsForScenario(scenario: RecentDirScenario): string[] {
  return [...RECENT_DIR_SCENARIO_DATA[scenario]]
}
