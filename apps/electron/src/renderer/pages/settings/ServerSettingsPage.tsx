/**
 * ServerSettingsPage
 *
 * Configure the Electron app to act as a remote server,
 * accessible from other machines on the network.
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Eye, EyeOff, AlertTriangle, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button, IconButton } from '@/components/ui/button'
import { Spinner } from '@memwise/ui'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { ServerConfig, ServerStatus } from '@memwise/shared/config/server-config'

import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsCardFooter,
  SettingsRow,
  SettingsToggle,
  SettingsInputRow,
} from '@/components/settings'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'server',
}

interface ServerFormState {
  enabled: boolean
  port: string
  tlsCertPath: string
  tlsKeyPath: string
  token: string
}

function configToForm(config: ServerConfig): ServerFormState {
  return {
    enabled: config.enabled,
    port: String(config.port),
    tlsCertPath: config.tlsCertPath ?? '',
    tlsKeyPath: config.tlsKeyPath ?? '',
    token: config.token ?? '',
  }
}

function formToConfig(form: ServerFormState): ServerConfig {
  return {
    enabled: form.enabled,
    port: parseInt(form.port, 10) || 9100,
    tlsCertPath: form.tlsCertPath.trim() || undefined,
    tlsKeyPath: form.tlsKeyPath.trim() || undefined,
    token: form.token || undefined,
  }
}

export default function ServerSettingsPage() {
  const { t } = useTranslation()

  const [form, setForm] = useState<ServerFormState>({
    enabled: false,
    port: '9100',
    tlsCertPath: '',
    tlsKeyPath: '',
    token: '',
  })
  const [savedForm, setSavedForm] = useState<ServerFormState>(form)
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [tokenVisible, setTokenVisible] = useState(false)
  const [error, setError] = useState<string>()

  const isDirty = JSON.stringify(form) !== JSON.stringify(savedForm)

  const loadSettings = useCallback(async () => {
    try {
      const [config, serverStatus] = await Promise.all([
        window.electronAPI.getServerConfig(),
        window.electronAPI.getServerStatus(),
      ])
      const formState = configToForm(config)
      setForm(formState)
      setSavedForm(formState)
      setStatus(serverStatus)
    } catch (err) {
      console.error('Failed to load server settings:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  const handleSave = async () => {
    setError(undefined)
    const port = parseInt(form.port, 10)
    if (isNaN(port) || port < 1024 || port > 65535) {
      setError(t('settings.server.portValidation'))
      return
    }
    if (form.tlsCertPath && !form.tlsKeyPath) {
      setError(t('settings.server.privateKeyRequired'))
      return
    }
    if (form.tlsKeyPath && !form.tlsCertPath) {
      setError(t('settings.server.certificateRequired'))
      return
    }

    setIsSaving(true)
    try {
      await window.electronAPI.setServerConfig(formToConfig(form))
      setSavedForm(form)
      const newStatus = await window.electronAPI.getServerStatus()
      setStatus(newStatus)
      toast.success(t('settings.server.saved'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      toast.error(t('settings.server.failedToSave', { message: msg }))
    } finally {
      setIsSaving(false)
    }
  }

  const handleReset = () => {
    setForm(savedForm)
    setError(undefined)
  }

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    toast.success(t('settings.server.copiedToClipboard', { label }))
  }

  const handleBrowseCert = async () => {
    const paths = await window.electronAPI.openFileDialog()
    if (paths.length > 0) {
      setForm(f => ({ ...f, tlsCertPath: paths[0]! }))
    }
  }

  const handleBrowseKey = async () => {
    const paths = await window.electronAPI.openFileDialog()
    if (paths.length > 0) {
      setForm(f => ({ ...f, tlsKeyPath: paths[0]! }))
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner className="text-tertiary" />
      </div>
    )
  }

  const hasTls = !!(form.tlsCertPath && form.tlsKeyPath)
  const needsRestart = status?.needsRestart ?? false
  const showServerDetails = form.enabled || savedForm.enabled

  return (
    <SettingsPage title={t("settings.server.title")} description={t("settings.server.description")}>

      {/* Enable toggle + restart banner */}
      <SettingsSection title={t("settings.server.remoteAccess")}>
        <SettingsCard>
          <SettingsToggle
            label={t("settings.server.enableServerMode")}
            description={t("settings.server.allowRemoteConnections")}
            checked={form.enabled}
            onCheckedChange={(enabled) => setForm(f => ({ ...f, enabled }))}
          />
        </SettingsCard>

        {needsRestart && (
          <div className="flex items-center gap-2.5 rounded-lg bg-info-tint px-3.5 py-2.5 inset-ring inset-ring-[var(--info-border)]">
            <RotateCw className="size-4 shrink-0 text-info" aria-hidden />
            <span className="flex-1 text-label text-foreground">{t("settings.server.restartRequired")}</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.electronAPI.relaunchApp()}
            >
              {t("settings.server.restartNow")}
            </Button>
          </div>
        )}
      </SettingsSection>

      {/* Connection + TLS — only visible when server mode is relevant */}
      {showServerDetails && (
        <SettingsSection title={t("settings.server.connectionSection")}>
          <SettingsCard>
            <SettingsInputRow
              label={t("settings.server.port")}
              value={form.port}
              onChange={(port) => setForm(f => ({ ...f, port }))}
              placeholder="9100"
            />

            {status && form.enabled && (
              <>
                <SettingsRow label={t("common.url")}>
                  <div className="flex items-center gap-1">
                    <code className="rounded-xs bg-fill-hover px-1.5 py-0.5 font-mono text-mono-ui text-secondary">
                      {status.url}
                    </code>
                    <IconButton
                      size="sm"
                      aria-label={t("common.copy")}
                      icon={<Copy className="size-3.5" />}
                      onClick={() => handleCopy(status.url, 'URL')}
                    />
                  </div>
                </SettingsRow>

                <SettingsRow label={t("settings.server.token")}>
                  <div className="flex items-center gap-1">
                    <code className="max-w-[180px] truncate rounded-xs bg-fill-hover px-1.5 py-0.5 font-mono text-mono-ui text-secondary">
                      {tokenVisible ? status.token : '••••••••••••••••'}
                    </code>
                    <IconButton
                      size="sm"
                      aria-label={tokenVisible ? t("common.hide") : t("common.show")}
                      aria-pressed={tokenVisible}
                      icon={tokenVisible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      onClick={() => setTokenVisible(v => !v)}
                    />
                    <IconButton
                      size="sm"
                      aria-label={t("common.copy")}
                      icon={<Copy className="size-3.5" />}
                      onClick={() => handleCopy(status.token, 'Token')}
                    />
                  </div>
                </SettingsRow>
              </>
            )}

            <SettingsRow label={t("settings.server.certificate")}>
              <div className="flex items-center gap-2">
                <span className="max-w-[200px] truncate text-label-sm text-tertiary">
                  {form.tlsCertPath || 'Not configured'}
                </span>
                <Button variant="secondary" size="sm" onClick={handleBrowseCert}>
                  {t("common.browse")}
                </Button>
              </div>
            </SettingsRow>

            <SettingsRow label={t("settings.server.privateKey")}>
              <div className="flex items-center gap-2">
                <span className="max-w-[200px] truncate text-label-sm text-tertiary">
                  {form.tlsKeyPath || 'Not configured'}
                </span>
                <Button variant="secondary" size="sm" onClick={handleBrowseKey}>
                  {t("common.browse")}
                </Button>
              </div>
            </SettingsRow>
          </SettingsCard>

          {form.enabled && !hasTls && (
            <div className="flex items-start gap-2.5 rounded-lg bg-info-tint px-3.5 py-2.5 inset-ring inset-ring-[var(--info-border)]">
              <AlertTriangle className="mt-px size-4 shrink-0 text-info" aria-hidden />
              <span className="text-label text-foreground">
                {status?.insecureWarning
                  ? t("settings.server.insecureWarning")
                  : t("settings.server.noTlsWarning")}
              </span>
            </div>
          )}
        </SettingsSection>
      )}

      {/* Save/Reset */}
      {error && (
        <p className="text-label-sm text-destructive">{error}</p>
      )}
      {(isDirty || error) && (
        <SettingsCardFooter className="px-0">
          <Button variant="ghost" size="md" onClick={handleReset} disabled={isSaving}>
            {t("common.reset")}
          </Button>
          <Button variant="primary" size="md" onClick={handleSave} disabled={isSaving}>
            {isSaving ? <Spinner /> : null}
            {t("common.save")}
          </Button>
        </SettingsCardFooter>
      )}
    </SettingsPage>
  )
}
