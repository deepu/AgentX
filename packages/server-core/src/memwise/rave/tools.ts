/**
 * The Medidata Rave plugin's tools (`examples/plugins/medidata-rave`, 26 §9), as builtins for its
 * `run: { builtin }` routes. Every one only reads (`read`): sites with their investigator and
 * coordinator, subjects, queries with their age, form status. Records carry a `Ref`
 * (`MW-301(Prod)/104`, `MW-301(Prod)/104-007`, `MW-301(Prod)/Q50001`) that names them across
 * studies; the `get_*` tools take it, so a binding's read-through and identity links use it.
 *
 * Settings come from the gateway's secrets when it injects them, else this process's environment
 * (`RAVE_URL`, `RAVE_USER`, `RAVE_PASSWORD`, optional `RAVE_STUDY`): the connection is set up once
 * for the workspace and every project's binding uses it, so nobody types the credentials again.
 */
import type { ToolContext, ToolDefinition } from '@memwise/gateway'
import { raveClient, RaveError, type RaveClient, type RaveFormStatus, type RaveQuery, type RaveSettings, type RaveSite, type RaveStudy, type RaveSubject, type RaveUser } from './client'

export const RAVE_PLUGIN = 'memwise/medidata-rave'
/** Builtin names (`run: { builtin: … }`), one per plugin tool. */
export const RAVE_BUILTINS = {
  listStudies: 'rave.rws.list_studies',
  listSites: 'rave.rws.list_sites',
  getSite: 'rave.rws.get_site',
  siteStaff: 'rave.rws.site_staff',
  listSubjects: 'rave.rws.list_subjects',
  getSubject: 'rave.rws.get_subject',
  listQueries: 'rave.rws.list_queries',
  getQuery: 'rave.rws.get_query',
  formStatus: 'rave.rws.form_status',
} as const

export interface RaveToolsOptions {
  /** Where settings come from when the gateway injects none; default `process.env`. */
  env?: Record<string, string | undefined>
  /** Tests: the fetch the client calls. */
  fetch?: typeof fetch
  /** Tests: today, for query ages. */
  now?: () => Date
}

type Setting = (name: string) => string | undefined

/** Rave settings, or plain words on what is missing. */
export function raveSettings(get: Setting): RaveSettings {
  const url = get('RAVE_URL')
  const user = get('RAVE_USER')
  const password = get('RAVE_PASSWORD')
  const missing = [!url && 'RAVE_URL', !user && 'RAVE_USER', !password && 'RAVE_PASSWORD'].filter(Boolean) as string[]
  if (missing.length) throw new Error(`Medidata Rave is not connected: set ${missing.join(', ')} (see the medidata-rave plugin's README).`)
  const study = get('RAVE_STUDY')
  return { url: url!, user: user!, password: password!, ...(study ? { study } : {}) }
}

// ---------------------------------------------------------------- records as the plugin gives them

const DAY = 86_400_000
const dayOf = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
/** Whole days from a `YYYY-MM-DD` date to today. */
export function ageInDays(date: string, now: Date): number {
  const t = Date.parse(`${date.slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(t) ? 0 : Math.max(0, Math.round((dayOf(now) - t) / DAY))
}

const ref = (study: string, id: string) => `${study}/${id}`
/** `MW-301(Prod)/104-007` → study and id. */
export function parseRef(value: string, what: string): { study: string; id: string } {
  const at = value.lastIndexOf('/')
  if (at <= 0 || at === value.length - 1) throw new Error(`${what} should be a Rave reference like MW-301(Prod)/104, not ${JSON.stringify(value)}`)
  return { study: value.slice(0, at), id: value.slice(at + 1) }
}

const personName = (u: RaveUser) => [u.Title, u.FirstName, u.LastName].filter(Boolean).join(' ')

export interface SiteRecord {
  Ref: string; StudyOID: string; Study: string; SiteNumber: string; SiteName: string; City?: string; Country?: string; Status: string;
  EnrollmentTarget?: number; ActivatedDate?: string;
  Investigator?: string; InvestigatorEmail?: string; Coordinator?: string; CoordinatorEmail?: string; CoordinatorSince?: string;
  PagesEntered?: number; PagesVerified?: number; PagesVerifiedPercent?: number; PagesOverdue?: number;
}

function siteRecord(study: RaveStudy, s: RaveSite, users: RaveUser[], forms?: RaveFormStatus): SiteRecord {
  const active = users.filter((u) => u.Active && u.SiteNumber === s.SiteNumber)
  const pi = active.find((u) => u.Role === 'Investigator')
  // The coordinator who started last, when a site has two for a while.
  const crc = active.filter((u) => u.Role === 'Study Coordinator').sort((a, b) => (b.StartDate ?? '').localeCompare(a.StartDate ?? ''))[0]
  return {
    Ref: ref(s.StudyOID, s.SiteNumber), StudyOID: s.StudyOID, Study: study.ProtocolName, SiteNumber: s.SiteNumber, SiteName: s.SiteName,
    ...(s.City ? { City: s.City } : {}), ...(s.Country ? { Country: s.Country } : {}), Status: s.Status,
    ...(s.EnrollmentTarget !== undefined ? { EnrollmentTarget: s.EnrollmentTarget } : {}), ...(s.ActivatedDate ? { ActivatedDate: s.ActivatedDate } : {}),
    ...(pi ? { Investigator: personName(pi), InvestigatorEmail: pi.Email } : {}),
    ...(crc ? { Coordinator: personName(crc), CoordinatorEmail: crc.Email, ...(crc.StartDate ? { CoordinatorSince: crc.StartDate } : {}) } : {}),
    ...(forms ? {
      PagesEntered: forms.PagesEntered, PagesVerified: forms.PagesVerified, PagesOverdue: forms.PagesOverdue,
      PagesVerifiedPercent: forms.PagesEntered ? Math.round((forms.PagesVerified / forms.PagesEntered) * 1000) / 10 : 0,
    } : {}),
  }
}

function subjectRecord(study: RaveStudy, s: RaveSubject) {
  return { Ref: ref(s.StudyOID, s.SubjectKey), SiteRef: ref(s.StudyOID, s.SiteNumber), Study: study.ProtocolName, ...s }
}

function queryRecord(study: RaveStudy, q: RaveQuery, now: Date) {
  return {
    Ref: ref(q.StudyOID, `Q${q.QueryId}`), SiteRef: ref(q.StudyOID, q.SiteNumber), SubjectRef: ref(q.StudyOID, q.SubjectKey), Study: study.ProtocolName, ...q,
    // Days open: to today while it is open, else to the day it closed.
    AgeDays: q.Status === 'Open' || !q.ClosedDate ? ageInDays(q.OpenedDate, now) : ageInDays(q.OpenedDate, new Date(`${q.ClosedDate}T00:00:00Z`)),
  }
}

// ---------------------------------------------------------------- the tools

const str = { type: 'string' } as const
const studyArg = { ...str, description: 'The study: its OID (MW-301(Prod)) or protocol name (MW-301). Default: the connection\'s study, else every study this account sees.' }
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })

export function raveTools(opts: RaveToolsOptions = {}): ToolDefinition[] {
  const env = opts.env ?? process.env
  const now = opts.now ?? (() => new Date())
  const settingsOf = (ctx: ToolContext): RaveSettings => raveSettings((name) => {
    const v = ctx.secrets?.[name] ?? env[name]
    return v === undefined || v === '' ? undefined : v
  })
  const clientOf = (ctx: ToolContext): { client: RaveClient; settings: RaveSettings } => {
    const settings = settingsOf(ctx)
    return { client: raveClient(settings, { ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) }), settings }
  }

  /** The studies a call is about: the one named, else the connection's, else all. */
  async function studiesFor(client: RaveClient, settings: RaveSettings, named?: string): Promise<RaveStudy[]> {
    const all = await client.studies()
    const want = named ?? settings.study
    if (!want) return all
    const found = all.filter((s) => s.StudyOID === want || s.ProtocolName === want)
    // A protocol in several environments: Prod first.
    const pick = found.find((s) => s.Environment === 'Prod') ?? found[0]
    if (!pick) throw new RaveError(`Medidata Rave has no study ${want} for this account (it sees ${all.map((s) => s.StudyOID).join(', ') || 'none'})`)
    return [pick]
  }
  async function studyOf(client: RaveClient, oid: string): Promise<RaveStudy> {
    const s = (await client.studies()).find((x) => x.StudyOID === oid)
    if (!s) throw new RaveError(`Medidata Rave has no study ${oid} for this account`)
    return s
  }
  /** A site argument: a Ref, or a bare site number within the named study. */
  const siteNumber = (site: string | undefined) => (site && site.includes('/') ? parseRef(site, 'site').id : site)

  const source = { plugin: RAVE_PLUGIN }
  const tool = <A,>(name: string, description: string, inputSchema: Record<string, unknown>, execute: (args: A, ctx: ToolContext) => Promise<unknown>): ToolDefinition<A> =>
    ({ name, description, inputSchema, effect: 'read', idempotent: true, source, execute })

  return [
    tool<Record<string, never>>(RAVE_BUILTINS.listStudies, 'List the studies this Rave account can see, with their enrolment target and plan.', object({}),
      async (_args, ctx) => {
        const { client } = clientOf(ctx)
        return { studies: (await client.studies()).map((s) => ({ ...s, Study: s.ProtocolName })) }
      }),

    tool<{ study?: string }>(RAVE_BUILTINS.listSites, "List a study's sites with their principal investigator, study coordinator (and since when), enrolment target and how many entered pages are source-verified.",
      object({ study: studyArg }), async ({ study }, ctx) => {
        const { client, settings } = clientOf(ctx)
        const sites: SiteRecord[] = []
        for (const s of await studiesFor(client, settings, study)) {
          const [list, forms] = await Promise.all([client.sites(s.StudyOID), client.formStatus(s.StudyOID)])
          for (const site of list) {
            const users = await client.users(s.StudyOID, site.SiteNumber)
            sites.push(siteRecord(s, site, users, forms.find((f) => f.SiteNumber === site.SiteNumber)))
          }
        }
        return { sites }
      }),

    tool<{ site: string }>(RAVE_BUILTINS.getSite, 'Read one site by its Rave reference (MW-301(Prod)/104).', object({ site: { ...str, description: 'The site reference, e.g. MW-301(Prod)/104' } }, ['site']),
      async ({ site }, ctx) => {
        const { client } = clientOf(ctx)
        const { study, id } = parseRef(site, 'site')
        const [s, users, forms, st] = await Promise.all([client.site(study, id), client.users(study, id), client.formStatus(study, id), studyOf(client, study)])
        return { site: siteRecord(st, s, users, forms[0]) }
      }),

    tool<{ site: string; all?: boolean }>(RAVE_BUILTINS.siteStaff, "A site's staff in Rave: investigators and coordinators, with their role, email and start date.",
      object({ site: { ...str, description: 'The site reference, e.g. MW-301(Prod)/104' }, all: { type: 'boolean', description: 'Also people no longer active at the site' } }, ['site']),
      async ({ site, all }, ctx) => {
        const { client } = clientOf(ctx)
        const { study, id } = parseRef(site, 'site')
        const users = (await client.users(study, id)).filter((u) => all || u.Active)
        return { staff: users.map((u) => ({ Name: personName(u), Email: u.Email, Role: u.Role, Active: u.Active, ...(u.StartDate ? { Since: u.StartDate } : {}) })) }
      }),

    tool<{ study?: string; site?: string }>(RAVE_BUILTINS.listSubjects, 'List the subjects of a study (or of one site), with when they were randomised and their last visit.',
      object({ study: studyArg, site: { ...str, description: 'Only this site: its number (104) or reference' } }), async ({ study, site }, ctx) => {
        const { client, settings } = clientOf(ctx)
        const named = study ?? (site?.includes('/') ? parseRef(site, 'site').study : undefined)
        const subjects = []
        for (const s of await studiesFor(client, settings, named)) {
          for (const x of await client.subjects(s.StudyOID, siteNumber(site))) subjects.push(subjectRecord(s, x))
        }
        return { subjects, total: subjects.length }
      }),

    tool<{ subject: string }>(RAVE_BUILTINS.getSubject, 'Read one subject by its Rave reference (MW-301(Prod)/104-007).', object({ subject: { ...str, description: 'The subject reference' } }, ['subject']),
      async ({ subject }, ctx) => {
        const { client } = clientOf(ctx)
        const { study, id } = parseRef(subject, 'subject')
        const [x, st] = await Promise.all([client.subject(study, id), studyOf(client, study)])
        return { subject: subjectRecord(st, x) }
      }),

    tool<{ study?: string; site?: string; status?: string; older_than_days?: number }>(RAVE_BUILTINS.listQueries,
      'List data queries: who they are about (site, subject, visit, form, field), what they ask, their status and how many days they have been open (AgeDays). Sites answer queries in Rave; this only reads them.',
      object({
        study: studyArg,
        site: { ...str, description: 'Only this site: its number (104) or reference' },
        status: { type: 'string', enum: ['open', 'answered', 'closed', 'all'], description: 'Default all' },
        older_than_days: { type: 'integer', description: 'Only queries open longer than this many days' },
      }), async ({ study, site, status, older_than_days }, ctx) => {
        const { client, settings } = clientOf(ctx)
        const named = study ?? (site?.includes('/') ? parseRef(site, 'site').study : undefined)
        const today = now()
        const queries = []
        for (const s of await studiesFor(client, settings, named)) {
          const list = await client.queries(s.StudyOID, { ...(siteNumber(site) ? { site: siteNumber(site)! } : {}), ...(status && status !== 'all' ? { status: status[0]!.toUpperCase() + status.slice(1) } : {}) })
          for (const q of list) {
            const r = queryRecord(s, q, today)
            if (older_than_days === undefined || r.AgeDays > older_than_days) queries.push(r)
          }
        }
        return { queries, total: queries.length }
      }),

    tool<{ query: string }>(RAVE_BUILTINS.getQuery, 'Read one query by its Rave reference (MW-301(Prod)/Q50001).', object({ query: { ...str, description: 'The query reference' } }, ['query']),
      async ({ query }, ctx) => {
        const { client } = clientOf(ctx)
        const { study, id } = parseRef(query, 'query')
        const [q, st] = await Promise.all([client.query(study, id.replace(/^Q/, '')), studyOf(client, study)])
        return { query: queryRecord(st, q, now()) }
      }),

    tool<{ study?: string; site?: string }>(RAVE_BUILTINS.formStatus, 'Form status per site: pages entered, source-verified and overdue, and the percent verified, with totals for the study.',
      object({ study: studyArg, site: { ...str, description: 'Only this site: its number (104) or reference' } }), async ({ study, site }, ctx) => {
        const { client, settings } = clientOf(ctx)
        const named = study ?? (site?.includes('/') ? parseRef(site, 'site').study : undefined)
        const sites = []
        for (const s of await studiesFor(client, settings, named)) {
          for (const f of await client.formStatus(s.StudyOID, siteNumber(site))) {
            sites.push({ SiteRef: ref(s.StudyOID, f.SiteNumber), Study: s.ProtocolName, ...f, PercentVerified: f.PagesEntered ? Math.round((f.PagesVerified / f.PagesEntered) * 1000) / 10 : 0 })
          }
        }
        const entered = sites.reduce((n, s) => n + s.PagesEntered, 0)
        const verified = sites.reduce((n, s) => n + s.PagesVerified, 0)
        return { sites, totals: { PagesEntered: entered, PagesVerified: verified, PagesOverdue: sites.reduce((n, s) => n + s.PagesOverdue, 0), PercentVerified: entered ? Math.round((verified / entered) * 1000) / 10 : 0 } }
      }),
  ]
}
