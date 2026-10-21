/**
 * Stage 6 (docs/memwise/26-projects-and-pages.md §9): which app owns each fact of a record shared
 * across apps, and the numbers the EDC study home shows. Pure, so the screens stay presentational.
 */

import type { MwLinkedRecord, MwRecordField, MwRecordPage, MwRecordRef } from '@memwise/shared/protocol'
import { humanize } from '../format'

/** An app (a domain) that owns facts: "EDC", "eTMF". */
export interface OwnerApp {
  domain: string
  name: string
}

/** One fact of a record, with the app that owns it and, when that is another app, where to edit it. */
export interface OwnedFact {
  name: string
  label: string
  type: string
  value: unknown
  ref?: MwRecordRef
  owner: OwnerApp
  /** Owned by another app: shown read only here, edited there. */
  elsewhere: boolean
  /** The owner's record, for "Open in <app>". */
  open?: { entity: string; id: string }
}

const TONES = ['bg-info-tint text-info', 'bg-accent-tint text-accent', 'bg-success-tint text-success'] as const

/** A stable tone per app, so EDC and eTMF keep their colours on every page. */
export function ownerTone(domain: string): string {
  let h = 0
  for (const c of domain) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return TONES[h % TONES.length]!
}

const empty = (v: unknown) => v === null || v === undefined || v === ''

/** Who owns a field on this page: a field followed through a link belongs to the app it follows. */
export function fieldOwner(page: Pick<MwRecordPage, 'domain' | 'domainName' | 'entity' | 'id'>, f: MwRecordField): OwnedFact['owner'] & { open?: OwnedFact['open'] } {
  if (f.source.kind === 'link') {
    return {
      domain: f.source.domain, name: f.source.domainName ?? humanize(f.source.domain),
      ...(f.source.recordId ? { open: { entity: f.source.entity, id: f.source.recordId } } : {}),
    }
  }
  return { domain: page.domain, name: page.domainName }
}

/**
 * "One record, each fact owned by one app": this page's facts, then those the same record holds in
 * the other apps. Empty and hidden values are left out; so is the lifecycle, which each app keeps.
 */
export function factsByApp(page: Pick<MwRecordPage, 'domain' | 'domainName' | 'entity' | 'id' | 'fields'>, linked: MwLinkedRecord[]): OwnedFact[] {
  const out: OwnedFact[] = []
  const seen = new Set<string>()
  for (const f of page.fields) {
    if (f.hidden || empty(f.value) || f.name === 'status') continue
    const { open, ...owner } = fieldOwner(page, f)
    seen.add(f.name)
    out.push({
      name: f.name, label: f.label, type: f.type, value: f.value, ...(f.ref ? { ref: f.ref } : {}),
      owner, elsewhere: owner.domain !== page.domain, ...(open ? { open } : {}),
    })
  }
  for (const r of linked) {
    for (const f of r.fields) {
      if (f.hidden || empty(f.value) || seen.has(`${r.domain}:${f.name}`)) continue
      seen.add(`${r.domain}:${f.name}`)
      out.push({
        name: f.name, label: f.label, type: f.type, value: f.value, ...(f.ref ? { ref: f.ref } : {}),
        owner: { domain: r.domain, name: r.domainName }, elsewhere: r.domain !== page.domain, open: { entity: r.entity, id: r.id },
      })
    }
  }
  return out
}

/** The other apps this record is in, once each, for the "Open in <app>" buttons. */
export function otherApps(page: Pick<MwRecordPage, 'domain' | 'domainName' | 'entity' | 'id' | 'fields'>, linked: MwLinkedRecord[]): (OwnerApp & { entity: string; id: string })[] {
  const out = new Map<string, OwnerApp & { entity: string; id: string }>()
  for (const r of linked) if (r.domain !== page.domain && !out.has(r.domain)) out.set(r.domain, { domain: r.domain, name: r.domainName, entity: r.entity, id: r.id })
  for (const f of page.fields) {
    const { open, ...owner } = fieldOwner(page, f)
    if (open && owner.domain !== page.domain && !out.has(owner.domain)) out.set(owner.domain, { ...owner, ...open })
  }
  return [...out.values()]
}

/** A site's bar: randomised as a share of target, 0–100 (a site past its target fills the bar). */
export function barWidth(percent: number | undefined): number {
  if (percent === undefined || !Number.isFinite(percent)) return 0
  return Math.max(0, Math.min(100, percent))
}
