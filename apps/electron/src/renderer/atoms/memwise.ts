/**
 * MemWise screen state: the lists the sidebar and navigator show (inbox, cases, playbooks),
 * the kernel status and people, and the last pushed change so open detail views can refetch.
 * Filled by useMemwiseData (mounted once by MemwiseHost in the app shell).
 */

import { atom } from 'jotai'
import type {
  MwCaseSummary,
  MwChange,
  MwDomain,
  MwDraftSummary,
  MwEntityType,
  MwInboxItem,
  MwPerson,
  MwPlaybookSummary,
  MwPluginSummary,
  MwRole,
  MwStatus,
} from '@memwise/shared/protocol'
import type { CaseFilter } from '@/components/memwise/format'

/** Workspace the lists below belong to. */
export const memwiseWorkspaceIdAtom = atom<string | null>(null)

/** Null until the first status call returns (or when the host has no MemWise API). */
export const memwiseStatusAtom = atom<MwStatus | null>(null)

/** False when this host (an older server, say) has no MemWise methods at all. */
export const memwiseAvailableAtom = atom<boolean>(true)

export const memwisePeopleAtom = atom<MwPerson[]>([])
export const memwiseRolesAtom = atom<MwRole[]>([])

/** Null while loading for the first time. */
export const memwiseInboxAtom = atom<MwInboxItem[] | null>(null)
export const memwiseCasesAtom = atom<MwCaseSummary[] | null>(null)
export const memwisePlaybooksAtom = atom<MwPlaybookSummary[] | null>(null)
/** Every draft (Phase 3); the screens show the open ones. Null while loading, or when the host has no drafts. */
export const memwiseDraftsAtom = atom<MwDraftSummary[] | null>(null)

/** Installed plugins (Phase 4). Null while loading, or when the host has no plugins API. */
export const memwisePluginsAtom = atom<MwPluginSummary[] | null>(null)
/** The domain's entity types, for the Records group under Plugins (Phase 4). */
export const memwiseEntityTypesAtom = atom<MwEntityType[] | null>(null)
/** Phase 6: the project's domains, for the sidebar's Domains section and the domain filters. Null while loading; empty when the host has no domains API. */
export const memwiseDomainsAtom = atom<MwDomain[] | null>(null)
/** Phase 6: the domain filter on the cross-domain lists (inbox, cases, playbooks); null shows every domain. */
export const memwiseDomainFilterAtom = atom<string | null>(null)
/** Phase 6: "Review in a row": after each decision the inbox opens the next document review of the same kind. */
export const memwiseReviewQueueAtom = atom<{ active: boolean; workflowId?: string; stepTitle?: string } >({ active: false })
/** The "Install a plugin" dialog. */
export const memwiseInstallPluginDialogAtom = atom<boolean>(false)

/** The last `memwise:changed` push, with a sequence number so equal payloads still notify. */
export const memwiseLastChangeAtom = atom<{ seq: number; change: MwChange } | null>(null)

/** Cases list filter (playbook, status). */
export const memwiseCaseFilterAtom = atom<CaseFilter>({})

/** The "New playbook" dialog (asks what it should do, then opens the chat that builds it). */
export const memwiseNewPlaybookDialogAtom = atom<boolean>(false)

/** The tab a draft opens on the next time it is shown (Edit opens the steps). */
export const memwiseDraftOpenTabAtom = atom<{ draftId: string; tab: 'changes' | 'steps' | 'map' | 'checks' | 'history' } | null>(null)

/** The "Start a case" dialog, openable from the cases list and a playbook. */
export const memwiseStartCaseDialogAtom = atom<{ open: boolean; workflowId?: string }>({ open: false })

/**
 * The connection advertised only the person channels (set by App once it has connected): a
 * person signed in with their own account on a server, so only the playbook screens work.
 */
export const memwisePersonConnectionAtom = atom<boolean>(false)

/** Only the playbook screens are available (a person's own sign-in): chats, sources and most settings are hidden. */
export const memwisePeopleOnlyAtom = atom(get => get(memwisePersonConnectionAtom) || get(memwiseStatusAtom)?.signedIn === true)

/** Items waiting on the acting person: the sidebar's Inbox badge. */
export const memwiseInboxCountAtom = atom(get => get(memwiseInboxAtom)?.length ?? 0)
