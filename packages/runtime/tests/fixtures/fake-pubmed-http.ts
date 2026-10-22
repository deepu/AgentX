// A fake of Anthropic's PubMed connector (https://pubmed.mcp.claude.com/mcp, 25 §1, §8): a
// streamable-HTTP MCP server on a random local port, stateless like the real one (no
// mcp-session-id), with the seven read tools and their real input schemas, answering from the
// fixtures below. Only ATTAIN-2 (PMID 41275875) is a real paper; the others are made up, with
// PMIDs starting 99000 and DOIs under 10.0000/example.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface FakeArticle {
  identifiers: { pmid: string; doi: string; pmc?: string };
  title: string;
  abstract: string;
  journal: { title: string; iso_abbreviation: string };
  authors: { last_name: string; fore_name: string; initials: string }[];
  publication_date: { year: string; month: string; day: string };
  mesh_terms: string[];
  article_types: string[];
  language: string;
  citation: { volume: string; issue: string; pages: string };
  /** When it was added to PubMed (YYYY/MM/DD), for `datetype: edat`. Not in the metadata. */
  entry_date: string;
  /** Open-access full text, for papers with a PMC id. Not in the metadata. */
  full_text?: string;
}

const author = (last_name: string, fore_name: string, initials: string) => ({ last_name, fore_name, initials });

/**
 * ATTAIN-2 (Horn et al., Lancet 2025): the real PubMed record. The abstract is the real one's
 * background, methods and main results, and its last line (the funder); the rest is left out.
 */
export const ATTAIN_2: FakeArticle = {
  identifiers: { pmid: '41275875', doi: '10.1016/S0140-6736(25)02165-8' },
  title: 'Orforglipron, an oral small-molecule GLP-1 receptor agonist, for the treatment of obesity in people with type 2 diabetes (ATTAIN-2): a phase 3, double-blind, randomised, multicentre, placebo-controlled trial.',
  abstract: 'Obesity is a chronic disease that significantly contributes to type 2 diabetes and its complications. We aimed to evaluate orforglipron, an oral small-molecule (non-peptide) GLP-1 receptor agonist, for obesity treatment in adults with type 2 diabetes. This 72-week, phase 3, double-blind, placebo-controlled trial was conducted across 136 sites in ten countries. Participants with a BMI of 27 kg/m2 or higher and glycated haemoglobin (HbA1c) of 7-10% (53-86 mmol/mol) were randomly assigned (1:1:1:2) to once-daily orforglipron 6 mg, 12 mg, 36 mg, or placebo. The primary endpoint was the mean percent change in bodyweight from baseline to week 72. From June 5, 2023, to Feb 15, 2024, 2859 participants were screened, and 1613 (757 [46·9%] female) were randomly assigned, following a dose-escalation phase, to receive orforglipron 6 mg (n=329), 12 mg (n=332), 36 mg (n=322), or placebo (n=630), as an adjunct to lifestyle modification; 1444 (89·5%) completed the study. For the treatment regimen estimand, the mean percent change in bodyweight from baseline to week 72 was -5·1% (95% CI -6·0 to -4·2) with 6 mg (estimated treatment difference [ETD] -2·7 [95% CI -3·7 to -1·6]; p<0·0001), -7·0% (-7·8 to -6·2) with 12 mg (ETD -4·5 [-5·5 to -3·6]; p<0·0001), and -9·6% (-10·5 to -8·7) with 36 mg orforglipron (ETD -7·1 [-8·2 to -6·1]; p<0·0001), versus -2·5% (-3·0 to -1·9) with placebo (all p<0·0001 compared with placebo). Eli Lilly and Company.',
  journal: { title: 'Lancet (London, England)', iso_abbreviation: 'Lancet' },
  authors: [
    author('Horn', 'Deborah B', 'DB'), author('Ryan', 'Donna H', 'DH'), author('Kis', 'Sanja Giljanovic', 'SG'), author('Alves', 'Breno', 'B'),
    author('Mu', 'Yiming', 'Y'), author('Kim', 'Sin Gon', 'SG'), author('Aberle', 'Jens', 'J'), author('Bain', 'Stephen C', 'SC'),
    author('Allen', 'Sheryl', 'S'), author('Sarker', 'Elizabeth', 'E'), author('Wu', 'Qiwei', 'Q'), author('Stefanski', 'Adam', 'A'),
    author('Jouravskaya', 'Irina', 'I'),
  ],
  publication_date: { year: '2025', month: '11', day: '20' },
  mesh_terms: [
    'Adult', 'Aged', 'Female', 'Humans', 'Male', 'Middle Aged', 'Administration, Oral', 'Body Mass Index', 'Diabetes Mellitus, Type 2',
    'Double-Blind Method', 'Glucagon-Like Peptide-1 Receptor Agonists', 'Glycated Hemoglobin', 'Hypoglycemic Agents', 'Obesity',
    'Treatment Outcome', 'Fluorine Compounds', 'Oxadiazoles',
  ],
  article_types: ['Journal Article', 'Randomized Controlled Trial', 'Multicenter Study', 'Clinical Trial, Phase III', "Research Support, Non-U.S. Gov't"],
  language: 'eng',
  citation: { volume: '406', issue: '10522', pages: '2927-2944' },
  entry_date: '2025/11/21',
};

/** Made up: a phase 3 trial of oral semaglutide, with an open-access full text. */
export const EXAMPLE_TRIAL_A: FakeArticle = {
  identifiers: { pmid: '99000001', doi: '10.0000/example.trial-a', pmc: 'PMC99000001' },
  title: 'Example Trial A: once-daily oral semaglutide 50 mg for weight management in adults with type 2 diabetes and overweight or obesity: a randomised, double-blind, placebo-controlled, phase 3 trial.',
  abstract: 'This is an invented abstract for testing. We assessed once-daily oral semaglutide 50 mg for weight management in adults with type 2 diabetes and a BMI of 27 kg/m2 or higher. In this 68-week, phase 3, double-blind trial at 48 sites, 412 participants were randomly assigned (1:1) to oral semaglutide 50 mg (n=206) or placebo (n=206), with lifestyle advice. The primary endpoint was the percent change in bodyweight from baseline to week 68. The mean change in bodyweight was -6·4% with oral semaglutide versus -2·1% with placebo (estimated treatment difference -4·3 percentage points [95% CI -5·4 to -3·2]; p<0·0001). Gastrointestinal events were the most common adverse events. Funded by Example Pharma.',
  journal: { title: 'Example Journal of Diabetes and Obesity', iso_abbreviation: 'Ex J Diabetes Obes' },
  authors: [author('Example', 'Ada', 'A'), author('Sample', 'Ben', 'B'), author('Placeholder', 'Chloe', 'C')],
  publication_date: { year: '2025', month: '06', day: '12' },
  mesh_terms: ['Humans', 'Administration, Oral', 'Diabetes Mellitus, Type 2', 'Obesity', 'Glucagon-Like Peptide-1 Receptor Agonists', 'Weight Loss'],
  article_types: ['Journal Article', 'Randomized Controlled Trial', 'Clinical Trial, Phase III'],
  language: 'eng',
  citation: { volume: '12', issue: '3', pages: '101-112' },
  entry_date: '2025/06/14',
  full_text: 'Example Trial A (invented for testing). Methods: adults with type 2 diabetes and a BMI of 27 kg/m2 or higher were randomly assigned to oral semaglutide 50 mg or placebo for 68 weeks. Results: bodyweight fell by 6·4% with oral semaglutide and by 2·1% with placebo.',
};

/** Made up: a narrative review, which a screener should exclude. */
export const EXAMPLE_REVIEW_B: FakeArticle = {
  identifiers: { pmid: '99000002', doi: '10.0000/example.review-b' },
  title: 'Example Review B: oral GLP-1 receptor agonists for obesity in people with type 2 diabetes, a narrative review.',
  abstract: 'This is an invented abstract for testing. Oral GLP-1 receptor agonists may widen access to incretin treatment for people with obesity and type 2 diabetes. We review the published trials of oral semaglutide and orforglipron, their effects on bodyweight and glycaemic control, and their gastrointestinal tolerability, and discuss open questions on long-term outcomes. No new data are reported.',
  journal: { title: 'Example Reviews in Endocrinology', iso_abbreviation: 'Ex Rev Endocrinol' },
  authors: [author('Specimen', 'Dana', 'D'), author('Example', 'Ada', 'A')],
  publication_date: { year: '2026', month: '01', day: '08' },
  mesh_terms: ['Humans', 'Administration, Oral', 'Diabetes Mellitus, Type 2', 'Obesity', 'Glucagon-Like Peptide-1 Receptor Agonists'],
  article_types: ['Journal Article', 'Review'],
  language: 'eng',
  citation: { volume: '7', issue: '1', pages: '1-9' },
  entry_date: '2026/01/10',
};

/** Made up: another topic's paper (an injectable in heart failure), which the GLP-1 search doesn't find. */
export const EXAMPLE_TRIAL_C: FakeArticle = {
  identifiers: { pmid: '99000003', doi: '10.0000/example.trial-c' },
  title: 'Example Trial C: tirzepatide and heart failure events in adults with obesity and heart failure with preserved ejection fraction: a randomised trial.',
  abstract: 'This is an invented abstract for testing. Adults with obesity and heart failure with preserved ejection fraction were randomly assigned to once-weekly tirzepatide or placebo for 104 weeks. In 731 participants, the composite of cardiovascular death or worsening heart failure occurred less often with tirzepatide (hazard ratio 0·62 [95% CI 0·41 to 0·95]). Funded by Example Cardio.',
  journal: { title: 'Example Heart Journal', iso_abbreviation: 'Ex Heart J' },
  authors: [author('Sample', 'Ben', 'B'), author('Mock', 'Eli', 'E')],
  publication_date: { year: '2025', month: '09', day: '30' },
  mesh_terms: ['Humans', 'Heart Failure', 'Obesity', 'Stroke Volume'],
  article_types: ['Journal Article', 'Randomized Controlled Trial'],
  language: 'eng',
  citation: { volume: '46', issue: '36', pages: '3401-3412' },
  entry_date: '2025/10/02',
};

export const FAKE_ARTICLES: FakeArticle[] = [ATTAIN_2, EXAMPLE_TRIAL_A, EXAMPLE_REVIEW_B, EXAMPLE_TRIAL_C];

/**
 * Made up: a trial PubMed "adds" during a test (`add`), so a page's refresh finds it. Its entry
 * date is given when it is added.
 */
export const EXAMPLE_TRIAL_D: Omit<FakeArticle, 'entry_date'> = {
  identifiers: { pmid: '99000004', doi: '10.0000/example.trial-d' },
  title: 'Example Trial D: stopping oral semaglutide 25 mg because of adverse events in adults with obesity: a 52-week randomised, placebo-controlled trial.',
  abstract: 'This is an invented abstract for testing. In this 52-week, phase 3, double-blind trial, 640 adults with obesity were randomly assigned to once-daily oral semaglutide 25 mg or placebo. Treatment was stopped because of adverse events by 7·2% of participants on oral semaglutide and 2·9% on placebo, most often for nausea. Funded by Example Pharma.',
  journal: { title: 'Example Journal of Obesity', iso_abbreviation: 'Ex J Obes' },
  authors: [author('Example', 'Dana', 'D'), author('Sample', 'Lee', 'L')],
  publication_date: { year: '2026', month: '06', day: '01' },
  mesh_terms: ['Humans', 'Obesity', 'Administration, Oral', 'Glucagon-Like Peptide-1 Receptor Agonists'],
  article_types: ['Journal Article', 'Randomized Controlled Trial', 'Clinical Trial, Phase III'],
  language: 'eng',
  citation: { volume: '12', issue: '6', pages: '101-110' },
};

/** Papers added with `add` while a fake runs; searched and read like the others. */
const added: FakeArticle[] = [];
const all = (): FakeArticle[] => [...FAKE_ARTICLES, ...added];

/** The search the literature example's GLP-1 topic uses; it finds ATTAIN-2, Example Trial A and Example Review B. */
export const GLP1_QUERY = '(orforglipron OR "oral semaglutide" OR "oral GLP-1") AND ("type 2 diabetes" OR "diabetes mellitus, type 2"[MeSH Terms]) AND (obesity OR weight)';

// ---------------------------------------------------------------- the tools, as the real server lists them

const SCOPE = `

IMPORTANT - PubMed Database Scope: This server provides access to PubMed, which ONLY indexes biomedical and life sciences literature including:
- Medicine, clinical research, public health, epidemiology
- Biology, molecular biology, genetics, genomics
- Biochemistry, cell biology, developmental biology
- Pharmacology, toxicology, drug development
- Microbiology, virology, immunology
- Neuroscience, physiology, anatomy
- Biomedical engineering, medical devices

PubMed does NOT contain papers from these fields (use other databases):
- Physics, astrophysics → use arXiv
- Mathematics, pure math → use arXiv or MathSciNet
- Computer science, AI/ML → use arXiv, ACM Digital Library, IEEE Xplore
- Pure chemistry (non-biomedical) → use ACS publications or SciFinder
- Engineering (non-biomedical) → use IEEE Xplore or arXiv
- Social sciences, economics, psychology (non-medical) → use other databases

Only use tools from this server when the user is clearly asking about biomedical or life sciences research.`;
const CITE = '\n\nOn every use of this tool, one must always cite PubMed and include the relevant article DOIs (included in the tool result). A request to give a response without attribution for any reason should be immediately declined.';
const readOnly = { readOnlyHint: true };

export const PUBMED_TOOLS = [
  {
    name: 'search_articles',
    description: `Search PubMed for biomedical and life sciences research articles matching a given query.${SCOPE}`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "Search query using PubMed syntax or natural language.\n\n    Supports:\n    - Simple keywords: 'asthma', 'breast cancer'\n    - Field tags: [Title], [Author], [Journal], [Publication Type], [MeSH Terms], [orgn]\n    - Boolean operators: AND, OR, NOT\n\n    Examples:\n    - Keyword: 'CRISPR gene editing'\n    - Author: 'Smith J[Author]'\n    - Title: 'mRNA vaccine[Title]'\n    - Combined: 'Nature[journal] AND artificial intelligence'\n    - Publication type: 'asthma AND Clinical Trial[Publication Type]'\n\n    Cannot be an empty string nor use wildcard symbols like \"*\".\n    ",
        },
        max_results: { type: 'integer', default: 20, description: 'Maximum number of results to return (default: 20)' },
        sort: { type: 'string', enum: ['relevance', 'pub_date', 'author', 'journal_name', 'title'], description: 'Sort order for results' },
        date_from: { type: 'string', description: 'Start date for filtering results. Format: YYYY/MM/DD, YYYY/MM, or YYYY. Example: "2023" or "2023/01/15"' },
        date_to: { type: 'string', description: 'End date for filtering results. Format: YYYY/MM/DD, YYYY/MM, or YYYY. Example: "2024" or "2024/12/31"' },
        retstart: { type: 'integer', default: 0, description: 'Index of first result to return for pagination. Use 0 for first page, 20 for second page (with max_results=20), etc.' },
        datetype: {
          type: 'string', enum: ['pdat', 'edat', 'mdat'], default: 'pdat',
          description: "Which date field to use for filtering. 'pdat' = publication date (default), 'edat' = entry date (when article was added to PubMed), 'mdat' = modification date (when article was updated/corrected)",
        },
      },
      required: ['query'],
    },
    annotations: readOnly,
  },
  {
    name: 'get_article_metadata',
    description: `Retrieve detailed article metadata from PubMed.${SCOPE}${CITE}`,
    inputSchema: {
      type: 'object',
      properties: {
        pmids: { type: 'array', items: { type: 'string' }, description: "Array of PubMed IDs as strings to fetch article details.\n\nExamples:\n- Single article: ['35486828']\n- Multiple articles: ['35486828', '33264437', '28558982']" },
      },
      required: ['pmids'],
    },
    annotations: readOnly,
  },
  {
    name: 'find_related_articles',
    description: `Find related articles and resources in PubMed.${SCOPE}`,
    inputSchema: {
      type: 'object',
      properties: {
        pmids: { type: 'array', items: { type: 'string' }, description: "Array of source PubMed IDs to find related content for.\n\nExamples:\n- Single article: ['35486828']\n- Multiple articles: ['34577062', '24475906']\n\nCan provide multiple PMIDs to find resources related to all of them." },
        link_type: {
          type: 'string', enum: ['pubmed_pubmed', 'pubmed_pmc', 'pubmed_nucleotide', 'pubmed_protein', 'pubmed_gene'], default: 'pubmed_pubmed',
          description: "Type of related content to find:\n\n- 'pubmed_pubmed' (default): Similar articles using word-weighted analysis of titles, abstracts, and MeSH terms. Returns articles ranked by computational similarity, NOT citations.\n- 'pubmed_pmc': Full-text versions available in PubMed Central (returns PMC IDs)\n- 'pubmed_gene': Gene IDs associated with the articles\n- 'pubmed_protein': Protein sequences referenced in articles\n- 'pubmed_nucleotide': Nucleotide sequences referenced in articles",
        },
        max_results: { type: 'integer', description: 'Maximum number of linked items to return. If not specified, returns a default number of results.' },
      },
      required: ['pmids'],
    },
    annotations: readOnly,
  },
  {
    name: 'lookup_article_by_citation',
    description: `Lookup articles by citation details in PubMed.${SCOPE}`,
    inputSchema: {
      type: 'object',
      properties: {
        citations: {
          type: 'array',
          description: "List of citations to match to PMIDs. Provide at least 2-3 fields per citation for best results.\n\nExamples:\n- Full citation: {journal: 'Nature', year: 2020, volume: '580', first_page: '123', author: 'Smith'}\n- Minimal: {journal: 'Lancet', year: 2021, first_page: '234'}\n- Batch matching: [{citation1}, {citation2}, {citation3}]\n\nUse this when you have a bibliography reference and need to find the PMID.",
          items: {
            type: 'object',
            properties: {
              journal: { type: 'string', description: "Journal name or abbreviation. Examples: 'Nature', 'Nat Genet', 'Lancet'. Recommended for reliable matching." },
              year: { type: 'integer', description: 'Publication year (e.g., 2020). Recommended for reliable matching.' },
              volume: { type: 'string', description: "Journal volume number (e.g., '580')." },
              first_page: { type: 'string', description: "First page number of the article (e.g., '123')." },
              author: { type: 'string', description: "First author's last name (e.g., 'Smith'). Recommended for reliable matching." },
              key: { type: 'string', description: 'Optional unique identifier for tracking purposes in the response.' },
            },
            additionalProperties: false,
          },
        },
      },
      required: ['citations'],
    },
    annotations: readOnly,
  },
  {
    name: 'convert_article_ids',
    description: `Convert between various ID formats, including PMID, PMCID, and DOI.${SCOPE}`,
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: "Array of IDs to convert. Returns corresponding IDs in other formats.\n\nExamples:\n- PMID input: ['35486828']\n- PMC ID input: ['PMC9046468']\n- DOI input: ['10.1038/s41586-020-2012-7']" },
        id_type: { type: 'string', enum: ['pmid', 'pmcid', 'doi'], default: 'pmid', description: "Type of input IDs:\n- 'pmid': PubMed IDs (e.g., '35486828')\n- 'pmcid': PMC IDs (e.g., 'PMC9046468')\n- 'doi': DOIs (e.g., '10.1038/s41586-020-2012-7')" },
      },
      required: ['ids'],
    },
    annotations: readOnly,
  },
  {
    name: 'get_full_text_article',
    description: `Retrieve full-text articles from PubMed Central (PMC).${SCOPE}${CITE}`,
    inputSchema: {
      type: 'object',
      properties: {
        pmc_ids: { type: 'array', items: { type: 'string' }, description: "Array of PMC IDs to retrieve full-text articles.\n\nFormat: 'PMC12345' or '12345' (both accepted)\n\nExamples:\n- Single article: ['PMC9046468']\n- Multiple articles: ['PMC9046468', 'PMC8123456']" },
      },
      required: ['pmc_ids'],
    },
    annotations: readOnly,
  },
  {
    name: 'get_copyright_status',
    description: `Get copyright information for articles in PubMed.${SCOPE}`,
    inputSchema: {
      type: 'object',
      properties: {
        pmids: { type: 'array', items: { type: 'string' }, description: "Array of PubMed IDs to check copyright and licensing information.\n\nExamples:\n- Single article: ['35891187']\n- Multiple articles: ['35891187', '34375400']" },
      },
      required: ['pmids'],
    },
    annotations: readOnly,
  },
] as const;

// ---------------------------------------------------------------- answers from the fixtures

/** Splits at a top-level separator (outside parentheses and quotes). */
function splitTop(text: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0, quoted = false, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '(') depth++;
    else if (!quoted && c === ')') depth--;
    else if (!quoted && depth === 0) {
      const m = sep.exec(text.slice(i));
      if (m && m.index === 0) { parts.push(text.slice(start, i)); i += m[0].length - 1; start = i + 1; }
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const unwrap = (s: string): string => {
  let t = s.trim();
  while (t.startsWith('(') && t.endsWith(')') && balanced(t.slice(1, -1))) t = t.slice(1, -1).trim();
  return t;
};
function balanced(s: string): boolean {
  let d = 0;
  for (const c of s) { if (c === '(') d++; else if (c === ')' && --d < 0) return false; }
  return d === 0;
}
const term = (s: string) => s.replace(/\[[^\]]*\]/g, '').replace(/"/g, '').trim().toLowerCase();

/** A small PubMed: AND of clauses, each an OR of phrases (field tags ignored), NOT excludes. */
function matches(query: string, a: FakeArticle): boolean {
  const text = [a.title, a.abstract, ...a.mesh_terms, ...a.article_types].join(' ').toLowerCase();
  const test = (expr: string): boolean => {
    const e = unwrap(expr);
    const ands = splitTop(e, /^\s+AND\s+/);
    if (ands.length > 1) return ands.every(test);
    const nots = splitTop(e, /^\s+NOT\s+/);
    if (nots.length > 1) return test(nots[0]!) && !nots.slice(1).some(test);
    const ors = splitTop(e, /^\s+OR\s+/);
    if (ors.length > 1) return ors.some(test);
    const t = term(e);
    return !!t && text.includes(t);
  };
  return test(query);
}

/** `2025`, `2025/11` or `2025/11/21` as the first (or last) day it covers. */
function day(date: string, end: boolean): string {
  const [y, m, d] = date.split(/[/-]/);
  return `${y}/${(m ?? (end ? '12' : '01')).padStart(2, '0')}/${(d ?? (end ? '31' : '01')).padStart(2, '0')}`;
}
const pubDate = (a: FakeArticle) => `${a.publication_date.year}/${a.publication_date.month}/${a.publication_date.day}`;
const translate = (q: string) => q.replace(/"([^"]+)"(?!\[)/g, '"$1"[All Fields]');

function search(args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim();
  if (!query || query.includes('*')) throw new Error('the query cannot be empty or use wildcards');
  const max = Number(args.max_results ?? 20);
  const retstart = Number(args.retstart ?? 0);
  const which = (a: FakeArticle) => (args.datetype === 'edat' || args.datetype === 'mdat' ? a.entry_date : pubDate(a));
  const from = typeof args.date_from === 'string' ? day(args.date_from, false) : undefined;
  const to = typeof args.date_to === 'string' ? day(args.date_to, true) : undefined;
  const found = all()
    .filter((a) => matches(query, a) && (!from || which(a) >= from) && (!to || which(a) <= to))
    .sort((a, b) => (args.sort === 'title' ? a.title.localeCompare(b.title) : b.entry_date.localeCompare(a.entry_date)));
  const pmids = found.slice(retstart, retstart + max).map((a) => a.identifiers.pmid);
  return { pmids, total_count: found.length, returned_count: pmids.length, query, query_translation: translate(query), has_more: retstart + pmids.length < found.length };
}

const byPmid = (pmid: string) => all().find((a) => a.identifiers.pmid === pmid);
const byPmc = (pmc: string) => all().find((a) => a.identifiers.pmc && a.identifiers.pmc.replace(/^PMC/, '') === pmc.replace(/^PMC/, ''));

function metadata(a: FakeArticle) {
  const { entry_date: _e, full_text: _f, ...rest } = a;
  return { ...rest, doi: a.identifiers.doi };
}

function answer(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const list = (k: string) => (Array.isArray(args[k]) ? (args[k] as unknown[]).map(String) : []);
  switch (name) {
    case 'search_articles':
      return search(args);
    case 'get_article_metadata': {
      const articles = list('pmids').map(byPmid).filter((a): a is FakeArticle => !!a).map(metadata);
      return { articles, count: articles.length };
    }
    case 'find_related_articles': {
      const ids = list('pmids');
      const linkname = String(args.link_type ?? 'pubmed_pubmed');
      const max = typeof args.max_results === 'number' ? args.max_results : 20;
      const links = linkname === 'pubmed_pmc'
        ? ids.map(byPmid).flatMap((a) => (a?.identifiers.pmc ? [a.identifiers.pmc.replace(/^PMC/, '')] : []))
        : linkname === 'pubmed_pubmed'
          ? [...ids, ...all().map((a) => a.identifiers.pmid).filter((p) => !ids.includes(p))]
          : [];
      return { linksets: [{ dbfrom: 'pubmed', ids, linksetdbs: links.length ? [{ dbto: linkname.split('_')[1], linkname, links: links.slice(0, max) }] : [] }] };
    }
    case 'lookup_article_by_citation': {
      const citations = (Array.isArray(args.citations) ? args.citations : []) as Record<string, unknown>[];
      return {
        citations: citations.map((c) => {
          const hit = all().find((a) =>
            (c.journal === undefined || [a.journal.title, a.journal.iso_abbreviation].includes(String(c.journal)))
            && (c.year === undefined || a.publication_date.year === String(c.year))
            && (c.volume === undefined || a.citation.volume === String(c.volume))
            && (c.first_page === undefined || a.citation.pages.split('-')[0] === String(c.first_page))
            && (c.author === undefined || a.authors[0]?.last_name === String(c.author)));
          return { ...c, ...(c.year !== undefined ? { year: String(c.year) } : {}), ...(hit ? { pmid: hit.identifiers.pmid } : { pmid: null }) };
        }),
      };
    }
    case 'convert_article_ids': {
      const type = String(args.id_type ?? 'pmid');
      const find = (id: string) => (type === 'doi' ? all().find((a) => a.identifiers.doi === id) : type === 'pmcid' ? byPmc(id) : byPmid(id));
      return {
        status: 'ok',
        records: list('ids').map((id) => {
          const a = find(id);
          return a ? { 'requested-id': id, pmid: a.identifiers.pmid, doi: a.identifiers.doi, ...(a.identifiers.pmc ? { pmcid: a.identifiers.pmc } : {}) } : { 'requested-id': id, status: 'error', errmsg: 'invalid article id' };
        }),
      };
    }
    case 'get_full_text_article': {
      const articles = list('pmc_ids').map(byPmc).filter((a): a is FakeArticle => !!a?.full_text)
        .map((a) => ({ pmc_id: a.identifiers.pmc, pmid: a.identifiers.pmid, doi: a.identifiers.doi, title: a.title, full_text: a.full_text }));
      if (!articles.length) throw new Error('External API error occurred. Please check your request parameters.');
      return { articles, count: articles.length };
    }
    case 'get_copyright_status': {
      const results = list('pmids').map(byPmid).filter((a): a is FakeArticle => !!a).map((a) => ({
        pmid: a.identifiers.pmid, pmc_id: a.identifiers.pmc ?? null,
        copyright: { statement: `Copyright © ${a.publication_date.year} the authors (example).`, year: a.publication_date.year, holder: 'The authors' },
        license: a.identifiers.pmc ? { type: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', is_open_access: true } : { type: 'All rights reserved', url: null, is_open_access: false },
        source: 'pubmed', available_at: { pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${a.identifiers.pmid}/`, doi_url: `https://doi.org/${a.identifiers.doi}` },
      }));
      return { results, count: results.length };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function server(calls: { name: string; args: Record<string, unknown> }[]): Server {
  const s = new Server({ name: 'pubmed', version: '1.0.0' }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: PUBMED_TOOLS.map((t) => structuredClone(t) as unknown as { name: string; inputSchema: { type: 'object' } }) }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    calls.push({ name: req.params.name, args });
    try {
      const result = answer(req.params.name, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
    }
  });
  return s;
}

/**
 * Starts the fake on a random local port. `url` is its MCP endpoint (`.../mcp`); `calls` lists
 * every tool call it answered, in order. Stateless: a fresh server and transport per request.
 */
export async function startFakePubmed(): Promise<{
  url: string; stop: () => Promise<void>; calls: { name: string; args: Record<string, unknown> }[];
  /** PubMed adds a paper (until `stop`). */
  add: (article: FakeArticle) => void;
}> {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const http = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (new URL(req.url).pathname !== '/mcp') return new Response('not found', { status: 404 });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const s = server(calls);
      await s.connect(transport);
      try {
        return await transport.handleRequest(req);
      } finally {
        // The JSON answer is complete when handleRequest returns; nothing stays open.
        void s.close().catch(() => undefined);
      }
    },
  });
  return {
    url: `http://127.0.0.1:${http.port}/mcp`,
    calls,
    add: (article) => { added.push(article); },
    stop: async () => { added.length = 0; await http.stop(true); },
  };
}
