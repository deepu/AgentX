/**
 * Kernel status in plain words (a banner over the MemWise screens, a one-line notice in the
 * sidebar) and the "Acting as" person switcher for the sidebar footer on desktop.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { AlertTriangle, Check, ChevronsUpDown, Loader2, PlugZap, UserRound } from 'lucide-react'
import type { MwPerson, MwRole, MwStatus } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { cn } from '@/lib/utils'
import { memwiseAvailableAtom, memwisePeopleAtom, memwiseRolesAtom, memwiseStatusAtom, memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { useMemwiseActAs } from '@/hooks/useMemwise'
import { roleTitle } from './format'

export type StatusProblem = 'unavailable' | 'starting' | 'notReady' | 'noModel' | null

/** What, if anything, to tell the person about the kernel. */
export function statusProblem(status: MwStatus | null, available: boolean): StatusProblem {
  if (!available) return 'unavailable'
  if (!status) return 'starting'
  if (!status.ready) return 'notReady'
  if (!status.modelConfigured) return 'noModel'
  return null
}

function useStatusText(): { problem: StatusProblem; title: string; description?: string } {
  const { t } = useTranslation()
  const status = useAtomValue(memwiseStatusAtom)
  const available = useAtomValue(memwiseAvailableAtom)
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  // No workspace open (yet): nothing is starting, so say nothing.
  const problem = workspaceId ? statusProblem(status, available) : null
  switch (problem) {
    case 'unavailable':
      return { problem, title: t('memwise.status.unavailable'), description: t('memwise.status.unavailableDescription') }
    case 'starting':
      return { problem, title: t('memwise.status.starting') }
    case 'notReady':
      return { problem, title: t('memwise.status.notReady'), description: status?.message }
    case 'noModel':
      return { problem, title: t('memwise.status.noModel'), description: status?.message ?? t('memwise.status.noModelDescription') }
    default:
      return { problem, title: '' }
  }
}

/** A banner over the MemWise lists and pages when the kernel isn't ready or no model is connected. */
export function MemwiseStatusBanner({ className }: { className?: string }) {
  const { problem, title, description } = useStatusText()
  if (!problem || problem === 'starting') return null
  return (
    <Info_Alert
      variant={problem === 'noModel' ? 'info' : 'warning'}
      inline
      icon={problem === 'noModel' ? <PlugZap /> : <AlertTriangle />}
      className={className}
      data-memwise-status={problem}
    >
      <Info_Alert.Title>{title}</Info_Alert.Title>
      {description && <Info_Alert.Description>{description}</Info_Alert.Description>}
    </Info_Alert>
  )
}

/** One quiet line in the sidebar footer while there is something to know. */
export function SidebarStatusNotice() {
  const { problem, title, description } = useStatusText()
  if (!problem || problem === 'unavailable') return null
  return (
    <div className="mx-2 flex items-start gap-2 rounded-sm px-2 py-1.5 text-label-sm text-secondary" title={description} data-memwise-status={problem}>
      {problem === 'starting' || problem === 'notReady'
        ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
        : <PlugZap className="mt-0.5 size-3.5 shrink-0 text-info" />}
      <span className="min-w-0 flex-1 line-clamp-2">{title}</span>
    </div>
  )
}

export interface ActingAsSwitcherViewProps {
  me?: MwPerson
  people: MwPerson[]
  roles?: MwRole[]
  onSelect: (personId: string) => void
  busy?: boolean
}

function rolesText(person: MwPerson, roles?: MwRole[]): string {
  return person.roles.map(r => roleTitle(r, roles)).join(', ')
}

export function ActingAsSwitcherView({ me, people, roles, onSelect, busy }: ActingAsSwitcherViewProps) {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          className="group mx-2 flex h-row-sidebar w-[calc(100%-1rem)] items-center gap-2 rounded-sm px-2 text-label text-foreground transition-[background-color] duration-micro hover:bg-fill-hover data-[state=open]:bg-fill-hover"
          data-memwise-acting-as
        >
          <UserRound className="size-4 shrink-0 text-secondary" />
          <span className="min-w-0 flex-1 truncate text-left">
            <span className="text-secondary">{t('memwise.actingAs.label')}</span>{' '}
            <span className="font-medium">{me?.name ?? t('memwise.actingAs.nobody')}</span>
          </span>
          {busy ? <Loader2 className="size-3.5 animate-spin text-tertiary" /> : <ChevronsUpDown className="size-3.5 text-tertiary" />}
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent side="top" align="start" className="min-w-56">
        {people.map(p => (
          <StyledDropdownMenuItem key={p.id} onSelect={() => { if (p.id !== me?.id) onSelect(p.id) }}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{p.name}</span>
              {p.roles.length > 0 && <span className="truncate text-label-sm text-tertiary">{rolesText(p, roles)}</span>}
            </span>
            <Check className={cn('size-3.5 shrink-0', p.id === me?.id ? 'opacity-100' : 'opacity-0')} />
          </StyledDropdownMenuItem>
        ))}
        {people.length === 0 && (
          <StyledDropdownMenuItem disabled>{t('memwise.actingAs.noPeople')}</StyledDropdownMenuItem>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}

/** The switcher, shown only when this desktop may act as someone else. */
export function ActingAsSwitcher() {
  const { t } = useTranslation()
  const status = useAtomValue(memwiseStatusAtom)
  const people = useAtomValue(memwisePeopleAtom)
  const roles = useAtomValue(memwiseRolesAtom)
  const actAs = useMemwiseActAs()
  const [busy, setBusy] = React.useState(false)
  if (!status?.canActAs) return null
  const select = async (personId: string) => {
    setBusy(true)
    try {
      const next = await actAs(personId)
      if (next?.me) toast.success(t('memwise.actingAs.switched', { name: next.me.name }))
    } catch (err) {
      toast.error(t('memwise.actingAs.failed'), { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }
  return <ActingAsSwitcherView me={status.me} people={people} roles={roles} onSelect={id => void select(id)} busy={busy} />
}
