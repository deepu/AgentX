/**
 * The content panel for the Plugins section: a plugin's page (overview and its binding review),
 * and one entity's records with the record detail in a side sheet.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { Briefcase, Link as LinkIcon, Puzzle } from 'lucide-react'
import type { MwWriteDraftResult } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Page } from '@/components/info/Info_Page'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DetailEmptyState } from '@/components/app-shell/DetailEmptyState'
import { navigate, routes } from '@/lib/navigate'
import { Spinner } from '@memwise/ui'
import { memwiseEntityTypesAtom, memwisePeopleAtom, memwisePluginsAtom, memwiseRolesAtom, memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi, useMemwiseBinding, useMemwiseEntityRecord, useMemwiseEntityRows, useMemwisePlugin, useMemwiseRefresh } from '@/hooks/useMemwise'
import { MemwiseStatusBanner } from '../MemwiseStatus'
import { humanize, peopleById } from '../format'
import { BindingReview } from './BindingReview'
import { PluginHero, PluginOverview } from './PluginView'
import { RecordsTable, RecordView, rowTitle } from './RecordsView'
import { bindingCase } from './plugin-model'

type PluginTab = 'overview' | 'binding'

export function PluginPage({ pluginId }: { pluginId: string | null }) {
  const { t } = useTranslation()
  const summaries = useAtomValue(memwisePluginsAtom)
  const roles = useAtomValue(memwiseRolesAtom)
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const refresh = useMemwiseRefresh()
  const { data: plugin, error, loading } = useMemwisePlugin(pluginId)
  const [tab, setTab] = React.useState<PluginTab>('overview')
  const showBinding = !!plugin && plugin.binding.status !== 'unbound'
  const { data: view, error: bindingError, reload } = useMemwiseBinding(showBinding && tab === 'binding' ? pluginId : null)
  const [binding, setBinding] = React.useState(false)
  const api = getMemwiseApi()

  React.useEffect(() => setTab('overview'), [pluginId])

  if (!pluginId) {
    return (
      <div className="flex h-full flex-col">
        <MemwiseStatusBanner className="m-4 mb-0" />
        <div className="min-h-0 flex-1"><DetailEmptyState message={summaries && summaries.length === 0 ? t('memwise.plugins.none') : t('memwise.plugins.select')} /></div>
      </div>
    )
  }

  const caseId = plugin ? bindingCase(plugin.binding) : undefined
  const canBind = !!plugin && !caseId && (plugin.binding.status === 'unbound' || !!plugin.upgradeAvailable) && typeof api?.memwiseBindPlugin === 'function'

  const bind = async () => {
    if (!api || !workspaceId || !plugin) return
    setBinding(true)
    try {
      const r = await api.memwiseBindPlugin(workspaceId, plugin.id)
      toast.success(t('memwise.plugins.bindStarted', { title: plugin.title }), { description: t('memwise.plugins.bindStartedDescription') })
      void refresh()
      navigate(routes.view.cases(r.caseId))
    } catch (err) {
      toast.error(t('memwise.plugins.bindFailed'), { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBinding(false)
    }
  }

  const save = view?.draftId && api && workspaceId
    ? async ({ path, content, summary }: { path: string; content: string; summary: string }): Promise<MwWriteDraftResult> => {
      const r = await api.memwiseWriteDraft(workspaceId, { draftId: view.draftId!, files: [{ path, content }], summary })
      if (r.applied) toast.success(t('memwise.editor.saved'))
      reload()
      return r
    }
    : undefined

  return (
    <Info_Page loading={loading && !plugin} error={!plugin && error ? error : undefined}>
      <Info_Page.Header
        title={plugin?.title ?? t('memwise.nav.plugins')}
        actions={plugin ? (
          <div className="flex items-center gap-1">
            {caseId && (
              <Button variant="ghost" size="sm" onClick={() => navigate(routes.view.cases(caseId))} data-action="open-binding-case">
                <Briefcase />
                {t('memwise.plugins.openCase')}
              </Button>
            )}
            {canBind && (
              <Button variant="primary" size="sm" onClick={() => void bind()} disabled={binding} data-action="bind-plugin">
                <LinkIcon />
                {binding ? t('memwise.plugins.binding') : plugin.binding.status === 'unbound' ? t('memwise.plugins.bind') : t('memwise.plugins.rebind')}
              </Button>
            )}
          </div>
        ) : undefined}
      />
      {plugin && (
        <Info_Page.Content>
          <PluginHero plugin={plugin} />
          <Tabs value={tab} onValueChange={v => setTab(v as PluginTab)}>
            <TabsList>
              <TabsTrigger value="overview"><Puzzle />{t('memwise.plugins.tabOverview')}</TabsTrigger>
              <TabsTrigger value="binding" disabled={!showBinding}>{t('memwise.plugins.tabBinding')}</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="mt-4">
              {plugin.binding.status === 'unbound' && (
                <Info_Alert variant="info" icon={<LinkIcon />} className="mb-4">
                  <Info_Alert.Title>{t('memwise.plugins.unboundTitle')}</Info_Alert.Title>
                  <Info_Alert.Description>{t('memwise.plugins.unboundDescription')}</Info_Alert.Description>
                </Info_Alert>
              )}
              <PluginOverview plugin={plugin} onOpenPlaybook={id => navigate(routes.view.playbooks(id))} />
            </TabsContent>
            <TabsContent value="binding" className="mt-4">
              {bindingError && !view && (
                <Info_Alert variant="error">
                  <Info_Alert.Title>{t('memwise.inbox.binding.loadFailed')}</Info_Alert.Title>
                  <Info_Alert.Description>{bindingError}</Info_Alert.Description>
                </Info_Alert>
              )}
              {!view && !bindingError && <div className="flex justify-center py-8"><Spinner /></div>}
              {view && <BindingReview view={view} roles={roles} mode={view.editable ? 'edit' : 'view'} onSave={save} />}
            </TabsContent>
          </Tabs>
        </Info_Page.Content>
      )}
    </Info_Page>
  )
}

export function RecordsPage({ entity }: { entity: string }) {
  const { t } = useTranslation()
  const types = useAtomValue(memwiseEntityTypesAtom)
  const people = peopleById(useAtomValue(memwisePeopleAtom))
  const { data: rows, error, loading } = useMemwiseEntityRows(entity)
  const [openId, setOpenId] = React.useState<string | null>(null)
  const type = types?.find(e => e.name === entity)

  React.useEffect(() => setOpenId(null), [entity])

  return (
    <Info_Page loading={loading && !rows} error={!rows && error ? error : undefined}>
      <Info_Page.Header title={humanize(entity)} />
      {rows && (
        <Info_Page.Content>
          <p className="text-label text-secondary">{t('memwise.records.description', { count: rows.length })}</p>
          <RecordsTable entity={entity} rows={rows} fields={type?.fields} selectedId={openId} onOpen={setOpenId} />
        </Info_Page.Content>
      )}
      <RecordDrawer
        entity={entity}
        id={openId}
        title={openId ? rowTitle(entity, rows?.find(r => r.id === openId) ?? { id: openId, values: {} }) : undefined}
        people={people}
        onClose={() => setOpenId(null)}
      />
    </Info_Page>
  )
}

function RecordDrawer({ entity, id, title, people, onClose }: {
  entity: string
  id: string | null
  title?: string
  people: ReturnType<typeof peopleById>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { data: record, error, loading } = useMemwiseEntityRecord(id ? entity : null, id)
  return (
    <Drawer direction="right" open={!!id} onOpenChange={open => { if (!open) onClose() }}>
      <DrawerContent className="data-[vaul-drawer-direction=right]:w-[min(640px,92vw)] data-[vaul-drawer-direction=right]:sm:max-w-none">
        <DrawerHeader className="border-b border-separator">
          <DrawerTitle>{record?.title ?? title ?? t('memwise.records.record')}</DrawerTitle>
          <DrawerDescription>{t('memwise.records.detailDescription', { entity: humanize(entity).toLowerCase() })}</DrawerDescription>
        </DrawerHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4">
            {loading && !record && <div className="flex justify-center py-8"><Spinner /></div>}
            {error && !record && <p className="text-label text-destructive" role="alert">{error}</p>}
            {record && <RecordView record={record} people={people} />}
          </div>
        </ScrollArea>
      </DrawerContent>
    </Drawer>
  )
}
