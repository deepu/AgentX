/**
 * Where the Stage 3 screens go when someone opens something (a project, an item, a chat). The
 * shell provides the routes (`mw/<projectId>/…`, and `mw/` + `*` + `/waiting` for every project) through MwProjectsNavProvider;
 * without one, items open in Waiting for you and chats beside the page, and the rest do nothing.
 */

import * as React from 'react'
import type { MwInboxItem } from '@memwise/shared/protocol'
import { navigate, routes } from '@/lib/navigate'

export interface MwProjectsNav {
  /** A project's home. */
  openProject(projectId: string): void
  /** The app home ("TMF across studies"). */
  openAppHome(appId: string): void
  /** One waiting item. */
  openItem(item: MwInboxItem): void
  /** "Review template update" for a project. */
  openTemplateUpdate(projectId: string, inboxItemId: string): void
  /** Project settings. */
  openSettings(projectId: string): void
  /** A chat, beside the page. */
  openChat(sessionId: string): void
}

export const defaultProjectsNav: MwProjectsNav = {
  openProject: () => {},
  openAppHome: () => {},
  openItem: (item) => navigate(routes.view.inbox(item.id)),
  openTemplateUpdate: () => {},
  openSettings: () => {},
  openChat: (sessionId) => navigate(routes.view.allSessions(sessionId), { newPanel: true }),
}

const NavContext = React.createContext<MwProjectsNav>(defaultProjectsNav)

export function MwProjectsNavProvider({ nav, children }: { nav: Partial<MwProjectsNav>; children: React.ReactNode }) {
  const value = React.useMemo(() => ({ ...defaultProjectsNav, ...nav }), [nav])
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>
}

export function useProjectsNav(): MwProjectsNav {
  return React.useContext(NavContext)
}
