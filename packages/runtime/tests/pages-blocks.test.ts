// Page bodies without a database (26 §4): fences, sections, the headline, numbers, the compare
// step's verdict, and when a kept page refreshes next.
import { describe, expect, test } from 'bun:test';
import { changedSections, compareBodies, fences, headline, numbersIn, replaceFences, sections } from '../src/pages/blocks.ts';
import { nextRefresh, normalEvery } from '../src/pages/schedule.ts';

const BODY = `GLP-1 drugs cut weight by **15%** on average across [9 trials](https://pubmed.ncbi.nlm.nih.gov/1).

\`\`\`tiles
{"tiles":[{"label":"Trials","value":"9"},{"label":"Mean loss","value":"-15.1%"}]}
\`\`\`

## Trials

\`\`\`table
{"columns":[{"key":"name","label":"Trial"}],"rows":[{"name":"STEP-1"}]}
\`\`\`

## Safety

Nausea is the most common side effect.
`;

describe('page bodies', () => {
  test('fences, sections (headings inside fences ignored) and the headline', () => {
    expect(fences(BODY).map((f) => f.lang)).toEqual(['tiles', 'table']);
    expect(sections(BODY).map((s) => s.heading ?? '')).toEqual(['', 'Trials', 'Safety']);
    expect(sections('```table\n## not a heading\n```\n\n## Real')).toEqual([
      { markdown: '```table\n## not a heading\n```' }, { heading: 'Real', markdown: '' },
    ]);
    expect(headline(BODY)).toBe('GLP-1 drugs cut weight by 15% on average across 9 trials.');
    expect(headline('# Title\n\n| a |\n\nThe answer is 3.')).toBe('The answer is 3.');
  });

  test('numbers as written: thousands separators dropped, minus signs made one', () => {
    expect(numbersIn('1,613 people lost −15.1% (95% CI) in 2 arms')).toEqual(['1613', '-15.1%', '95%', '2']);
  });

  test('compare: same, spacing only, a new number, a new section, prose only', () => {
    expect(compareBodies(BODY, BODY)).toMatchObject({ same: true, material: false });
    expect(compareBodies(BODY, BODY.replace('Nausea is', 'Nausea  is'))).toMatchObject({ same: true, material: false });

    const newTrial = BODY.replace('[9 trials]', '[10 trials]');
    const c = compareBodies(BODY, newTrial);
    expect(c).toMatchObject({ material: true, headlineChanged: true, numbers: { added: ['10'], removed: ['9'] } });
    expect(c.after).toContain('10 trials');

    const added = compareBodies(BODY, `${BODY}\n## ATTAIN-MAINTAIN\n\nMost people kept the weight off.\n`);
    expect(added.material).toBe(true);
    expect(added.added.map((s) => s.heading)).toEqual(['ATTAIN-MAINTAIN']);

    const prose = compareBodies(BODY, BODY.replace('the most common', 'the commonest'));
    expect(prose).toMatchObject({ material: false, same: false });
    expect(prose.changed.map((s) => s.heading)).toEqual(['Safety']);
  });

  test('changedSections names the sections an edit touched', () => {
    expect(changedSections(BODY, BODY.replace('Nausea', 'Mild nausea'))).toEqual(['Safety']);
    expect(changedSections(BODY, BODY.replace('GLP-1 drugs', 'GLP-1 medicines'))).toEqual(['']);
  });

  test('replaceFences swaps only the fences the callback answers', async () => {
    const out = await replaceFences(BODY, (f) => (f.lang === 'tiles' ? '{"tiles":[]}' : undefined));
    expect(fences(out).map((f) => f.body)).toEqual(['{"tiles":[]}', fences(BODY)[1]!.body]);
    expect(out).toContain('## Safety');
  });
});

describe('refresh schedule', () => {
  test('every: weekdays, daily, month', () => {
    expect(['mon', 'Monday', 'week', 'daily', 'monthly', 'fortnight'].map(normalEvery)).toEqual(['mon', 'mon', 'mon', 'daily', 'month', undefined]);
  });

  test('the next refresh is strictly later, at 06:00 local', () => {
    const wed = new Date(2026, 9, 21, 10, 0); // Wednesday 21 Oct 2026, 10:00
    const mon = nextRefresh('mon', wed);
    expect([mon.getDay(), mon.getDate(), mon.getHours(), mon.getMinutes()]).toEqual([1, 26, 6, 0]);
    const daily = nextRefresh('daily', wed);
    expect([daily.getDate(), daily.getHours()]).toEqual([22, 6]);
    const early = nextRefresh('daily', new Date(2026, 9, 21, 5, 0));
    expect([early.getDate(), early.getHours()]).toEqual([21, 6]);
    const month = nextRefresh('month', wed);
    expect([month.getMonth(), month.getDate(), month.getHours()]).toEqual([10, 1, 6]);
    expect(nextRefresh('mon', mon).getTime()).toBe(nextRefresh('mon', new Date(mon.getTime() + 60_000)).getTime());
  });
});
