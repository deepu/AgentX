/**
 * A read-only client of Medidata Rave Web Services (RWS) for the EDC app (docs/memwise/26 §9,
 * D96): studies, sites with their staff, subjects, queries and form status, signed in with HTTP
 * Basic as RWS is. Only GET is ever sent: data entry stays in Rave.
 *
 * The paths are RWS's (`/RaveWebServices/studies/{StudyOID}/…`); the bodies are the JSON the fake
 * (`packages/runtime/tests/fixtures/fake-rave-http.ts`) serves, with ODM-style names. A real
 * Rave answers ODM XML and clinical-view datasets; this file is the one place to change when a
 * sandbox is available to check against (26 §11, "Needs Sandeep").
 */

export interface RaveSettings {
  /** The RWS base, `https://<tenant>.mdsol.com/RaveWebServices`. */
  url: string;
  user: string;
  password: string;
  /** The study OID tools default to (`MW-301(Prod)`); absent = every study the account sees. */
  study?: string;
}

export class RaveError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

export interface RaveStudy { StudyOID: string; ProtocolName: string; Environment: string; StudyName: string; EnrollmentTarget?: number; PlannedByNow?: number }
export interface RaveSite { StudyOID: string; SiteNumber: string; LocationOID?: string; SiteName: string; City?: string; Country?: string; Status: string; EnrollmentTarget?: number; ActivatedDate?: string }
export interface RaveUser { StudyOID: string; SiteNumber: string; Login: string; FirstName: string; LastName: string; Title?: string; Email: string; Role: string; Active: boolean; StartDate?: string }
export interface RaveSubject { StudyOID: string; SiteNumber: string; SubjectKey: string; Status: string; RandomisedDate?: string; LastVisit?: string; LastVisitDate?: string }
export interface RaveQuery {
  StudyOID: string; QueryId: number; SiteNumber: string; SubjectKey: string; Folder: string; Form: string; Field: string;
  QueryText: string; MarkingGroup?: string; Status: string; OpenedDate: string; ClosedDate?: string;
}
export interface RaveFormStatus { StudyOID: string; SiteNumber: string; PagesEntered: number; PagesVerified: number; PagesOverdue: number }

export interface RaveClient {
  studies(): Promise<RaveStudy[]>;
  sites(study: string): Promise<RaveSite[]>;
  site(study: string, site: string): Promise<RaveSite>;
  /** A site's users, or with no site every user of the study (one read for all its sites). */
  users(study: string, site?: string): Promise<RaveUser[]>;
  subjects(study: string, site?: string): Promise<RaveSubject[]>;
  subject(study: string, key: string): Promise<RaveSubject>;
  queries(study: string, opts?: { site?: string; status?: string }): Promise<RaveQuery[]>;
  query(study: string, id: string): Promise<RaveQuery>;
  formStatus(study: string, site?: string): Promise<RaveFormStatus[]>;
}

export function raveClient(settings: RaveSettings, opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}): RaveClient {
  const doFetch = opts.fetch ?? fetch
  const base = settings.url.replace(/\/+$/, '')
  const auth = `Basic ${Buffer.from(`${settings.user}:${settings.password}`).toString('base64')}`
  const study = (oid: string) => `studies/${encodeURIComponent(oid)}`

  async function get<T>(path: string, query: Record<string, string | undefined> = {}): Promise<T> {
    const qs = Object.entries(query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`).join('&')
    const url = `${base}/${path}${qs ? `?${qs}` : ''}`
    let res: Response
    try {
      res = await doFetch(url, { method: 'GET', headers: { authorization: auth, accept: 'application/json' }, ...(opts.signal ? { signal: opts.signal } : {}) })
    } catch (e) {
      throw new RaveError(`Medidata Rave could not be reached at ${base}: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (res.status === 401 || res.status === 403) throw new RaveError('Medidata Rave refused the sign-in: check RAVE_USER and RAVE_PASSWORD (the Rave account needs Web Services access).', res.status)
    const text = await res.text()
    let body: unknown
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    if (!res.ok) {
      const said = body && typeof body === 'object' ? (body as { ErrorDescription?: string }).ErrorDescription : undefined
      throw new RaveError(`Medidata Rave answered ${res.status}${said ? `: ${said}` : ''}`, res.status)
    }
    return body as T
  }

  return {
    studies: async () => (await get<{ studies: RaveStudy[] }>('studies')).studies,
    sites: async (oid) => (await get<{ sites: RaveSite[] }>(`${study(oid)}/sites`)).sites,
    site: async (oid, site) => (await get<{ site: RaveSite }>(`${study(oid)}/sites/${encodeURIComponent(site)}`)).site,
    users: async (oid, site) => (await get<{ users: RaveUser[] }>(site ? `${study(oid)}/sites/${encodeURIComponent(site)}/users` : `${study(oid)}/users`)).users,
    subjects: async (oid, site) => (await get<{ subjects: RaveSubject[] }>(`${study(oid)}/subjects`, { SiteNumber: site })).subjects,
    subject: async (oid, key) => (await get<{ subject: RaveSubject }>(`${study(oid)}/subjects/${encodeURIComponent(key)}`)).subject,
    queries: async (oid, o = {}) => (await get<{ queries: RaveQuery[] }>(`${study(oid)}/queries`, { SiteNumber: o.site, Status: o.status })).queries,
    query: async (oid, id) => (await get<{ query: RaveQuery }>(`${study(oid)}/queries/${encodeURIComponent(id)}`)).query,
    formStatus: async (oid, site) => (await get<{ sites: RaveFormStatus[] }>(`${study(oid)}/formstatus`, { SiteNumber: site })).sites,
  }
}
