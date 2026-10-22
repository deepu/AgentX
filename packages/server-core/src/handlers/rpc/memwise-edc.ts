/**
 * Stage 6 RPC (docs/memwise/26-projects-and-pages.md §9): the EDC study home, "Also in other apps"
 * and the same record in the other apps. Each reads as the signed-in person.
 */
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import type { MwEdcHome, MwEdcHomeInput, MwLinkedRecord, MwLinkedRecordsInput, MwStudyApps, MwStudyAppsInput } from '@memwise/shared/protocol'
import type { RequestContext, RpcServer } from '@memwise/server-core/transport'
import { getMemwiseHostStatus, getMemwiseService } from '../../memwise/host'
import type { MemwiseService } from '../../memwise/service'
import { edcHome, linkedRecords, studyApps } from '../../memwise/edc'

const ch = RPC_CHANNELS.memwise

export const EDC_CHANNELS = [ch.EDC_HOME, ch.STUDY_APPS, ch.RECORDS_LINKED] as const

function requireService(): MemwiseService {
  const svc = getMemwiseService()
  if (!svc) throw new Error(getMemwiseHostStatus().message ?? 'Playbooks are not running.')
  return svc
}

async function begin(ctx: RequestContext) {
  const svc = requireService()
  const [actor, c] = await Promise.all([svc.actorFor({ clientId: ctx.clientId, personId: ctx.personId ?? null }), svc.context()])
  return { svc, actor, project: c.project }
}

const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Choose ${what}.`)
  return v.trim()
}

export function createEdcApi() {
  return {
    async home(ctx: RequestContext, input: MwEdcHomeInput): Promise<MwEdcHome> {
      const { svc, actor, project } = await begin(ctx)
      return edcHome(svc, actor, project, { projectId: text(input?.projectId, 'a project'), ...(input?.domain ? { domain: input.domain } : {}) })
    },
    async studyApps(ctx: RequestContext, input: MwStudyAppsInput): Promise<MwStudyApps> {
      const { svc, actor, project } = await begin(ctx)
      return studyApps(svc, actor, project, { projectId: text(input?.projectId, 'a project'), ...(input?.domain ? { domain: input.domain } : {}) })
    },
    async linked(ctx: RequestContext, input: MwLinkedRecordsInput): Promise<MwLinkedRecord[]> {
      const { svc, actor, project } = await begin(ctx)
      return linkedRecords(svc, actor, project, { entity: text(input?.entity, 'a record'), id: text(input?.id, 'a record') })
    },
  }
}

export function registerEdcHandlers(server: RpcServer): void {
  const api = createEdcApi()
  server.handle(ch.EDC_HOME, (ctx, _ws: string, input) => api.home(ctx, input))
  server.handle(ch.STUDY_APPS, (ctx, _ws: string, input) => api.studyApps(ctx, input))
  server.handle(ch.RECORDS_LINKED, (ctx, _ws: string, input) => api.linked(ctx, input))
}
