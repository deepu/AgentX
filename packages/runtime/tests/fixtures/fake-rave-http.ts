// A fake of Medidata Rave Web Services (RWS) for the EDC app (26 §9, D96): read-only REST on a
// local port, HTTP Basic sign-in as RWS uses, answering from a fixture of study MW-301 (twelve
// sites, 186 randomised subjects, open queries of varying age, site staff, form status) and a
// small second study, MW-207. Everything in it is made up.
//
// The paths follow RWS (`/RaveWebServices/studies/{StudyOID}/…`, StudyOID `MW-301(Prod)`), but the
// bodies are JSON with ODM-style names (StudyOID, SiteNumber, SubjectKey) rather than the ODM XML
// and clinical-view CSV a real Rave returns; the plugin's adapter (server-core `memwise/rave/`) is
// the one place to change when this is checked against a real sandbox.
//
// Tests change the fixture while it runs (`fake.setCoordinator(...)`, `fake.data`); the
// walkthrough starts it on a port of its own:
//
//   bun packages/runtime/tests/fixtures/fake-rave-http.ts --port 4790 [--user rave --password rave]
//
// and changes it over HTTP: `POST /__fake/coordinator` with `{ study, site, name, email, since }`.

export interface FakeRaveStudy {
  StudyOID: string;
  ProtocolName: string;
  Environment: string;
  StudyName: string;
  EnrollmentTarget: number;
  /** Planned randomisations by today, for "plan was 190 by now". */
  PlannedByNow: number;
}

export interface FakeRaveSite {
  StudyOID: string;
  SiteNumber: string;
  LocationOID: string;
  SiteName: string;
  City: string;
  Country: string;
  Status: 'Active' | 'Inactive';
  EnrollmentTarget: number;
  ActivatedDate: string;
}

export interface FakeRaveUser {
  StudyOID: string;
  SiteNumber: string;
  Login: string;
  FirstName: string;
  LastName: string;
  Title?: string;
  Email: string;
  Role: 'Investigator' | 'Sub-Investigator' | 'Study Coordinator';
  Active: boolean;
  StartDate: string;
}

export interface FakeRaveSubject {
  StudyOID: string;
  SiteNumber: string;
  SubjectKey: string;
  Status: 'Randomised' | 'Completed' | 'Withdrawn';
  RandomisedDate: string;
  LastVisit: string;
  LastVisitDate: string;
}

export interface FakeRaveQuery {
  StudyOID: string;
  QueryId: number;
  SiteNumber: string;
  SubjectKey: string;
  Folder: string;
  Form: string;
  Field: string;
  QueryText: string;
  MarkingGroup: string;
  Status: 'Open' | 'Answered' | 'Closed';
  OpenedDate: string;
  ClosedDate?: string;
}

export interface FakeRaveFormStatus {
  StudyOID: string;
  SiteNumber: string;
  PagesEntered: number;
  PagesVerified: number;
  PagesOverdue: number;
}

export interface FakeRaveData {
  studies: FakeRaveStudy[];
  sites: FakeRaveSite[];
  users: FakeRaveUser[];
  subjects: FakeRaveSubject[];
  queries: FakeRaveQuery[];
  forms: FakeRaveFormStatus[];
}

export const MW301 = 'MW-301(Prod)';
export const MW207 = 'MW-207(Prod)';
export const FAKE_RAVE_USER = 'rave.reader';
export const FAKE_RAVE_PASSWORD = 'not-a-real-password';

const DAY = 86_400_000;
/** `YYYY-MM-DD`, `days` before `now` (UTC). */
export const daysBefore = (now: Date, days: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - days * DAY).toISOString().slice(0, 10);

/** A small deterministic generator, so the fixture is the same on every run. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** MW-301's sites: number, name, city, country, target, randomised so far. 186 of 300 in all. */
const MW301_SITES: [string, string, string, string, number, number][] = [
  ['101', 'Northgate University Hospital', 'Leeds', 'GB', 25, 24],
  ['102', 'Riverside Clinical Research Centre', 'Manchester', 'GB', 25, 21],
  ['103', 'Hôpital Saint-Clair', 'Lyon', 'FR', 23, 17],
  ['104', 'Kliniken am Stadtpark', 'Berlin', 'DE', 12, 7],
  ['105', 'Ospedale San Marco', 'Milan', 'IT', 24, 18],
  ['106', 'Hospital del Mar Norte', 'Barcelona', 'ES', 25, 20],
  ['107', 'Lakeshore Medical Center', 'Chicago', 'US', 35, 19],
  ['108', 'Bayview Diabetes Center', 'Boston', 'US', 35, 21],
  ['109', 'Cedar Valley Research', 'Denver', 'US', 24, 17],
  ['110', 'Maple Leaf Clinical Trials', 'Toronto', 'CA', 27, 8],
  ['111', 'Nordic Heart and Metabolism', 'Oslo', 'NO', 20, 7],
  ['112', 'Clínica Vista Alegre', 'Lisbon', 'PT', 25, 7],
];

/** Investigator and coordinator per site: [first, last, title] each; site 104's coordinator started on 2 Sep. */
const MW301_STAFF: Record<string, { pi: [string, string]; crc: [string, string]; crcSince?: string }> = {
  '101': { pi: ['Helen', 'Marsh'], crc: ['Owen', 'Price'] },
  '102': { pi: ['Rajesh', 'Iyer'], crc: ['Sophie', 'Bell'] },
  '103': { pi: ['Claire', 'Dubois'], crc: ['Luc', 'Martin'] },
  '104': { pi: ['Jonas', 'Weber'], crc: ['Lena', 'Hoffmann'], crcSince: '2026-09-02' },
  '105': { pi: ['Marco', 'Bianchi'], crc: ['Giulia', 'Romano'] },
  '106': { pi: ['Elena', 'Ruiz'], crc: ['Pablo', 'Ortega'] },
  '107': { pi: ['David', 'Kim'], crc: ['Rachel', 'Adams'] },
  '108': { pi: ['Mei', 'Chen'], crc: ['Tom', 'Walsh'] },
  '109': { pi: ['Laura', 'Grant'], crc: ['Ben', 'Foster'] },
  '110': { pi: ['Anil', 'Mehta'], crc: ['Chloe', 'Tremblay'] },
  '111': { pi: ['Ingrid', 'Berg'], crc: ['Erik', 'Lund'] },
  '112': { pi: ['Rita', 'Sousa'], crc: ['Tiago', 'Alves'] },
};

/** What the old queries (older than 14 days) say, per site, and their ages: 23 at five sites. */
const OLD_QUERIES: Record<string, { ages: number[]; kinds: [string, string, string, string][] }> = {
  '104': {
    ages: [31, 24, 23, 21, 19, 18, 17, 16, 15],
    kinds: [
      ['Visit 3', 'Vital signs', 'WEIGHT', 'Weight not entered'],
      ['Visit 3', 'Vital signs', 'WEIGHT', 'Weight not entered'],
      ['Visit 3', 'Vital signs', 'WEIGHT', 'Weight not entered'],
      ['Visit 3', 'Vital signs', 'WEIGHT', 'Weight not entered'],
      ['Visit 3', 'Vital signs', 'WEIGHT', 'Weight not entered'],
      ['Visit 3', 'Vital signs', 'WEIGHT', 'Weight not entered'],
      ['Visit 2', 'Laboratory', 'LBDAT', 'Lab sample date is 8 days after the visit'],
      ['Visit 3', 'Vital signs', 'WEIGHT', 'Weight not entered'],
      ['Visit 2', 'Concomitant medication', 'CMDOSE', 'Concomitant medication dose missing'],
    ],
  },
  '109': {
    ages: [26, 25, 22, 20, 19, 17, 16, 15],
    kinds: [
      ['Visit 2', 'Laboratory', 'LBDAT', 'Lab sample date is 9 days after the visit'],
      ['Visit 2', 'Laboratory', 'LBDAT', 'Lab sample date is 7 days after the visit'],
      ['Visit 2', 'Laboratory', 'LBDAT', 'Lab sample date is 6 days after the visit'],
      ['Visit 3', 'Laboratory', 'LBDAT', 'Lab sample date is 5 days after the visit'],
      ['Visit 2', 'Laboratory', 'LBDAT', 'Lab sample date is 10 days after the visit'],
      ['Visit 3', 'Vital signs', 'WEIGHT', 'Weight not entered'],
      ['Visit 3', 'Laboratory', 'LBDAT', 'Lab sample date is 4 days after the visit'],
      ['Visit 1', 'Adverse events', 'AEENDAT', 'Adverse event end date is before its start date'],
    ],
  },
  '102': {
    ages: [19, 17, 15],
    kinds: [
      ['Visit 2', 'Concomitant medication', 'CMDOSE', 'Concomitant medication dose missing'],
      ['Visit 3', 'Concomitant medication', 'CMDOSE', 'Concomitant medication dose missing'],
      ['Visit 1', 'Vital signs', 'BP', 'Blood pressure out of range, please confirm'],
    ],
  },
  '106': {
    ages: [17, 15],
    kinds: [
      ['Visit 3', 'Vital signs', 'WEIGHT', 'Weight not entered'],
      ['Visit 3', 'Vital signs', 'WEIGHT', 'Weight not entered'],
    ],
  },
  '111': {
    ages: [15],
    kinds: [['Visit 2', 'Adverse events', 'AEENDAT', 'Adverse event end date missing']],
  },
};

/** The subject an old query is about, so the oldest read as in the mock (104-007, 109-012, 104-003). */
const OLD_QUERY_SUBJECTS: Record<string, number[]> = {
  '104': [7, 3, 5, 1, 6, 2, 4, 7, 3],
  '109': [12, 4, 9, 2, 15, 7, 11, 1],
  '102': [5, 14, 9],
  '106': [3, 11],
  '111': [6],
};

/** Open queries 14 days old or younger, per site: 119 in all, so 142 are open. */
const RECENT_OPEN: Record<string, number> = {
  '101': 8, '102': 10, '103': 9, '104': 5, '105': 11, '106': 12, '107': 14, '108': 13, '109': 9, '110': 10, '111': 8, '112': 10,
};

const RECENT_KINDS: [string, string, string, string][] = [
  ['Visit 4', 'Vital signs', 'WEIGHT', 'Weight not entered'],
  ['Visit 4', 'Laboratory', 'HBA1C', 'HbA1c result missing'],
  ['Visit 3', 'Concomitant medication', 'CMSTDAT', 'Start date is after the visit date'],
  ['Visit 4', 'Adverse events', 'AESEV', 'Severity missing'],
  ['Visit 2', 'Vital signs', 'HEIGHT', 'Height differs from screening by more than 3 cm'],
  ['Visit 4', 'Study drug', 'EXDOSE', 'Dose taken does not match the dose dispensed'],
];

/** The fixture as of `now`: dates are relative to it, so query ages are the same on any day. */
export function raveFixture(now: Date = new Date()): FakeRaveData {
  const rand = prng(301);
  const studies: FakeRaveStudy[] = [
    { StudyOID: MW301, ProtocolName: 'MW-301', Environment: 'Prod', StudyName: 'MW-301: meriglutide once weekly in adults with type 2 diabetes (phase 3)', EnrollmentTarget: 300, PlannedByNow: 190 },
    { StudyOID: MW207, ProtocolName: 'MW-207', Environment: 'Prod', StudyName: 'MW-207: meriglutide in adolescents with obesity (phase 2)', EnrollmentTarget: 60, PlannedByNow: 12 },
  ];
  const sites: FakeRaveSite[] = [];
  const users: FakeRaveUser[] = [];
  const subjects: FakeRaveSubject[] = [];
  const queries: FakeRaveQuery[] = [];
  const forms: FakeRaveFormStatus[] = [];
  let queryId = 50_000;

  for (const [n, name, city, country, target, randomised] of MW301_SITES) {
    sites.push({ StudyOID: MW301, SiteNumber: n, LocationOID: n, SiteName: name, City: city, Country: country, Status: 'Active', EnrollmentTarget: target, ActivatedDate: daysBefore(now, 200 + Number(n)) });
    const staff = MW301_STAFF[n]!;
    const email = (first: string, last: string) => `${first}.${last}@site${n}.example`.toLowerCase();
    users.push({ StudyOID: MW301, SiteNumber: n, Login: `${staff.pi[0][0]}${staff.pi[1]}`.toLowerCase(), FirstName: staff.pi[0], LastName: staff.pi[1], Title: 'Dr', Email: email(...staff.pi), Role: 'Investigator', Active: true, StartDate: daysBefore(now, 210 + Number(n)) });
    users.push({ StudyOID: MW301, SiteNumber: n, Login: `${staff.crc[0][0]}${staff.crc[1]}`.toLowerCase(), FirstName: staff.crc[0], LastName: staff.crc[1], Email: email(...staff.crc), Role: 'Study Coordinator', Active: true, StartDate: staff.crcSince ?? daysBefore(now, 205 + Number(n)) });
    for (let i = 1; i <= randomised; i++) {
      const since = Math.floor(rand() * 170) + 10;
      subjects.push({
        StudyOID: MW301, SiteNumber: n, SubjectKey: `${n}-${String(i).padStart(3, '0')}`, Status: 'Randomised',
        RandomisedDate: daysBefore(now, since), LastVisit: `Visit ${Math.min(5, 1 + Math.floor(since / 35))}`, LastVisitDate: daysBefore(now, Math.floor(rand() * 20)),
      });
    }
    const subjectOf = (i: number) => `${n}-${String(((i - 1) % randomised) + 1).padStart(3, '0')}`;
    const old = OLD_QUERIES[n];
    old?.ages.forEach((age, i) => {
      const [Folder, Form, Field, QueryText] = old.kinds[i]!;
      queries.push({ StudyOID: MW301, QueryId: ++queryId, SiteNumber: n, SubjectKey: subjectOf(OLD_QUERY_SUBJECTS[n]![i]!), Folder, Form, Field, QueryText, MarkingGroup: 'Data Management', Status: 'Open', OpenedDate: daysBefore(now, age) });
    });
    for (let i = 0; i < RECENT_OPEN[n]!; i++) {
      const [Folder, Form, Field, QueryText] = RECENT_KINDS[Math.floor(rand() * RECENT_KINDS.length)]!;
      queries.push({ StudyOID: MW301, QueryId: ++queryId, SiteNumber: n, SubjectKey: subjectOf(1 + Math.floor(rand() * randomised)), Folder, Form, Field, QueryText, MarkingGroup: 'Data Management', Status: 'Open', OpenedDate: daysBefore(now, Math.floor(rand() * 15)) });
    }
    // Some queries the sites already answered or closed: they are not open, whatever their age.
    for (let i = 0; i < 5; i++) {
      const [Folder, Form, Field, QueryText] = RECENT_KINDS[Math.floor(rand() * RECENT_KINDS.length)]!;
      const opened = 20 + Math.floor(rand() * 60);
      const closed = i < 4;
      queries.push({
        StudyOID: MW301, QueryId: ++queryId, SiteNumber: n, SubjectKey: subjectOf(1 + Math.floor(rand() * randomised)), Folder, Form, Field, QueryText, MarkingGroup: 'Data Management',
        Status: closed ? 'Closed' : 'Answered', OpenedDate: daysBefore(now, opened), ...(closed ? { ClosedDate: daysBefore(now, opened - 5) } : {}),
      });
    }
    // Source data verification: 91% of the entered pages across the study.
    const entered = randomised * 24;
    const share = n === '104' ? 0.74 : n === '109' ? 0.85 : 0.91 + (Number(n) % 4) * 0.005;
    forms.push({ StudyOID: MW301, SiteNumber: n, PagesEntered: entered, PagesVerified: Math.round(entered * share), PagesOverdue: n === '104' ? 9 : n === '109' ? 6 : Math.floor(rand() * 3) });
  }

  // MW-207: two sites, five subjects, so lists can be told apart by study.
  for (const [n, name, city, country] of [['201', 'Northgate University Hospital', 'Leeds', 'GB'], ['202', 'Lakeshore Medical Center', 'Chicago', 'US']] as const) {
    sites.push({ StudyOID: MW207, SiteNumber: n, LocationOID: n, SiteName: name, City: city, Country: country, Status: 'Active', EnrollmentTarget: 30, ActivatedDate: daysBefore(now, 60) });
    users.push({ StudyOID: MW207, SiteNumber: n, Login: `crc${n}`, FirstName: 'Sam', LastName: `Reyes ${n}`, Email: `sam.reyes@site${n}.example`, Role: 'Study Coordinator', Active: true, StartDate: daysBefore(now, 60) });
  }
  for (const key of ['201-001', '201-002', '201-003', '202-001', '202-002']) {
    subjects.push({ StudyOID: MW207, SiteNumber: key.slice(0, 3), SubjectKey: key, Status: 'Randomised', RandomisedDate: daysBefore(now, 30), LastVisit: 'Visit 2', LastVisitDate: daysBefore(now, 3) });
  }
  queries.push({ StudyOID: MW207, QueryId: ++queryId, SiteNumber: '201', SubjectKey: '201-002', Folder: 'Visit 1', Form: 'Vital signs', Field: 'WEIGHT', QueryText: 'Weight not entered', MarkingGroup: 'Data Management', Status: 'Open', OpenedDate: daysBefore(now, 20) });

  return { studies, sites, users, subjects, queries, forms };
}

// ---------------------------------------------------------------- the server

export interface FakeRaveCall { method: string; path: string; query: Record<string, string>; status: number }

export interface FakeRave {
  /** The RWS base, `http://127.0.0.1:<port>/RaveWebServices`. */
  url: string;
  user: string;
  password: string;
  /** The fixture it answers from; change it freely while it runs. */
  data: FakeRaveData;
  /** Every request it answered, in order. */
  calls: FakeRaveCall[];
  /** A new study coordinator at a site: the old one is made inactive (as a Rave user admin would). */
  setCoordinator(input: { study?: string; site: string; name: string; email: string; since?: string }): FakeRaveUser;
  stop(): Promise<void>;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const notFound = (what: string) => json({ ErrorDescription: `${what} not found`, ErrorClientResponseMessage: `${what} not found` }, 404);

function setCoordinator(data: FakeRaveData, input: { study?: string; site: string; name: string; email: string; since?: string }, now: Date): FakeRaveUser {
  const study = input.study ?? MW301;
  if (!data.sites.some((s) => s.StudyOID === study && s.SiteNumber === input.site)) throw new Error(`no site ${input.site} in ${study}`);
  for (const u of data.users) if (u.StudyOID === study && u.SiteNumber === input.site && u.Role === 'Study Coordinator') u.Active = false;
  const [first, ...rest] = input.name.trim().split(/\s+/);
  const user: FakeRaveUser = {
    StudyOID: study, SiteNumber: input.site, Login: input.email.split('@')[0]!.replace(/\W+/g, '').toLowerCase(),
    FirstName: first ?? input.name, LastName: rest.join(' '), Email: input.email, Role: 'Study Coordinator', Active: true,
    StartDate: input.since ?? daysBefore(now, 0),
  };
  data.users.push(user);
  return user;
}

/** RWS's answers from the fixture, by path. */
function answer(data: FakeRaveData, path: string[], query: URLSearchParams): Response {
  // /RaveWebServices/version
  if (path.length === 1 && path[0] === 'version') return new Response('1.18.4', { headers: { 'content-type': 'text/plain' } });
  if (path[0] !== 'studies') return notFound('resource');
  if (path.length === 1) return json({ studies: data.studies });
  const oid = path[1]!;
  const study = data.studies.find((s) => s.StudyOID === oid);
  if (!study) return notFound(`study ${oid}`);
  const site = query.get('SiteNumber');
  const ofStudy = <T extends { StudyOID: string; SiteNumber: string }>(rows: T[]) => rows.filter((r) => r.StudyOID === oid && (!site || r.SiteNumber === site));
  const [, , kind, id, sub] = path;
  if (!kind) return json({ study });
  switch (kind) {
    case 'sites': {
      if (!id) return json({ sites: ofStudy(data.sites) });
      const s = data.sites.find((x) => x.StudyOID === oid && x.SiteNumber === id);
      if (!s) return notFound(`site ${id}`);
      if (sub === 'users') return json({ users: data.users.filter((u) => u.StudyOID === oid && u.SiteNumber === id) });
      if (sub) return notFound('resource');
      return json({ site: s });
    }
    case 'subjects': {
      if (!id) return json({ subjects: ofStudy(data.subjects) });
      const s = data.subjects.find((x) => x.StudyOID === oid && x.SubjectKey === id);
      return s ? json({ subject: s }) : notFound(`subject ${id}`);
    }
    case 'queries': {
      if (!id) {
        const status = query.get('Status');
        return json({ queries: ofStudy(data.queries).filter((q) => !status || q.Status.toLowerCase() === status.toLowerCase()) });
      }
      const q = data.queries.find((x) => x.StudyOID === oid && String(x.QueryId) === id);
      return q ? json({ query: q }) : notFound(`query ${id}`);
    }
    case 'formstatus':
      return json({ sites: ofStudy(data.forms) });
    case 'users':
      // Every user of the study (optionally of one site), so a client needn't ask site by site.
      return id ? notFound('resource') : json({ users: ofStudy(data.users) });
    default:
      return notFound('resource');
  }
}

export interface FakeRaveOptions {
  port?: number;
  hostname?: string;
  user?: string;
  password?: string;
  /** The day the fixture is built around (query ages count from it). */
  now?: Date;
  data?: FakeRaveData;
}

/** Starts the fake (a random local port unless `port` is given). Only GET is served: RWS here is read only. */
export async function startFakeRave(opts: FakeRaveOptions = {}): Promise<FakeRave> {
  const now = opts.now ?? new Date();
  const user = opts.user ?? FAKE_RAVE_USER;
  const password = opts.password ?? FAKE_RAVE_PASSWORD;
  const data = opts.data ?? raveFixture(now);
  const calls: FakeRaveCall[] = [];
  const expected = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const http = Bun.serve({
    port: opts.port ?? 0,
    hostname: opts.hostname ?? '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const record = (res: Response) => {
        calls.push({ method: req.method, path: decodeURIComponent(url.pathname), query: Object.fromEntries(url.searchParams), status: res.status });
        return res;
      };
      if (req.headers.get('authorization') !== expected) {
        return record(new Response('Authorization required', { status: 401, headers: { 'www-authenticate': 'Basic realm="Rave Web Services"' } }));
      }
      // The walkthrough's way to change the fixture: a new coordinator at a site.
      if (url.pathname === '/__fake/coordinator' && req.method === 'POST') {
        try {
          return record(json({ user: setCoordinator(data, (await req.json()) as Parameters<typeof setCoordinator>[1], now) }));
        } catch (e) {
          return record(json({ ErrorDescription: (e as Error).message }, 400));
        }
      }
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts[0] !== 'RaveWebServices') return record(notFound('resource'));
      if (req.method !== 'GET') return record(json({ ErrorDescription: 'Rave Web Services here are read only' }, 405));
      return record(answer(data, parts.slice(1), url.searchParams));
    },
  });
  return {
    url: `http://${http.hostname}:${http.port}/RaveWebServices`,
    user, password, data, calls,
    setCoordinator: (input) => setCoordinator(data, input, now),
    stop: async () => { await http.stop(true); },
  };
}

if (import.meta.main) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const fake = await startFakeRave({
    port: Number(arg('port') ?? 4790),
    ...(arg('user') ? { user: arg('user')! } : {}),
    ...(arg('password') ? { password: arg('password')! } : {}),
  });
  console.log(`Fake Medidata Rave at ${fake.url}`);
  console.log(`  RAVE_URL=${fake.url} RAVE_USER=${fake.user} RAVE_PASSWORD=${fake.password}`);
  console.log(`  A new coordinator at site 104: curl -u ${fake.user}:${fake.password} -X POST ${fake.url.replace('/RaveWebServices', '')}/__fake/coordinator -d '{"site":"104","name":"Mira Schulz","email":"mira.schulz@site104.example"}'`);
}
