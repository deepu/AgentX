/**
 * Stage 6 (docs/memwise/26-projects-and-pages.md §9): EDC and a study across apps.
 *
 * - `memwise:edc:home` → MwEdcHome: the EDC study home (XEdcHome): what Rave says about the study,
 *   when it was last read, what waits for the viewer, randomised against target by site.
 * - `memwise:study:apps` → MwStudyApps: "Also in other apps": the same study in the other apps.
 * - `memwise:records:linked` → MwLinkedRecord[]: the same record in the other apps (XSite), each
 *   fact tagged with the app that owns it, shown read only here with a jump to its owner.
 */
import type { MwInboxItem, MwRecordField, MwRecordRef } from './memwise'

/** A connector read on a schedule (D110): when, what it found, and the last error. */
export interface MwSourceSync {
  plugin: string
  title?: string
  /** The last read that finished (ISO). */
  at?: string
  nextDue?: string
  error?: string
  errorAt?: string
  counts?: Record<string, number>
}

export interface MwEdcHomeInput {
  /** The project (Stage 3), or until projects exist, the study key ("MW-301"). */
  projectId: string
  /** The EDC app's domain id; default `edc`. */
  domain?: string
}

/** One thing waiting for the viewer from an EDC playbook, grouped by case. */
export interface MwEdcWaiting {
  kind: MwInboxItem['kind']
  caseId?: string
  workflowId?: string
  workflowTitle?: string
  /** Items of this kind in this case (five reminder emails to approve). */
  count: number
  since: string
  dueAt?: string
}

export interface MwEdcSiteProgress {
  site: MwRecordRef
  number: string
  randomised: number
  target?: number
  /** Randomised as a percent of target (absent without a target). */
  percent?: number
  openQueries: number
  oldQueries: number
}

export interface MwEdcHome {
  /** The EDC domain (app) this home reads. */
  domain: string
  study: { key: string; name?: string; record?: MwRecordRef }
  /** The Rave connection: read only, last read at. Null when no connector reads this domain. */
  source: MwSourceSync | null
  randomised: { value: number; target?: number; plannedByNow?: number }
  queries: { open: number; old: number; olderThanDays: number }
  /** Percent of entered pages source-verified, across the study's sites. */
  pagesVerified: number | null
  waiting: { total: number; items: MwEdcWaiting[] }
  /** Randomised against target, by site, behind first. */
  sites: MwEdcSiteProgress[]
}

export interface MwStudyAppsInput {
  projectId: string
  /** The app the viewer is in; it is left out of the answer. */
  domain?: string
}

/** The same study in one other app. */
export interface MwStudyApp {
  domain: string
  domainName: string
  /** The study's record in that app, when it has one. */
  record?: MwRecordRef
  /** A few headline facts of that record (its calculated values: "98% filed"). */
  facts: { name: string; label: string; type: string; value: unknown }[]
  /** What the two apps share, by link (D71): entity titles, plural ("Sites"). */
  shares: string[]
  /** The project of that app naming the same study (Stage 6 Part B), which the record opens in. */
  project?: { id: string; name: string }
}

export interface MwStudyApps {
  study: { key: string }
  apps: MwStudyApp[]
}

export interface MwLinkedRecordsInput { entity: string; id: string }

/** The same record in another app, paired by key (D71), with the facts that app owns. */
export interface MwLinkedRecord {
  domain: string
  domainName: string
  entity: string
  id: string
  title: string
  status?: string
  /** Its own facts (not those it follows from here): read only here, owned by `domain`. */
  fields: MwRecordField[]
}
