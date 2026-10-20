/**
 * One plugin (22 §10): its manifest, tools with their effective class in this domain and where
 * that class came from, workflows, skills, capabilities, records, servers, install notes, and the
 * binding's history. Presentational; the Binding tab is the binding review.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, BookOpen, Puzzle, Server, Wrench } from 'lucide-react'
import type { MwPluginDetail, MwPluginTool } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Info_Page } from '@/components/info/Info_Page'
import { Info_Section } from '@/components/info/Info_Section'
import { Info_Table } from '@/components/info/Info_Table'
import { cn } from '@/lib/utils'
import { absoluteTime, humanize, relativeTime } from '../format'
import { EffectBadge, Pill } from '../playbook/Tags'
import { effectLabel } from '../playbook/labels'
import { bindingBadge, classSourceLabel, trustLabel } from './plugin-model'

export interface PluginOverviewProps {
  plugin: MwPluginDetail
  /** Opens a live playbook that came from this plugin. */
  onOpenPlaybook?: (workflowId: string) => void
  now?: number
}

export function PluginHero({ plugin, now }: { plugin: MwPluginDetail; now?: number }) {
  const { t, i18n } = useTranslation()
  const badge = bindingBadge(plugin, t)
  const b = plugin.binding
  return (
    <Info_Page.Hero
      avatar={<div className="grid size-full place-items-center bg-fill-hover text-secondary [&_svg]:size-4"><Puzzle /></div>}
      title={plugin.title}
      tagline={plugin.description}
      meta={
        <>
          <Info_Badge color={badge.tone} data-binding-status={b.status}>{badge.label}</Info_Badge>
          <span>{t('memwise.plugins.versionShort', { version: plugin.version })}</span>
          <span>{trustLabel(plugin.trust, t)}</span>
          {b.status === 'bound' && b.frozenAt && (
            <span title={absoluteTime(b.frozenAt, i18n.language)}>
              {b.frozenByName
                ? t('memwise.plugins.boundBy', { name: b.frozenByName, time: relativeTime(b.frozenAt, now, i18n.language) })
                : t('memwise.plugins.boundAt', { time: relativeTime(b.frozenAt, now, i18n.language) })}
            </span>
          )}
        </>
      }
    />
  )
}

function ToolRow({ tool }: { tool: MwPluginTool }) {
  const { t } = useTranslation()
  return (
    <li className={cn('flex flex-col gap-1 px-4 py-2.5', tool.off && 'opacity-60')} data-tool={tool.name} data-class-from={tool.from}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-label text-foreground">{tool.name}</span>
        {tool.off ? (
          <Pill className="bg-fill-hover text-tertiary">{t('memwise.binding.toolOff')}</Pill>
        ) : (
          <EffectBadge effect={tool.effect ?? 'irreversible'} classified={!!tool.effect} />
        )}
        <span className="text-label-sm text-tertiary">
          {/* MCP hints only suggest a class; until the binding sets one the tool counts as irreversible. */}
          {!tool.effect && tool.hinted
            ? <>{t('memwise.plugins.classFrom.none')} · {t('memwise.binding.hintedAs', { effect: effectLabel(tool.hinted, t) })}</>
            : tool.from === 'binding' && !tool.reason && tool.declared && tool.effect === tool.declared
              // The binding kept the plugin's declared class as it is.
              ? t('memwise.plugins.classFrom.declared')
              : classSourceLabel(tool.from, t, tool)}
        </span>
        {tool.capability && <Pill className="bg-fill-hover text-secondary">{t('memwise.binding.provides', { capability: tool.capability })}</Pill>}
      </div>
      {tool.description && <p className="text-label-sm text-secondary">{tool.description}</p>}
      {tool.reason && <p className="text-label-sm text-tertiary">{t('memwise.plugins.classReason', { reason: tool.reason })}</p>}
      {tool.declared && tool.effect && tool.declared !== tool.effect && (
        <p className="text-label-sm text-tertiary">{t('memwise.binding.declaredAs', { effect: tool.declared })}</p>
      )}
    </li>
  )
}

export function PluginOverview({ plugin, onOpenPlaybook, now }: PluginOverviewProps) {
  const { t, i18n } = useTranslation()
  return (
    <div className="space-y-6" data-plugin-overview={plugin.id}>
      {plugin.notes.length > 0 && (
        <Info_Alert variant="warning" icon={<AlertTriangle />}>
          <Info_Alert.Title>{t('memwise.plugins.notesTitle')}</Info_Alert.Title>
          <Info_Alert.Description>
            <ul className="list-disc space-y-0.5 pl-4">
              {plugin.notes.map(n => <li key={n}>{n}</li>)}
            </ul>
          </Info_Alert.Description>
        </Info_Alert>
      )}

      <Info_Section title={t('memwise.plugins.manifest')}>
        <Info_Table>
          <Info_Table.Row label={t('memwise.plugins.id')} value={<span className="font-mono">{plugin.id}</span>} />
          <Info_Table.Row label={t('memwise.plugins.version')} value={plugin.versions.join(', ')} />
          <Info_Table.Row label={t('memwise.plugins.trustLabel')} value={trustLabel(plugin.trust, t)} />
          {plugin.imported && <Info_Table.Row label={t('memwise.plugins.importedLabel')} value={t('memwise.plugins.importedClaude')} />}
          <Info_Table.Row label={t('memwise.plugins.folder')} value={<span className="font-mono text-label-sm [overflow-wrap:anywhere]">{plugin.dir}</span>} />
          <Info_Table.Row label={t('memwise.plugins.hash')} value={<span className="font-mono text-label-sm">{plugin.hash.slice(0, 12)}</span>} />
          {plugin.environment?.runtime && <Info_Table.Row label={t('memwise.plugins.runtime')} value={plugin.environment.runtime} />}
          {plugin.environment?.network?.length ? <Info_Table.Row label={t('memwise.plugins.network')} value={plugin.environment.network.join(', ')} /> : null}
        </Info_Table>
      </Info_Section>

      <Info_Section title={t('memwise.binding.section.tools')} count={plugin.toolList.length} description={t('memwise.plugins.toolsDescription')}>
        {plugin.toolList.length === 0 ? (
          <p className="px-4 py-3 text-label text-tertiary">{t('memwise.binding.noTools')}</p>
        ) : (
          <ul className="divide-y divide-separator">{plugin.toolList.map(tool => <ToolRow key={tool.name} tool={tool} />)}</ul>
        )}
      </Info_Section>

      {plugin.workflowList.length > 0 && (
        <Info_Section title={t('memwise.plugins.workflows')} count={plugin.workflowList.length}>
          <ul className="divide-y divide-separator">
            {plugin.workflowList.map(w => (
              <li key={w.id} className="flex items-center gap-2 px-4 py-2.5" data-plugin-workflow={w.id}>
                <BookOpen className="size-3.5 shrink-0 text-tertiary" />
                {w.live && onOpenPlaybook ? (
                  <button type="button" className="text-label font-medium text-foreground hover:underline" onClick={() => onOpenPlaybook(w.id)}>{w.title}</button>
                ) : (
                  <span className="text-label font-medium text-foreground">{w.title}</span>
                )}
                <span className="flex-1" />
                <Info_Badge color={w.live ? 'success' : 'muted'}>{w.live ? t('memwise.plugins.workflowLive') : t('memwise.plugins.workflowNotLive')}</Info_Badge>
              </li>
            ))}
          </ul>
        </Info_Section>
      )}

      {(plugin.providesList.length > 0 || plugin.requiresList.length > 0) && (
        <Info_Section title={t('memwise.binding.section.capabilities')}>
          <Info_Table>
            {plugin.providesList.map(c => (
              <Info_Table.Row key={`p:${c.name}`} label={t('memwise.binding.provides', { capability: c.name })} value={t('memwise.plugins.capabilityProvided', { tool: c.tool })} />
            ))}
            {plugin.requiresList.map(c => (
              <Info_Table.Row
                key={`r:${c.name}`}
                label={t('memwise.plugins.capabilityNeeds', { capability: c.name })}
                value={c.boundTo
                  ? t('memwise.plugins.capabilityBound', { tool: c.boundTo })
                  : c.optional ? t('memwise.plugins.capabilityOptional') : t('memwise.binding.noProvider')}
              />
            ))}
          </Info_Table>
        </Info_Section>
      )}

      {plugin.skills.length > 0 && (
        <Info_Section title={t('memwise.plugins.skills')} count={plugin.skills.length}>
          <ul className="divide-y divide-separator">
            {plugin.skills.map(s => (
              <li key={s.name} className="px-4 py-2.5">
                <div className="font-mono text-label text-foreground">{s.name}</div>
                {s.description && <p className="text-label-sm text-secondary">{s.description}</p>}
              </li>
            ))}
          </ul>
        </Info_Section>
      )}

      {(plugin.entities.length > 0 || plugin.records.length > 0 || plugin.roles.length > 0) && (
        <Info_Section title={t('memwise.plugins.expects')} description={t('memwise.plugins.expectsDescription')}>
          <Info_Table>
            {plugin.entities.map(e => (
              <Info_Table.Row key={`e:${e.name}`} label={humanize(e.name)} value={e.fields.map(f => f.name).join(', ')} />
            ))}
            {plugin.records.map(r => (
              <Info_Table.Row key={`r:${r.name}`} label={r.title ?? humanize(r.name)} value={t('memwise.plugins.recordKind', { key: r.key, count: Object.keys(r.fields).length })} />
            ))}
            {plugin.roles.length > 0 && <Info_Table.Row label={t('memwise.binding.section.roles')} value={plugin.roles.map(r => r.title).join(', ')} />}
          </Info_Table>
        </Info_Section>
      )}

      {plugin.servers.length > 0 && (
        <Info_Section title={t('memwise.plugins.servers')} count={plugin.servers.length}>
          <ul className="divide-y divide-separator">
            {plugin.servers.map(s => (
              <li key={s.name} className="flex items-center gap-2 px-4 py-2.5">
                <Server className="size-3.5 shrink-0 text-tertiary" />
                <span className="text-label font-medium">{s.name}</span>
                <span className="min-w-0 truncate font-mono text-label-sm text-tertiary">{s.detail}</span>
              </li>
            ))}
          </ul>
        </Info_Section>
      )}

      <Info_Section title={t('memwise.plugins.history')} count={plugin.bindingHistory.length}>
        {plugin.bindingHistory.length === 0 ? (
          <p className="px-4 py-3 text-label text-tertiary">{t('memwise.plugins.historyNone')}</p>
        ) : (
          <ul className="divide-y divide-separator" data-binding-history>
            {plugin.bindingHistory.map(v => (
              <li key={v.version} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-4 py-2.5 text-label">
                <Wrench className="size-3.5 shrink-0 text-tertiary" />
                <span className="font-medium">{t('memwise.plugins.bindingVersion', { version: v.version })}</span>
                <span className="text-secondary">{t('memwise.plugins.forPluginVersion', { version: v.pluginVersion })}</span>
                <span className="flex-1" />
                <span className="text-label-sm text-tertiary" title={absoluteTime(v.frozenAt, i18n.language)}>
                  {v.frozenByName ?? v.frozenBy
                    ? t('memwise.plugins.frozenBy', { name: v.frozenByName ?? v.frozenBy, time: relativeTime(v.frozenAt, now, i18n.language) })
                    : relativeTime(v.frozenAt, now, i18n.language)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Info_Section>
    </div>
  )
}
