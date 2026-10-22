// Seeds the eTMF example through the app's own calls, as the owner: sponsor, study, three sites in
// eTMF with their expected documents, and moves two sites to Activating (one with a full pack, so its
// activation waits for the person to approve). EDC's sites are not made here: they come from Medidata
// Rave (Stage 6, one owner per fact), so run the fake Rave and give the app RAVE_* (see README.md).
// eTMF's sites use Rave's site numbers, so each pairs with its EDC site and follows its name and PI.
export async function seedEtmf(win) {
  return await win.evaluate(async () => {
    const api = window.electronAPI;
    const ws = new URLSearchParams(location.search).get('workspaceId');
    const out = [];
    const create = async (entity, values, status) => {
      const r = await api.memwiseCreateRecord(ws, { entity, values, ...(status ? { status } : {}), reason: 'study set-up' });
      if (!r.applied) throw new Error(`create ${entity}: ${r.message}`);
      return r.id;
    };
    const existing = await api.memwiseQueryRecords?.(ws, { entity: 'etmf.Sponsor' }).catch(() => null);
    if (existing && existing.total > 0) return ['already seeded'];
    // EDC's sites, from the first read of Rave.
    for (let i = 0; ; i++) {
      const edc = await api.memwiseQueryRecords(ws, { entity: 'edc.Site', limit: 1 }).catch(() => null);
      if (edc && edc.total > 0) break;
      if (i >= 60) throw new Error('no EDC sites: start the fake Rave and give the app RAVE_URL, RAVE_USER and RAVE_PASSWORD (scripts/walkthrough/README.md)');
      await new Promise((r) => setTimeout(r, 2000));
    }
    const sponsor = await create('etmf.Sponsor', { name: 'Aster Bio' });
    const study = await create('etmf.Study', { code: 'MW-301', title: 'A phase 3 study of MW-301 in solid tumours', sponsor });
    const artifacts = ['Protocol signature page', 'FDA Form 1572', 'GCP certificates', 'Financial disclosure', 'Lab normal ranges',
      'Sub-investigator CVs', 'Clinical trial agreement', 'IRB approval', 'Lab certification', 'Investigator CV'];
    const sites = [
      { n: '109', pi: 'Dr. Mei Chen', filed: 9, move: true },
      { n: '104', pi: 'Dr Jonas Weber', filed: 10, move: true },
      { n: '102', pi: 'Dr. Claire Martin', filed: 4, move: false },
    ];
    for (const s of sites) {
      const site = await create('etmf.Site', { site_number: s.n, study });
      await create('etmf.Person', { name: s.pi, role: 'Principal investigator', site });
      for (let i = 0; i < artifacts.length; i++) {
        await create('etmf.ExpectedDocument', { site, study, artifact: artifacts[i], phase: 'start_up' }, i < s.filed ? 'filed' : undefined);
      }
      if (s.move) {
        const r = await api.memwiseTransitionRecord(ws, { entity: 'etmf.Site', id: site, transition: 'picked', reason: 'Site selected: contract and budget signed' });
        out.push(`${s.n} picked: ${r.applied ? 'ok' : r.message}`);
      }
      out.push(`${s.n} seeded`);
    }
    return out;
  });
}
