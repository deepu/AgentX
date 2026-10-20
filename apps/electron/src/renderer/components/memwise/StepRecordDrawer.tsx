/**
 * The step record in a side sheet over the case view, with "Ask about this step" (explain)
 * and "Open in chat" wired to the API.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import type { MwExplanation } from '@memwise/shared/protocol'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@memwise/ui'
import { navigate, routes } from '@/lib/navigate'
import { memwisePeopleAtom, memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi, useMemwiseOpenChat, useMemwiseStepRecord } from '@/hooks/useMemwise'
import { StepRecordView } from './StepRecordView'
import { peopleById } from './format'

export interface StepRecordDrawerProps {
  stepRunId: string | null
  onClose: () => void
}

export function StepRecordDrawer({ stepRunId, onClose }: StepRecordDrawerProps) {
  const { t } = useTranslation()
  const { data: record, error, loading } = useMemwiseStepRecord(stepRunId)
  const people = peopleById(useAtomValue(memwisePeopleAtom))
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const openChat = useMemwiseOpenChat()
  const [explanations, setExplanations] = React.useState<MwExplanation[]>([])
  const [asking, setAsking] = React.useState(false)
  const [askError, setAskError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setExplanations([])
    setAskError(null)
  }, [stepRunId])

  const ask = async (question: string) => {
    const api = getMemwiseApi()
    if (!api || !workspaceId || !stepRunId) return
    setAsking(true)
    setAskError(null)
    try {
      const ex = await api.memwiseExplainStep(workspaceId, { stepRunId, question })
      setExplanations(prev => [...prev, ex])
    } catch (err) {
      setAskError(err instanceof Error ? err.message : String(err))
    } finally {
      setAsking(false)
    }
  }

  const handleOpenChat = async () => {
    if (!stepRunId) return
    try {
      const sessionId = await openChat({ kind: 'step', id: stepRunId })
      if (sessionId) {
        onClose()
        navigate(routes.view.allSessions(sessionId))
      }
    } catch (err) {
      toast.error(t('memwise.step.openChatFailed'), { description: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <Drawer direction="right" open={!!stepRunId} onOpenChange={open => { if (!open) onClose() }}>
      <DrawerContent className="data-[vaul-drawer-direction=right]:w-[min(640px,92vw)] data-[vaul-drawer-direction=right]:sm:max-w-none">
        <DrawerHeader className="border-b border-separator">
          <DrawerTitle>{record?.title ?? t('memwise.step.record')}</DrawerTitle>
          <DrawerDescription>{t('memwise.step.recordDescription')}</DrawerDescription>
        </DrawerHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4">
            {loading && !record && <div className="flex justify-center py-8"><Spinner className="text-tertiary" /></div>}
            {error && <p className="text-label text-destructive">{error}</p>}
            {record && (
              <StepRecordView
                record={record}
                people={people}
                explanations={explanations}
                onAsk={q => void ask(q)}
                asking={asking}
                askError={askError}
                onOpenChat={() => void handleOpenChat()}
              />
            )}
          </div>
        </ScrollArea>
      </DrawerContent>
    </Drawer>
  )
}
