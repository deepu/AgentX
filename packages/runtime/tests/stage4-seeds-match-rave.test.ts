// The eTMF example's studies are the same studies EDC reads from Medidata Rave: MW-301 and MW-207
// carry Rave's study titles, one sponsor (Meridian Pharma), and only Rave's site numbers, in both
// examples/etmf/projects/<id>/seed.yaml and the walkthrough's own seed (scripts/walkthrough/seed-etmf.mjs).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadProject } from '@memwise/defs';
import { parseSeed } from '../src/projects/seed.ts';
import { titleOf } from '../src/flow/records.ts';
import { recordTitle } from '../src/records/context.ts';
import { MW207, MW301, raveFixture } from './fixtures/fake-rave-http.ts';

const REPO = resolve(import.meta.dir, '../../..');
const rave = raveFixture(new Date('2026-10-22T00:00:00Z'));
const SPONSOR = 'Meridian Pharma';

describe('Stage 4: the eTMF seeds match Rave', () => {
  for (const [project, oid] of [['mw301', MW301], ['mw207', MW207]] as const) {
    test(`${project}: Rave's study title, one sponsor, Rave's sites`, () => {
      const seed = parseSeed(readFileSync(join(REPO, 'examples/etmf/projects', project, 'seed.yaml'), 'utf8'));
      const study = rave.studies.find((s) => s.StudyOID === oid)!;
      const studies = seed.filter((e) => e.entity === 'Study');
      expect(studies.map((s) => [s.values.code, s.values.title])).toEqual([[study.ProtocolName, study.StudyName]]);
      expect(seed.filter((e) => e.entity === 'Sponsor').map((s) => s.values.name)).toEqual([SPONSOR]);
      const raveSites = new Set(rave.sites.filter((s) => s.StudyOID === oid).map((s) => s.SiteNumber));
      const sites = seed.filter((e) => e.entity === 'Site').map((s) => String(s.values.site_number));
      expect(sites.length).toBeGreaterThan(0);
      for (const n of sites) expect(raveSites.has(n)).toBe(true);
      expect(JSON.stringify(seed)).not.toMatch(/Aster|AST-301|asthma/i);
    });
  }

  test('the walkthrough seed uses the same title and sponsor', () => {
    const text = readFileSync(join(REPO, 'scripts/walkthrough/seed-etmf.mjs'), 'utf8');
    const mw301 = rave.studies.find((s) => s.StudyOID === MW301)!;
    expect(text).toContain(`code: 'MW-301', title: '${mw301.StudyName}'`);
    expect(text).toContain(`name: '${SPONSOR}'`);
    expect(text).not.toMatch(/Aster|AST-301|asthma/i);
  });

  test("the reminder example's site is Rave's site 101 and its coordinator", () => {
    const text = readFileSync(join(REPO, 'examples/etmf/domains/etmf/workflows/remind-site/examples/second-reminder.yaml'), 'utf8');
    const site = rave.sites.find((s) => s.StudyOID === MW301 && s.SiteNumber === '101')!;
    const crc = rave.users.find((u) => u.StudyOID === MW301 && u.SiteNumber === '101' && u.Role === 'Study Coordinator')!;
    expect(text).toContain(`name: ${site.SiteName}`);
    expect(text).toContain(`coordinator_email: ${crc.Email}`);
    expect(text).toContain(rave.studies.find((s) => s.StudyOID === MW301)!.StudyName);
  });

  test("a study's title doesn't repeat its code (Rave's name starts with it), in eTMF and EDC", async () => {
    const { project } = await loadProject(join(REPO, 'examples/etmf'));
    const mw301 = rave.studies.find((s) => s.StudyOID === MW301)!;
    expect(mw301.StudyName.startsWith(`${mw301.ProtocolName}:`)).toBe(true);
    const etmf = project.entities!['etmf.Study']!;
    const edc = project.entities!['edc.Study']!;
    const values = { code: mw301.ProtocolName, title: mw301.StudyName, protocol: mw301.ProtocolName, name: mw301.StudyName };
    for (const def of [etmf, edc]) {
      expect(recordTitle(def, 'stud_1', values)).toBe(mw301.StudyName);
      expect(titleOf(def, 'stud_1', values)).toBe(mw301.StudyName);
    }
    // A site still reads "101 · Northgate University Hospital".
    expect(recordTitle(project.entities!['etmf.Site']!, 'site_101', { site_number: '101', name: 'Northgate University Hospital' })).toBe('101 · Northgate University Hospital');
  });
});
