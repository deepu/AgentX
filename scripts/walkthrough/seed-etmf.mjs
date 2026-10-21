// Seeds the eTMF example through the app's own calls, as the owner: sponsor, study, three sites in EDC
// and eTMF, their expected documents, and moves two sites to Activating (one with a full pack, so its
// activation waits for the person to approve).
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
    const sponsor = await create('etmf.Sponsor', { name: 'Aster Bio' });
    const study = await create('etmf.Study', { code: 'MW-301', title: 'A phase 3 study of MW-301 in solid tumours', sponsor });
    const artifacts = ['Protocol signature page', 'FDA Form 1572', 'GCP certificates', 'Financial disclosure', 'Lab normal ranges',
      'Sub-investigator CVs', 'Clinical trial agreement', 'IRB approval', 'Lab certification', 'Investigator CV'];
    const sites = [
      { n: 'US-012', name: 'Harbor Oncology, Boston', pi: 'Dr. Mei Chen', filed: 9, move: true },
      { n: 'DE-104', name: 'Charité Studienzentrum, Berlin', pi: 'Dr. Jonas Weber', filed: 10, move: true },
      { n: 'FR-201', name: 'Centre Léon Bérard, Lyon', pi: 'Dr. Claire Martin', filed: 4, move: false },
    ];
    for (const s of sites) {
      await create('edc.Site', { site_number: s.n, name: s.name, principal_investigator: s.pi }, 'active');
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
