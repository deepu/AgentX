/**
 * PublicAddressSettingsPage (MemWise Phase 5)
 *
 * The relay that gives this install a public address for client forms and links, the channels
 * that can send messages, and the current person's own notifications. The view is
 * components/memwise/PublicAddress.tsx; this page loads and saves through the MemWise channels.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { SettingsPage } from '@/components/settings'
import { PublicAddressView } from '@/components/memwise/PublicAddress'
import { memwiseStatusAtom, memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi, useMemwisePublicAddress } from '@/hooks/useMemwise'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { MwNotifySettings, MwRelayConfigureInput } from '../../../shared/types'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'publicAddress',
}

export default function PublicAddressSettingsPage() {
  const { t } = useTranslation()
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const status = useAtomValue(memwiseStatusAtom)
  const data = useMemwisePublicAddress()
  const { reload } = data

  const onConfigure = React.useCallback(async (input: MwRelayConfigureInput) => {
    const api = getMemwiseApi()
    if (!api || !workspaceId) throw new Error(t('memwise.notAvailable'))
    const next = await api.memwiseConfigureRelay(workspaceId, input)
    reload()
    return next
  }, [workspaceId, reload, t])

  const onSetNotify = React.useCallback(async (settings: MwNotifySettings) => {
    const api = getMemwiseApi()
    if (!api || !workspaceId) throw new Error(t('memwise.notAvailable'))
    const next = await api.memwiseSetNotifySettings(workspaceId, settings)
    reload()
    return next
  }, [workspaceId, reload, t])

  return (
    <SettingsPage
      title={t('settings.publicAddress.title')}
      description={t('settings.publicAddress.description')}
      actions={<HeaderMenu route={routes.view.settings('publicAddress')} />}
    >
      <PublicAddressView
        relay={data.relay}
        channels={data.channels}
        notify={data.notify}
        unsupported={data.unsupported || !workspaceId}
        loading={data.loading}
        error={data.error}
        personName={status?.me?.name}
        onConfigure={onConfigure}
        onSetNotify={onSetNotify}
      />
    </SettingsPage>
  )
}
