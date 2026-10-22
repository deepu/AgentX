/**
 * What the screens inside the project shell need from it. A page that would open a chat in a new
 * panel (a step's chat, "Ask in chat" on a record) shows it in the chat column instead.
 */

import * as React from 'react'

export interface ProjectShellContextValue {
  projectId: string
  /** The project's name ("Study MW-301"), for words like "MW-301's own copy". */
  projectName?: string
  /** Show this chat in the chat column (until the person opens another page). */
  showChat: (sessionId: string) => void
}

export const ProjectShellContext = React.createContext<ProjectShellContextValue | null>(null)

/** The project a case started here runs in: the shell's, unless it shows every project (`*`). */
export function shellStartProject(shell: ProjectShellContextValue | null): string | undefined {
  return shell && shell.projectId !== '*' ? shell.projectId : undefined
}

/** The shell around this screen, or null when it isn't inside one (the classic layout). */
export function useProjectShell(): ProjectShellContextValue | null {
  return React.useContext(ProjectShellContext)
}
