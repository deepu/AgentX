/**
 * Signing a person step (24 §9): who you are signing as, what the signature means, and your
 * password. A wrong password says so plainly; after too many tries the account is locked
 * until a time the server gives. `SignForm` is the dialog's body (rendered on its own in tests).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, PenLine } from 'lucide-react'
import type { MwSubmitResult } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { resultMessage } from '../format'
import { lockedMessage } from './record-model'

export interface SignRequest {
  /** "Priya Shah". */
  name: string
  /** "TMF specialist" (the person's role, in words). */
  role?: string
  meaning: string
  /** What the button says ("Approve and sign", "Sign and file"). */
  action?: string
}

export interface SignFormProps extends SignRequest {
  /** Sends the step with the password; the result says whether the signature was taken. */
  onSign: (password: string) => Promise<MwSubmitResult>
  onCancel: () => void
  /** A result to show from the start (the playground, tests). */
  initialResult?: MwSubmitResult | null
}

/** Why a signature was refused, in words. */
export function signRefusal(result: MwSubmitResult, t: ReturnType<typeof useTranslation>['t'], locale?: string): string | undefined {
  if (result.applied) return undefined
  if (result.code === 'submit.locked') return lockedMessage(result.retryAfter, t, locale)
  if (result.code === 'submit.signature-failed') return t('memwise.sign.wrongPassword')
  if (result.code === 'submit.signature-required') return t('memwise.sign.passwordNeeded')
  return resultMessage(result, t) ?? t('memwise.inbox.notApplied')
}

export function SignForm({ name, role, meaning, action, onSign, onCancel, initialResult = null }: SignFormProps) {
  const { t, i18n } = useTranslation()
  const [password, setPassword] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<MwSubmitResult | null>(initialResult)
  const id = React.useId()
  const locked = result?.code === 'submit.locked'
  const refusal = result ? signRefusal(result, t, i18n.language) : undefined

  const submit = async () => {
    if (!password || busy || locked) return
    setBusy(true)
    try {
      const r = await onSign(password)
      setResult(r)
      if (!r.applied) setPassword('')
    } catch (err) {
      setResult({ applied: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="space-y-4"
      data-sign-form
      onSubmit={e => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="space-y-1 rounded-md bg-fill-hover/60 px-3.5 py-3 text-label">
        <p data-signing-as>
          {role ? t('memwise.sign.signingAsRole', { name, role }) : t('memwise.sign.signingAs', { name })}
        </p>
        <p className="text-secondary" data-meaning>{t('memwise.sign.meaning', { meaning })}</p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor={id} className="block text-label font-medium text-foreground">{t('memwise.sign.password')}</label>
        <Input
          id={id}
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={e => setPassword(e.target.value)}
          disabled={busy || locked}
          aria-invalid={!!refusal || undefined}
        />
        <p className="text-label-sm text-tertiary">{t('memwise.sign.stored')}</p>
      </div>
      {refusal && (
        <Info_Alert variant="error" inline icon={<AlertTriangle />}>
          <Info_Alert.Title data-sign-error={result?.code ?? 'error'}>{refusal}</Info_Alert.Title>
        </Info_Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={!password || busy || locked} data-action="sign">
          <PenLine />
          {busy ? t('memwise.sign.signing') : action ?? t('memwise.sign.sign')}
        </Button>
      </div>
    </form>
  )
}

export interface SignDialogProps extends Omit<SignFormProps, 'onCancel'> {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SignDialog({ open, onOpenChange, ...form }: SignDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('memwise.sign.title')}</DialogTitle>
          <DialogDescription>{t('memwise.sign.description')}</DialogDescription>
        </DialogHeader>
        {open && <SignForm {...form} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}
