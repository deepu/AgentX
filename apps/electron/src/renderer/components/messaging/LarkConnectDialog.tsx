/**
 * LarkConnectDialog — App ID + App Secret pairing flow for Lark / Feishu.
 *
 * Same modal shape as `TelegramConnectDialog`. Differences:
 *   - Two secret fields (App ID + App Secret) instead of one (bot token)
 *   - A region selector — Lark and Feishu are separate Open Platforms;
 *     a bot belongs to one or the other and the choice is permanent.
 */

import * as React from 'react'
import { Check, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@memwise/ui'
import { SettingsSecretInput } from '@/components/settings'

interface LarkConnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When true, treat the flow as "replace existing credentials". */
  reconfigure?: boolean
  onSaved?: () => void
}

type TestResult =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'success' }
  | { state: 'error'; error: string }

type LarkDomain = 'lark' | 'feishu'

export function LarkConnectDialog({
  open,
  onOpenChange,
  reconfigure = false,
  onSaved,
}: LarkConnectDialogProps) {
  const { t } = useTranslation()
  const [appId, setAppId] = React.useState('')
  const [appSecret, setAppSecret] = React.useState('')
  const [domain, setDomain] = React.useState<LarkDomain>('lark')
  const [saving, setSaving] = React.useState(false)
  const [test, setTest] = React.useState<TestResult>({ state: 'idle' })

  React.useEffect(() => {
    if (!open) {
      setAppId('')
      setAppSecret('')
      setDomain('lark')
      setTest({ state: 'idle' })
      setSaving(false)
    }
  }, [open])

  const ready = appId.trim().length > 0 && appSecret.trim().length > 0

  const handleTest = async () => {
    if (!ready) return
    setTest({ state: 'testing' })
    try {
      const result = await window.electronAPI.testLarkCredentials({
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        domain,
      })
      if (result.success) {
        setTest({ state: 'success' })
      } else {
        setTest({ state: 'error', error: result.error ?? t('common.error') })
      }
    } catch (err) {
      setTest({ state: 'error', error: err instanceof Error ? err.message : t('common.error') })
    }
  }

  const handleSave = async () => {
    if (!ready) return
    setSaving(true)
    try {
      await window.electronAPI.saveLarkCredentials({
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        domain,
      })
      toast.success(t('settings.messaging.lark.saved'))
      onSaved?.()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.messaging.lark.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {reconfigure
              ? t('settings.messaging.lark.reconfigureTitle')
              : t('settings.messaging.lark.connectTitle')}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-line">
            {t('settings.messaging.lark.instructions')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* Region selector */}
          <div>
            <div className="mb-1.5 text-label font-medium">
              {t('settings.messaging.lark.domainLabel')}
            </div>
            {/* Segmented control (same treatment as the onboarding provider switch) */}
            <div className="inline-flex rounded-md bg-fill-hover p-0.5">
              {(['lark', 'feishu'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={domain === value}
                  onClick={() => setDomain(value)}
                  disabled={saving}
                  className={cn(
                    'h-control-sm px-3 text-label font-medium rounded-sm transition-[background-color,color,box-shadow] duration-micro ease-out-subtle disabled:text-disabled',
                    domain === value
                      ? 'bg-floating shadow-elev-1 text-foreground'
                      : 'text-secondary hover:text-foreground',
                  )}
                >
                  {value === 'lark'
                    ? t('settings.messaging.lark.domainLark')
                    : t('settings.messaging.lark.domainFeishu')}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-label font-medium">
              {t('settings.messaging.lark.appIdLabel')}
            </div>
            <SettingsSecretInput
              value={appId}
              onChange={setAppId}
              placeholder={t('settings.messaging.lark.appIdPlaceholder')}
              disabled={saving}
            />
          </div>

          <div>
            <div className="mb-1.5 text-label font-medium">
              {t('settings.messaging.lark.appSecretLabel')}
            </div>
            <SettingsSecretInput
              value={appSecret}
              onChange={setAppSecret}
              placeholder={t('settings.messaging.lark.appSecretPlaceholder')}
              disabled={saving}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleTest}
              disabled={!ready || test.state === 'testing' || saving}
            >
              {test.state === 'testing' && <Spinner className="text-label" />}
              {t('settings.messaging.lark.testConnection')}
            </Button>

            {test.state === 'success' && (
              <span className="inline-flex items-center gap-1 text-label-sm text-success">
                <Check className="size-3.5" />
                {t('settings.messaging.lark.testOk')}
              </span>
            )}
            {test.state === 'error' && (
              <span className="inline-flex items-center gap-1 text-label-sm text-destructive">
                <X className="size-3.5" />
                {test.error}
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={!ready || test.state !== 'success' || saving}
          >
            {saving && <Spinner className="text-label" />}
            {t('settings.messaging.lark.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
