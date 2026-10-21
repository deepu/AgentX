/**
 * Project settings (26 §3, mock Settings): the template it started from and what it changed
 * ("Started from Phase 3 study, version 4 · this project changed 2 playbooks"), a newer version
 * to review, its people and their roles here, its connections (its own binding or the app's), its
 * settings, and Start / Archive / Save as template. Presentational; ProjectSettingsScreen calls
 * the host.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import type { MwProjectDetail, MwProjectPerson, MwRole } from '@memwise/shared/protocol'
import { Info_Page } from '@/components/info/Info_Page'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatValueInline, humanize } from '../format'
import { StatusPill } from './NewProjectView'
import { personRoles, templateLine } from './project-model'

export type ProjectSettingsBusy = 'people' | 'start' | 'archive' | 'discard' | 'template'

export interface ProjectSettingsViewProps {
  project: MwProjectDetail
  /** Roles a person can be given here (the project's apps' roles). */
  roles?: MwRole[]
  /** Titles of the other apps it runs (D105), by id. */
  appTitle?: (appId: string) => string
  busy?: ProjectSettingsBusy | null
  error?: string | null
  onReviewUpdate?: () => void
  onChangePeople?: (people: Omit<MwProjectPerson, 'personId'>[]) => void
  onStart?: () => void
  onArchive?: () => void
  onDiscard?: () => void
  onSaveAsTemplate?: () => void
}

export function ProjectSettingsView({ project, roles, appTitle = humanize, busy, error, onReviewUpdate, onChangePeople, onStart, onArchive, onDiscard, onSaveAsTemplate }: ProjectSettingsViewProps) {
  const { t, i18n } = useTranslation()
  const roleTitle = (id: string) => roles?.find((r) => r.id === id)?.title ?? humanize(id)
  const editable = project.canEdit && !project.implicit
  const settings = Object.entries(project.settings)
  const others = project.apps.filter((a) => a !== project.app)

  const removePerson = (email: string) => onChangePeople?.(project.people.filter((p) => p.email !== email).map(stripId))
  const addPerson = (person: Omit<MwProjectPerson, 'personId'>) => onChangePeople?.([...project.people.map(stripId), person])

  return (
    <Info_Page.Content>
      <div className="space-y-6" data-project-settings={project.id}>
        <div className="space-y-1">
          <div className="text-label-sm text-tertiary" data-breadcrumbs>
            {project.name} › {t('memwise.projects.settings.title')}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-title text-foreground">{t('memwise.projects.settings.title')}</h2>
            <StatusPill status={project.status} />
          </div>
          {others.length > 0 && (
            <p className="text-label-sm text-secondary" data-also>
              {t('memwise.projects.settings.alsoRuns', { apps: others.map(appTitle).join(', ') })}
            </p>
          )}
        </div>

        <Info_Section title={t('memwise.projects.settings.template')}>
          <div className="space-y-3 px-3.5 py-3" data-template>
            <p className="text-label text-foreground">{templateLine(project, t)}</p>
            {project.update && (
              <div className="flex flex-wrap items-center gap-3 rounded-md bg-accent-tint px-3 py-2.5" data-update={project.update.to}>
                <p className="min-w-0 flex-1 text-label text-foreground">
                  <span className="font-semibold">{t('memwise.projects.settings.versionOut', { version: project.update.to })}</span>
                </p>
                {onReviewUpdate && <Button size="sm" onClick={onReviewUpdate} data-action="review-update">{t('memwise.projects.update.reviewUpdate')}</Button>}
              </div>
            )}
          </div>
        </Info_Section>

        <Info_Section title={t('memwise.projects.settings.people')} count={project.people.length}>
          <table className="w-full text-label" data-people>
            <thead>
              <tr className="border-b border-separator text-left text-label-sm text-tertiary">
                <th className="px-3.5 py-2 font-medium">{t('memwise.projects.home.person')}</th>
                <th className="px-3 py-2 font-medium">{t('memwise.projects.settings.roleHere')}</th>
                {editable && onChangePeople && <th className="w-10" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-separator">
              {project.people.map((p) => (
                <tr key={p.email} data-person={p.email}>
                  <td className="px-3.5 py-2.5">
                    <div className="text-foreground">{p.name ?? p.email}</div>
                    {p.name && <div className="text-label-sm text-tertiary">{p.email}</div>}
                  </td>
                  <td className="px-3 py-2.5 text-secondary">{personRoles(p, roleTitle)}</td>
                  {editable && onChangePeople && (
                    <td className="pr-2 text-right">
                      <Button variant="ghost" size="icon-sm" aria-label={t('memwise.projects.settings.removePerson', { name: p.name ?? p.email })} disabled={!!busy} onClick={() => removePerson(p.email)} data-action="remove-person">
                        <X />
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
              {project.people.length === 0 && (
                <tr><td colSpan={3} className="px-3.5 py-3 text-tertiary">{t('memwise.projects.settings.noPeople')}</td></tr>
              )}
            </tbody>
          </table>
          {editable && onChangePeople && <AddPerson roles={roles ?? []} disabled={!!busy} taken={project.people.map((p) => p.email)} onAdd={addPerson} />}
        </Info_Section>

        {project.connections.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-label-sm font-semibold text-secondary">{t('memwise.projects.settings.connections')}</h3>
            <div className="flex flex-wrap gap-2" data-connections>
              {project.connections.map((c) => (
                <span key={c.id} className="rounded-md border border-separator px-2.5 py-1 text-label-sm text-foreground" data-connection={c.id} data-bound={c.bound}>
                  {[c.title, c.access === 'read' ? t('memwise.projects.settings.readOnly') : undefined, c.bound === 'app' ? t('memwise.projects.settings.boundApp') : c.bound === 'none' ? t('memwise.projects.settings.notConnected') : undefined].filter(Boolean).join(' · ')}
                </span>
              ))}
            </div>
          </section>
        )}

        {settings.length > 0 && (
          <Info_Section title={t('memwise.projects.settings.settings')}>
            <dl className="divide-y divide-separator text-label" data-settings>
              {settings.map(([k, v]) => (
                <div key={k} className="flex gap-4 px-3.5 py-2.5">
                  <dt className="w-40 shrink-0 text-secondary">{humanize(k)}</dt>
                  <dd className="min-w-0 flex-1 text-foreground">{settingText(v, (x) => formatValueInline(x, t, i18n.language))}</dd>
                </div>
              ))}
            </dl>
          </Info_Section>
        )}

        {project.playbooks.length > 0 && (
          <Info_Section title={t('memwise.projects.new.playbooks')} count={project.playbooks.length}>
            <ul className="divide-y divide-separator text-label" data-playbooks>
              {project.playbooks.map((w) => (
                <li key={w.id} className="flex items-center gap-2 px-3.5 py-2" data-playbook={w.id} data-overridden={w.overridden || undefined}>
                  <span className="min-w-0 flex-1 text-foreground">{w.title}</span>
                  {w.overridden && <span className="text-label-sm text-secondary">{t('memwise.projects.settings.changedHere')}</span>}
                </li>
              ))}
            </ul>
          </Info_Section>
        )}

        {error && <p className="text-label-sm text-destructive" role="alert">{error}</p>}

        {project.canEdit && !project.implicit && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-separator pt-4" data-actions>
            {project.status === 'draft' && onDiscard && <Button variant="danger" onClick={onDiscard} disabled={!!busy} data-action="discard">{t('memwise.projects.new.discard')}</Button>}
            {project.status === 'active' && onArchive && <Button variant="secondary" onClick={onArchive} disabled={!!busy} data-action="archive">{t('memwise.projects.settings.archive')}</Button>}
            {onSaveAsTemplate && project.status !== 'archived' && <Button variant="secondary" onClick={onSaveAsTemplate} disabled={!!busy} data-action="save-template">{t('memwise.projects.settings.saveAsTemplate')}</Button>}
            {project.status === 'draft' && onStart && <Button onClick={onStart} disabled={!!busy} data-action="start">{t('memwise.projects.settings.start')}</Button>}
          </div>
        )}
      </div>
    </Info_Page.Content>
  )
}

function AddPerson({ roles, disabled, taken, onAdd }: { roles: MwRole[]; disabled: boolean; taken: string[]; onAdd: (p: Omit<MwProjectPerson, 'personId'>) => void }) {
  const { t } = useTranslation()
  const [email, setEmail] = React.useState('')
  const [name, setName] = React.useState('')
  const [role, setRole] = React.useState(roles[0]?.id ?? '')
  React.useEffect(() => { if (!role && roles[0]) setRole(roles[0].id) }, [roles, role])
  const clean = email.trim().toLowerCase()
  const ok = /^[^\s@]+@[^\s@]+$/.test(clean) && !taken.includes(clean) && !!role
  const add = () => {
    if (!ok) return
    onAdd({ email: clean, ...(name.trim() ? { name: name.trim() } : {}), roles: [role] })
    setEmail('')
    setName('')
  }
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-separator px-3.5 py-2.5" data-add-person>
      <Input className="w-48" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('memwise.projects.settings.email')} data-field="email" />
      <Input className="w-40" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('memwise.projects.settings.name')} data-field="person-name" />
      <select
        className="h-control rounded-md bg-raised px-2 text-label shadow-elev-1"
        value={role}
        onChange={(e) => setRole(e.target.value)}
        aria-label={t('memwise.projects.settings.roleHere')}
        data-field="role"
      >
        {roles.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
      </select>
      <Button variant="secondary" size="sm" onClick={add} disabled={disabled || !ok} data-action="add-person">
        <Plus />
        {t('memwise.projects.settings.addPerson')}
      </Button>
    </div>
  )
}

const stripId = ({ personId: _, ...p }: MwProjectPerson): Omit<MwProjectPerson, 'personId'> => p

/** A setting as people read it: `{ label, date }` milestones as "First site 2027-01-15". */
function settingText(v: unknown, inline: (v: unknown) => string): string {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'label' in v) {
    const o = v as { label: unknown; date?: unknown }
    return [String(o.label), o.date ? String(o.date) : undefined].filter(Boolean).join(' · ')
  }
  return inline(v)
}
