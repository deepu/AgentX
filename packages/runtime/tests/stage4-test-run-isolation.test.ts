// Stage 4 (D121): a test run of a draft reaches nothing outside. The throwaway kernel binds the
// draft's plugins, so every plugin tool is stubbed whatever its class: a `read` from an MCP server
// (PubMed, bound by the Literature example) is as much a call outside as an email.
import { describe, expect, test } from 'bun:test';
import { loadProject, type ExampleCase } from '@memwise/defs';
import { resolve } from 'node:path';
import { testRunExample, type TestRunSource } from '../src/test-run.ts';
import type { RecordQuery, RecordQueryResult } from '../src/types.ts';

const LITERATURE = resolve(import.meta.dir, '../../../examples/literature');

/** One topic, as the person sees it; no related rows. */
async function query(q: RecordQuery): Promise<RecordQueryResult> {
  const rows = q.entity.endsWith('Topic') && /id = 'topic_1'/.test(q.filter ?? '')
    ? [{ id: 'topic_1', title: 'Oral GLP-1s', values: { name: 'Oral GLP-1s', question: 'Do they work?', query: 'semaglutide AND oral' }, hidden: [], status: 'active' }]
    : [];
  return { rows, columns: [], total: rows.length } as unknown as RecordQueryResult;
}

async function source(extra: Partial<TestRunSource> = {}): Promise<TestRunSource> {
  const { project } = await loadProject(LITERATURE);
  const workflow = project.workflows['check-topic']!;
  return {
    project, workflow, record: { entity: 'literature.Topic', id: 'topic_1' }, query,
    // Every tool says it only reads, as the PubMed binding does.
    effectOf: () => 'read',
    ...extra,
  };
}

describe('Stage 4: a test run stubs every plugin tool', () => {
  test('a bound plugin tool of effect read is stubbed, a kernel read is not', async () => {
    const { example } = await testRunExample(await source({ fromPlugin: (t) => t.startsWith('PubMed.') }));
    expect(example.tools).toMatchObject({
      'PubMed.search_articles': { test_run: true, sent: false },
      'PubMed.get_article_metadata': { test_run: true, sent: false },
    });
    // The records tools read the throwaway database: they run.
    expect(Object.keys(example.tools ?? {}).some((t) => t.startsWith('literature.'))).toBe(false);
  });

  test('every tool of a bound plugin is stubbed even without the live gateway saying where it comes from', async () => {
    const { example } = await testRunExample(await source());
    const stubbed = Object.keys(example.tools ?? {});
    for (const t of ['PubMed.search_articles', 'PubMed.get_article_metadata', 'PubMed.find_related_articles', 'PubMed.get_full_text_article']) {
      expect(stubbed).toContain(t);
    }
  });

  test("a replayed case's recorded plugin results stand in for the plugin", async () => {
    const latestCase: ExampleCase = {
      name: 'latest', case: {}, expect: {}, file: 'x.yaml',
      model: { searcher: [] },
      tools: { 'PubMed.search_articles': { count: 2, pmids: ['1', '2'] } },
    };
    const { example } = await testRunExample(await source({ latestCase, latestCaseId: 'case_1' }));
    expect(example.tools?.['PubMed.search_articles']).toEqual({ count: 2, pmids: ['1', '2'] });
    expect(example.tools?.['PubMed.get_article_metadata']).toEqual({ test_run: true, sent: false });
  });
});
