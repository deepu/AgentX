/**
 * Settings → Public address (Phase 5, docs/memwise/23-phase-5-interfaces.md §2, §6, §11): the relay
 * that gives this install an address clients can open, which channels can send messages, and the
 * person's own notifications. `PublicAddressView` is presentational; the settings page wires it.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlertTriangle, Copy, Mail, MessageCircle } from 'lucide-react'
import type { MwChannelName, MwChannelsAvailable, MwNotifySettings, MwRelayConfigureInput, MwRelayStatus } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsCard, SettingsRow, SettingsSection, SettingsToggle } from '@/components/settings'
import { absoluteTime, toolLabel } from './format'

export interface PublicAddressViewProps {
  relay: MwRelayStatus | null
  channels: MwChannelsAvailable | null
  notify: MwNotifySettings | null
  /** This host has no Phase 5 calls (an older server). */
  unsupported?: boolean
  loading?: boolean
  error?: string | null
  /** Who the notification settings are for. */
  personName?: string
  onConfigure?: (input: MwRelayConfigureInput) => Promise<MwRelayStatus>
  onSetNotify?: (settings: MwNotifySettings) => Promise<MwNotifySettings>
  copy?: (text: string) => Promise<void>
}

const STATE_COLOR = { off: 'muted', connecting: 'default', connected: 'success', error: 'destructive' } as const

const E164 = /^\+[1-9]\d{6,14}$/

/** A WhatsApp number as E.164 (`+919876543210`), spaces and dashes dropped; null when it isn't one. */
export function normalizeWhatsapp(text: string): string | null {
  const s = text.replace(/[\s().-]/g, '')
  return E164.test(s) ? s : null
}

/** A relay address worth saving: http(s), no path beyond `/`. */
export function validRelayUrl(text: string): boolean {
  try {
    const u = new URL(text.trim())
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password
  } catch {
    return false
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function PublicAddressView({ relay, channels, notify, unsupported, loading, error, personName, onConfigure, onSetNotify, copy }: PublicAddressViewProps) {
  const { t } = useTranslation()
  if (unsupported) {
    return (
      <Info_Alert variant="info" icon={<AlertTriangle />} data-public-address="unsupported">
        <Info_Alert.Title>{t('memwise.publicAddress.unsupported')}</Info_Alert.Title>
      </Info_Alert>
    )
  }
  return (
    <>
      {error && (
        <Info_Alert variant="error" inline icon={<AlertTriangle />}>
          <Info_Alert.Title>{t('memwise.publicAddress.loadFailed')}</Info_Alert.Title>
          <Info_Alert.Description>{error}</Info_Alert.Description>
        </Info_Alert>
      )}
      <RelaySection relay={relay} loading={loading} onConfigure={onConfigure} copy={copy} />
      <ChannelsSection channels={channels} />
      <NotifySection notify={notify} personName={personName} onSetNotify={onSetNotify} />
    </>
  )
}

function RelaySection({ relay, loading, onConfigure, copy }: Pick<PublicAddressViewProps, 'relay' | 'loading' | 'onConfigure' | 'copy'>) {
  const { t, i18n } = useTranslation()
  const [url, setUrl] = React.useState(relay?.relayUrl ?? '')
  const [busy, setBusy] = React.useState(false)
  const [urlError, setUrlError] = React.useState<string | null>(null)
  React.useEffect(() => { setUrl(relay?.relayUrl ?? '') }, [relay?.relayUrl])

  const configure = async (input: MwRelayConfigureInput) => {
    if (!onConfigure) return
    setBusy(true)
    try {
      await onConfigure(input)
    } catch (err) {
      toast.error(t('memwise.publicAddress.saveFailed'), { description: errorText(err) })
    } finally {
      setBusy(false)
    }
  }
  const saveUrl = () => {
    if (url.trim() && !validRelayUrl(url)) { setUrlError(t('memwise.publicAddress.badRelayUrl')); return }
    setUrlError(null)
    void configure({ enabled: relay?.enabled ?? !!url.trim(), relayUrl: url.trim() || undefined })
  }
  const copyAddress = async (text: string) => {
    try {
      await (copy ?? (s => navigator.clipboard.writeText(s)))(text)
      toast.success(t('memwise.publicAddress.copied'))
    } catch {
      /* the address is on screen to select */
    }
  }
  const state = relay?.state ?? 'off'
  const server = relay?.source === 'server'

  return (
    <SettingsSection title={t('memwise.publicAddress.title')} description={t('memwise.publicAddress.description')}>
      <SettingsCard>
        <SettingsToggle
          label={t('memwise.publicAddress.useRelay')}
          description={server ? t('memwise.publicAddress.serverHasAddress') : t('memwise.publicAddress.useRelayDescription')}
          checked={!!relay?.enabled}
          onCheckedChange={enabled => void configure({ enabled, relayUrl: url.trim() || relay?.relayUrl })}
          disabled={!relay || busy || !onConfigure}
        />
        <SettingsRow label={t('memwise.publicAddress.state')} description={relay?.since ? t('memwise.publicAddress.since', { time: absoluteTime(relay.since, i18n.language) }) : undefined}>
          <span data-relay-state={state}>
            <Info_Badge color={STATE_COLOR[state]} dot>{loading && !relay ? t('memwise.publicAddress.loading') : t(`memwise.publicAddress.stateLabel.${state}`)}</Info_Badge>
          </span>
        </SettingsRow>
        <SettingsRow
          label={t('memwise.publicAddress.address')}
          description={relay?.publicUrl ? t('memwise.publicAddress.addressDescription') : t('memwise.publicAddress.noAddress')}
          action={relay?.publicUrl ? (
            <Button variant="ghost" size="sm" onClick={() => void copyAddress(relay.publicUrl!)} aria-label={t('memwise.publicAddress.copy')}>
              <Copy />
              {t('memwise.publicAddress.copy')}
            </Button>
          ) : undefined}
        >
          {relay?.publicUrl && <span className="select-text font-mono text-label-sm text-foreground [overflow-wrap:anywhere]" data-public-url>{relay.publicUrl}</span>}
        </SettingsRow>
        {relay?.installId && (
          <SettingsRow label={t('memwise.publicAddress.installId')} description={t('memwise.publicAddress.installIdDescription')}>
            <span className="select-text font-mono text-label-sm text-secondary">{relay.installId}</span>
          </SettingsRow>
        )}
        <div className="space-y-1.5 px-4 py-3" data-relay-url>
          <label htmlFor="memwise-relay-url" className="block text-label font-medium text-foreground">{t('memwise.publicAddress.relayUrl')}</label>
          <p className="text-label-sm text-tertiary">{t('memwise.publicAddress.relayUrlDescription')}</p>
          <form className="flex gap-2" onSubmit={e => { e.preventDefault(); saveUrl() }}>
            <Input
              id="memwise-relay-url"
              value={url}
              onChange={e => { setUrl(e.target.value); if (urlError) setUrlError(null) }}
              placeholder="https://relay.memwise.app"
              className="font-mono text-label-sm"
              disabled={!onConfigure || busy}
              aria-invalid={!!urlError || undefined}
              spellCheck={false}
            />
            <Button type="submit" variant="secondary" disabled={!onConfigure || busy || url.trim() === (relay?.relayUrl ?? '')}>{t('memwise.publicAddress.save')}</Button>
          </form>
          {urlError && <p className="text-label-sm text-destructive" role="alert">{urlError}</p>}
        </div>
      </SettingsCard>
      {relay?.state === 'error' && relay.error && (
        <Info_Alert variant="error" inline icon={<AlertTriangle />} className="mt-2" data-relay-error>
          <Info_Alert.Title>{t('memwise.publicAddress.errorTitle')}</Info_Alert.Title>
          <Info_Alert.Description>{relay.error}</Info_Alert.Description>
        </Info_Alert>
      )}
    </SettingsSection>
  )
}

const CHANNEL_ICON: Record<MwChannelName, React.ReactNode> = {
  email: <Mail className="size-4" />,
  whatsapp: <MessageCircle className="size-4" />,
}

function ChannelsSection({ channels }: { channels: MwChannelsAvailable | null }) {
  const { t } = useTranslation()
  return (
    <SettingsSection title={t('memwise.publicAddress.channels')} description={t('memwise.publicAddress.channelsDescription')}>
      <SettingsCard>
        {(['email', 'whatsapp'] as const).map(ch => {
          const bound = channels?.[ch]
          return (
            <SettingsRow
              key={ch}
              label={<span className="flex items-center gap-2">{CHANNEL_ICON[ch]}{t(ch === 'email' ? 'memwise.message.email' : 'memwise.message.whatsapp')}</span>}
              description={bound
                ? t('memwise.publicAddress.channelBound', { plugin: bound.plugin ?? toolLabel(bound.tool), tool: bound.tool })
                : t(ch === 'email' ? 'memwise.publicAddress.noEmail' : 'memwise.publicAddress.noWhatsapp')}
            >
              <span data-channel={ch} data-bound={bound ? 'yes' : 'no'}>
                <Info_Badge color={bound ? 'success' : 'muted'} dot>{bound ? t('memwise.publicAddress.ready') : t('memwise.publicAddress.notSetUp')}</Info_Badge>
              </span>
            </SettingsRow>
          )
        })}
      </SettingsCard>
    </SettingsSection>
  )
}

function NotifySection({ notify, personName, onSetNotify }: Pick<PublicAddressViewProps, 'notify' | 'personName' | 'onSetNotify'>) {
  const { t } = useTranslation()
  const [number, setNumber] = React.useState(notify?.whatsapp ?? '')
  const [numberError, setNumberError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => { setNumber(notify?.whatsapp ?? '') }, [notify?.whatsapp])

  const save = async (next: MwNotifySettings) => {
    if (!onSetNotify) return
    setBusy(true)
    try {
      await onSetNotify(next)
      toast.success(t('memwise.publicAddress.notifySaved'))
    } catch (err) {
      toast.error(t('memwise.publicAddress.saveFailed'), { description: errorText(err) })
    } finally {
      setBusy(false)
    }
  }
  const saveNumber = () => {
    const trimmed = number.trim()
    if (!trimmed) { setNumberError(null); void save({ ...notify, whatsapp: undefined }); return }
    const e164 = normalizeWhatsapp(trimmed)
    if (!e164) { setNumberError(t('memwise.publicAddress.badNumber')); return }
    setNumberError(null)
    setNumber(e164)
    void save({ ...notify, whatsapp: e164 })
  }
  return (
    <SettingsSection
      title={t('memwise.publicAddress.notify')}
      description={personName ? t('memwise.publicAddress.notifyDescriptionFor', { name: personName }) : t('memwise.publicAddress.notifyDescription')}
    >
      <SettingsCard>
        <SettingsToggle
          label={t('memwise.publicAddress.notifyEmail')}
          description={t('memwise.publicAddress.notifyEmailDescription')}
          checked={!!notify?.email}
          onCheckedChange={email => void save({ ...notify, email })}
          disabled={!notify || busy || !onSetNotify}
        />
        <div className="space-y-1.5 px-4 py-3" data-notify-whatsapp>
          <label htmlFor="memwise-notify-whatsapp" className="block text-label font-medium text-foreground">{t('memwise.publicAddress.notifyWhatsapp')}</label>
          <p className="text-label-sm text-tertiary">{t('memwise.publicAddress.notifyWhatsappDescription')}</p>
          <form className="flex gap-2" onSubmit={e => { e.preventDefault(); saveNumber() }}>
            <Input
              id="memwise-notify-whatsapp"
              type="tel"
              inputMode="tel"
              value={number}
              onChange={e => { setNumber(e.target.value); if (numberError) setNumberError(null) }}
              placeholder="+91 98765 43210"
              disabled={!notify || busy || !onSetNotify}
              aria-invalid={!!numberError || undefined}
            />
            <Button type="submit" variant="secondary" disabled={!notify || busy || !onSetNotify || number.trim() === (notify?.whatsapp ?? '')}>{t('memwise.publicAddress.save')}</Button>
          </form>
          {numberError && <p className="text-label-sm text-destructive" role="alert">{numberError}</p>}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
