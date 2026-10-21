import * as React from 'react'
import type { ComponentEntry } from './types'
import type { MwInboxItem, MwRecordWriteResult, MwSubmitResult, MwView } from '@memwise/shared/protocol'
import { Info_Page } from '@/components/info/Info_Page'
import { CaseView } from '@/components/memwise/CaseView'
import { InboxItemView, type InboxActions } from '@/components/memwise/InboxItemView'
import { peopleById } from '@/components/memwise/format'
import { sampleCase, samplePeople, samplePlaybook, sampleRoles } from '@/components/memwise/sample-data'
import { AutomationsView } from '@/components/memwise/automations/AutomationsView'
import { DashboardView } from '@/components/memwise/domains/DashboardView'
import { DomainView, PagesOverview } from '@/components/memwise/domains/DomainView'
import { EntityView, viewToState, type RecordsViewState } from '@/components/memwise/domains/EntitiesView'
import { RecordPageView } from '@/components/memwise/records/RecordPageView'
import type { RecordPageActions } from '@/components/memwise/records/RecordBlocks'
import type { ReviewSubmit } from '@/components/memwise/records/DocumentReview'
import {
  SAMPLE_NOW,
  sampleDashboard,
  sampleDiffReviewItem,
  sampleDocumentPage,
  sampleDocumentReviewPage,
  sampleDomains,
  sampleFlagItem,
  sampleSitePage,
  sampleSiteType,
  sampleSitesQuery,
  sampleStudyPage,
  sampleTableReviewItem,
  sampleTriggerHoldItem,
  sampleTriggers,
  sampleViews,
  samplePdf,
  withPhase6Case,
} from '@/components/memwise/records/sample-records'
import { sampleArticlePage, sampleLiteratureDashboard, sampleTopicPage } from '@/components/memwise/records/sample-literature'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const log = (...args: unknown[]) => console.log('[playground]', ...args)
const people = peopleById(samplePeople)
const etmf = sampleDomains[0]!

const recordActions: RecordPageActions & { openChat?: () => void } = {
  openRecord: (entity, id) => log('open record', entity, id),
  openCase: id => log('open case', id),
  openView: (entity, filter) => log('open view', entity, filter),
  startPlaybook: id => log('start playbook', id),
  update: async (values, reason): Promise<MwRecordWriteResult> => { await wait(400); log('update', values, reason); return { applied: true, status: 'applied', version: 8 } },
  transition: async (transition, reason): Promise<MwRecordWriteResult> => { await wait(400); log('move', transition, reason); return { applied: true, status: 'applied' } },
  saveNote: async (body, reason): Promise<MwRecordWriteResult> => { await wait(400); log('note', body, reason); return { applied: true, status: 'applied' } },
  exportAudit: async format => { await wait(300); log('export audit', format) },
  openChat: () => log('ask in chat'),
}

/** A sign that takes "correct horse", refuses anything else, and locks on "lock". */
async function mockSign(input: ReviewSubmit): Promise<MwSubmitResult> {
  await wait(500)
  if (!input.signature) return { applied: true }
  if (input.signature.password === 'lock') return { applied: false, code: 'submit.locked', retryAfter: new Date(Date.now() + 15 * 60_000).toISOString() }
  if (input.signature.password !== 'correct horse') return { applied: false, code: 'submit.signature-failed' }
  return { applied: true }
}

// ---------------------------------------------------------------- record pages

const LAYOUTS = { single: sampleStudyPage, split: sampleDocumentPage, sidebar: sampleSitePage } as const

function RecordPageDemo({ layout, width }: { layout: keyof typeof LAYOUTS; width: 'wide' | 'narrow' }) {
  const page = LAYOUTS[layout]
  const files = React.useMemo(() => ({ file: { data: samplePdf() } }), [])
  return (
    <div className={width === 'narrow' ? 'w-[420px]' : 'w-full'}>
      <div className="h-[860px] overflow-auto rounded-lg bg-background shadow-elev-1">
        <Info_Page>
          <RecordPageView key={layout} page={page} actions={recordActions} files={files} now={SAMPLE_NOW} />
        </Info_Page>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- literature (25 §4–§5)

function LiteratureDemo({ page, width }: { page: 'topic' | 'article' | 'overview'; width: 'wide' | 'narrow' }) {
  return (
    <div className={width === 'narrow' ? 'w-[420px]' : 'w-full'}>
      <div className="h-[860px] overflow-auto rounded-lg bg-background shadow-elev-1">
        <Info_Page>
          {page === 'overview'
            ? <DashboardView dashboard={sampleLiteratureDashboard} onOpenRecord={(e, id) => log('open record', e, id)} now={SAMPLE_NOW} />
            : <RecordPageView key={page} page={page === 'topic' ? sampleTopicPage : sampleArticlePage} actions={recordActions} now={SAMPLE_NOW} />}
        </Info_Page>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- document review

function DocumentReviewDemo({ signing, queue }: { signing: boolean; queue: boolean }) {
  const files = React.useMemo(() => ({ file: { data: samplePdf() } }), [])
  const [done, setDone] = React.useState(false)
  const [position, setPosition] = React.useState(1)
  return (
    <div className="h-[900px] w-full overflow-auto rounded-lg bg-background shadow-elev-1">
      <Info_Page>
        <RecordPageView
          key={`${signing}:${queue}:${done}:${position}`}
          page={done ? sampleDocumentPage : sampleDocumentReviewPage}
          actions={recordActions}
          files={files}
          now={SAMPLE_NOW}
          review={done ? undefined : {
            submit: mockSign,
            onDone: () => (queue && position < 3 ? setPosition(p => p + 1) : setDone(true)),
            roleTitle: r => sampleRoles.find(x => x.id === r)?.title ?? r,
            initialSigning: signing,
            ...(queue ? { queue: { position, total: 3, onNext: () => setPosition(p => Math.min(3, p + 1)), onPrevious: () => setPosition(p => Math.max(1, p - 1)), onStop: () => setDone(true) } } : {}),
          }}
        />
      </Info_Page>
    </div>
  )
}

// ---------------------------------------------------------------- inbox: table, diff, flag, held firings

const PHASE6_ITEMS: Record<string, MwInboxItem> = {
  table: sampleTableReviewItem,
  diff: sampleDiffReviewItem,
  flag: sampleFlagItem,
  held: sampleTriggerHoldItem,
}

function inboxActions(): InboxActions {
  const answer = async (input?: { signature?: { password: string } }): Promise<MwSubmitResult> => {
    await wait(500)
    if (input?.signature && input.signature.password !== 'correct horse') return { applied: false, code: 'submit.signature-failed' }
    return { applied: true }
  }
  return {
    submitStep: answer,
    decideApproval: () => answer(),
    sendEvent: () => answer(),
    openCase: id => log('open case', id),
    openRecord: (entity, id) => log('open record', entity, id),
    openAutomations: () => log('open automations'),
    releaseTrigger: async (trigger, decision) => { await wait(500); log('release', trigger, decision); return { applied: true, started: decision === 'start' ? 300 : 0 } },
  }
}

function InboxPhase6Demo({ kind, signs }: { kind: keyof typeof PHASE6_ITEMS; signs: boolean }) {
  const base = PHASE6_ITEMS[kind]!
  const item = signs && (base.kind === 'input' || base.kind === 'decision') ? { ...base, sign: { meaning: 'Reviewed and approved for filing in the TMF' } } : base
  return (
    <div className="h-[760px] w-full overflow-auto rounded-lg bg-background shadow-elev-1">
      <Info_Page>
        <InboxItemView key={`${kind}:${signs}`} item={item} actions={inboxActions()} people={people} roles={sampleRoles} now={SAMPLE_NOW} signer={{ name: 'Priya Shah', role: 'TMF specialist' }} />
      </Info_Page>
    </div>
  )
}

// ---------------------------------------------------------------- dashboard, entities, automations, domain, case

function DashboardDemo() {
  const [refreshing, setRefreshing] = React.useState(false)
  return (
    <div className="h-[860px] w-full overflow-auto rounded-lg bg-background shadow-elev-1">
      <Info_Page>
        <DashboardView
          dashboard={sampleDashboard}
          now={SAMPLE_NOW}
          refreshing={refreshing}
          onRefresh={async () => { setRefreshing(true); await wait(600); setRefreshing(false) }}
          onOpenRecord={(entity, id) => log('open record', entity, id)}
        />
      </Info_Page>
    </div>
  )
}

function EntitiesDemo({ tab: initialTab }: { tab: 'records' | 'definition' }) {
  const [tab, setTab] = React.useState(initialTab)
  React.useEffect(() => setTab(initialTab), [initialTab])
  const [views, setViews] = React.useState<MwView[]>(sampleViews)
  const [state, setState] = React.useState<RecordsViewState>(() => viewToState(null))
  // A filter with "!!" stands for one the server can't read.
  const broken = state.filter.includes('!!')
  return (
    <div className="h-[860px] w-full overflow-auto rounded-lg bg-background shadow-elev-1">
      <Info_Page>
        <EntityView
          domain={etmf}
          type={sampleSiteType}
          tab={tab}
          onTab={setTab}
          views={views}
          state={state}
          onState={setState}
          result={broken ? null : sampleSitesQuery}
          error={broken ? "Unexpected '!' at position 9. Use = != < > and, or, not." : null}
          onOpenRecord={(entity, id) => log('open record', entity, id)}
          onOpenPlaybook={id => log('open playbook', id)}
          onSaveView={async view => {
            await wait(300)
            const saved: MwView = { ...view, id: `my-${view.id || views.length}`, domain: 'etmf', personal: true }
            setViews(v => [...v, saved])
            return saved
          }}
        />
      </Info_Page>
    </div>
  )
}

function AutomationsDemo() {
  return (
    <div className="h-[760px] w-full overflow-auto rounded-lg bg-background shadow-elev-1">
      <Info_Page>
        <AutomationsView
          triggers={sampleTriggers}
          domains={sampleDomains}
          now={SAMPLE_NOW}
          onOpenPlaybook={id => log('open playbook', id)}
          onOpenRecord={(entity, id) => log('open record', entity, id)}
          release={async (trigger, decision) => { await wait(500); log('release', trigger, decision); return { applied: true, started: decision === 'start' ? 300 : 0 } }}
        />
      </Info_Page>
    </div>
  )
}

function DomainDemo({ screen }: { screen: 'domain' | 'rules' | 'pages' }) {
  const [filter, setFilter] = React.useState<string | null>(null)
  return (
    <div className="h-[860px] w-full overflow-auto rounded-lg bg-background shadow-elev-1">
      <Info_Page>
        {screen === 'pages' ? (
          <PagesOverview
            domains={sampleDomains}
            workspacePages={[{ slug: 'welcome', name: 'Welcome' }, { slug: 'sops', name: 'SOP index' }]}
            domainFilter={filter}
            onDomainFilter={setFilter}
            onOpenDomainPage={(d, p) => log('open page', d, p)}
            onOpenEntities={(d, e) => log('open entities', d, e)}
            onOpenWorkspacePage={s => log('open workspace page', s)}
            onOpenLibrary={() => log('open library')}
          />
        ) : (
          <DomainView
            key={screen}
            domain={etmf}
            tab={screen === 'rules' ? 'rules' : undefined}
            onOpenEntities={e => log('open entities', e)}
            onOpenPlaybook={id => log('open playbook', id)}
            onOpenPage={p => log('open page', p)}
            onOpenAutomations={() => log('open automations')}
          />
        )}
      </Info_Page>
    </div>
  )
}

function CaseLinksDemo() {
  return (
    <div className="h-[860px] w-full overflow-auto rounded-lg bg-background shadow-elev-1">
      <Info_Page>
        <CaseView
          kase={withPhase6Case(sampleCase)}
          playbook={samplePlaybook}
          people={people}
          roles={sampleRoles}
          now={SAMPLE_NOW}
          onOpenCase={id => log('open case', id)}
          onOpenRecord={(entity, id) => log('open record', entity, id)}
        />
      </Info_Page>
    </div>
  )
}

const opts = <T extends string>(...values: T[]) => values.map(v => ({ label: v, value: v }))

export const memwiseRecordsComponents: ComponentEntry[] = [
  {
    id: 'memwise-record-page',
    name: 'Record page',
    category: 'MemWise',
    description: 'A record drawn from its layout: single, split (a document beside its fields) or sidebar. Fields carry where each value came from; edit in place (a regulated domain asks why). Narrow stacks the columns.',
    component: RecordPageDemo,
    layout: 'top',
    props: [
      { name: 'layout', control: { type: 'select', options: opts('single', 'split', 'sidebar') }, defaultValue: 'sidebar' },
      { name: 'width', control: { type: 'select', options: opts('wide', 'narrow') }, defaultValue: 'wide' },
    ],
    variants: [
      { name: 'Site (sidebar)', props: { layout: 'sidebar', width: 'wide' } },
      { name: 'Study (single)', props: { layout: 'single', width: 'wide' } },
      { name: 'Document (split)', props: { layout: 'split', width: 'wide' } },
      { name: 'Document, narrow', props: { layout: 'split', width: 'narrow' } },
    ],
  },
  {
    id: 'memwise-literature',
    name: 'Literature pages',
    category: 'MemWise',
    description: 'Literature watch (25 §4–§5): a Topic with KPI tiles, a bar chart, a forest plot and "Ask about this topic"; an Article with its abstract and the quotes its values were read from (hover names the field; the quote button beside a value scrolls to it); a free page with charts.',
    component: LiteratureDemo,
    layout: 'top',
    props: [
      { name: 'page', control: { type: 'select', options: opts('topic', 'article', 'overview') }, defaultValue: 'topic' },
      { name: 'width', control: { type: 'select', options: opts('wide', 'narrow') }, defaultValue: 'wide' },
    ],
    variants: [
      { name: 'Topic', props: { page: 'topic', width: 'wide' } },
      { name: 'Topic, narrow', props: { page: 'topic', width: 'narrow' } },
      { name: 'Article', props: { page: 'article', width: 'wide' } },
      { name: 'Overview (free page)', props: { page: 'overview', width: 'wide' } },
    ],
  },
  {
    id: 'memwise-document-review',
    name: 'Document review',
    category: 'MemWise',
    description: 'The record page in review mode: proposed values with their quotes highlighted in the PDF, checks, a comment, Send back or Approve and sign. The password "correct horse" signs; "lock" shows the lock-out. After approving, the page returns to normal mode.',
    component: DocumentReviewDemo,
    layout: 'top',
    props: [
      { name: 'signing', description: 'Open the signing dialog at once', control: { type: 'boolean' }, defaultValue: false },
      { name: 'queue', description: 'Review in a row (keys a/s/j/k)', control: { type: 'boolean' }, defaultValue: false },
    ],
    variants: [
      { name: 'Review', props: { signing: false, queue: false } },
      { name: 'Signing', props: { signing: true, queue: false } },
      { name: 'In a row', props: { signing: false, queue: true } },
    ],
  },
  {
    id: 'memwise-inbox-phase6',
    name: 'Inbox: tables, diffs, flags, held firings',
    category: 'MemWise',
    description: 'Phase 6 inbox items: a table review (accept, edit or reject rows), a diff review, a record flag and a trigger whose firings were held.',
    component: InboxPhase6Demo,
    layout: 'top',
    props: [
      { name: 'kind', control: { type: 'select', options: opts('table', 'diff', 'flag', 'held') }, defaultValue: 'table' },
      { name: 'signs', description: 'The step signs (approving asks for the password)', control: { type: 'boolean' }, defaultValue: false },
    ],
    variants: opts('table', 'diff', 'flag', 'held').map(o => ({ name: o.label, props: { kind: o.value, signs: false } })),
  },
  {
    id: 'memwise-dashboard',
    name: 'Dashboard',
    category: 'MemWise',
    description: 'TMF health: numbers against their targets, the completeness heatmap and record lists.',
    component: DashboardDemo,
    layout: 'top',
    props: [],
  },
  {
    id: 'memwise-entities',
    name: 'Entities',
    category: 'MemWise',
    description: 'An entity\'s records as a table or board (filter, sort, group, columns, shared views, "Save as my view"), and its definition. A filter with "!!" shows the plain error.',
    component: EntitiesDemo,
    layout: 'top',
    props: [{ name: 'tab', control: { type: 'select', options: opts('records', 'definition') }, defaultValue: 'records' }],
    variants: [{ name: 'Records', props: { tab: 'records' } }, { name: 'Definition', props: { tab: 'definition' } }],
  },
  {
    id: 'memwise-automations',
    name: 'Automations',
    category: 'MemWise',
    description: 'Every trigger by domain, with last and next firing, and held firings to start or discard.',
    component: AutomationsDemo,
    layout: 'top',
    props: [],
  },
  {
    id: 'memwise-domain',
    name: 'Domain and pages',
    category: 'MemWise',
    description: 'A domain\'s page (entities, playbooks, pages, house rules, hand-offs) and the cross-domain Pages overview.',
    component: DomainDemo,
    layout: 'top',
    props: [{ name: 'screen', control: { type: 'select', options: opts('domain', 'rules', 'pages') }, defaultValue: 'domain' }],
    variants: opts('domain', 'rules', 'pages').map(o => ({ name: o.label, props: { screen: o.value } })),
  },
  {
    id: 'memwise-case-links',
    name: 'Case: links and waiting',
    category: 'MemWise',
    description: 'A case started by another, calling a third, waiting until a record condition holds.',
    component: CaseLinksDemo,
    layout: 'top',
    props: [],
  },
]
