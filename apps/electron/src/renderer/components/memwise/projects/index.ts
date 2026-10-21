/**
 * Stage 3, projects inside apps (docs/memwise/26-projects-and-pages.md §3): the screens the shell
 * mounts in the right column, their presentational views, where they navigate, and the hooks.
 */

export { AppHomeScreen, NewProjectScreen, ProjectSettingsScreen, TemplateUpdateScreen, WaitingAllScreen } from './ProjectScreens'
export { AppHomeView, type AppHomeViewProps } from './AppHomeView'
export { NewProjectView, DraftContents, StatusPill, type NewProjectViewProps, type NewProjectInput } from './NewProjectView'
export { ProjectSettingsView, type ProjectSettingsViewProps } from './ProjectSettingsView'
export { TemplateUpdateView, type TemplateUpdateViewProps } from './TemplateUpdateView'
export { WaitingAllView, type WaitingAllViewProps } from './WaitingAllView'
export { MwProjectsNavProvider, defaultProjectsNav, useProjectsNav, type MwProjectsNav } from './nav'
export {
  useMemwiseProjects,
  useMemwiseProject,
  useMemwiseAppHome,
  useMemwiseWaitingAll,
  useMemwiseTemplateReview,
  useMemwiseProjectCalls,
  waitingTotal,
  type MemwiseProjects,
  type MemwiseProjectCalls,
} from '@/hooks/useMemwiseProjects'
