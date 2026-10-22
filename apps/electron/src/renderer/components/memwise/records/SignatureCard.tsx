/**
 * The signature at the foot of a page that signs (doc 26 §2, mock `Sign`; 24 §9): the meaning of
 * the signature, the person's password, what signing records, and Send back / Sign. A wrong
 * password or a lock-out shows under the card; someone with no password yet is sent to the
 * dialog that lets them choose one (`onNeedsPassword`).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, PenLine, Undo2 } from 'lucide-react'
import type { MwSubmitResult } from '@memwise/shared/protocol'
import { Input } from '@/components/ui/input'
import { signRefusal } from './SignDialog'

export interface SignatureCardProps {
  meaning: string
  /** Signs with the password; the result says whether the signature was taken. */
  onSign: (password: string) => Promise<MwSubmitResult>
  onSendBack?: () => void
  /** The person has no password to sign with yet. */
  onNeedsPassword?: () => void
  disabled?: boolean
  busy?: 'sign' | 'sendBack' | null
}

export function SignatureCard({ meaning, onSign, onSendBack, onNeedsPassword, disabled, busy }: SignatureCardProps) {
  const { t, i18n } = useTranslation()
  const [password, setPassword] = React.useState('')
  const [result, setResult] = React.useState<MwSubmitResult | null>(null)
  const id = React.useId()
  const refusal = result && !result.applied ? signRefusal(result, t, i18n.language) : undefined
  const locked = result?.code === 'submit.locked'

  const sign = async () => {
    if (!password || disabled || locked) return
    const r = await onSign(password)
    setResult(r)
    if (!r.applied) setPassword('')
    if (r.code === 'submit.password-not-set') onNeedsPassword?.()
  }

  return (
    <form
      className="rounded-[12px] border border-foreground/12 bg-background px-4 py-4"
      data-testid="signature-card"
      onSubmit={e => { e.preventDefault(); void sign() }}
    >
      <h3 className="mb-2 text-label font-semibold text-foreground">{t('memwise.everyPage.yourSignature')}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="block text-label-sm text-secondary">{t('memwise.everyPage.signMeaning')}</span>
          <select className="h-8 w-full rounded-[7px] border border-foreground/15 bg-background px-2 text-label" value={meaning} disabled data-meaning-select>
            <option value={meaning}>{meaning}</option>
          </select>
        </label>
        <label className="space-y-1" htmlFor={id}>
          <span className="block text-label-sm text-secondary">{t('memwise.sign.password')}</span>
          <Input
            id={id}
            type="password"
            autoComplete="current-password"
            className="h-8"
            value={password}
            onChange={e => setPassword(e.target.value)}
            disabled={disabled || locked || !!busy}
            aria-invalid={!!refusal || undefined}
            data-signature-password
          />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-label-sm text-secondary">{t('memwise.everyPage.signingRecords')}</p>
        {onSendBack && (
          <button type="button" onClick={onSendBack} disabled={disabled || !!busy} className="inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-foreground/15 px-3 text-label hover:bg-fill-hover disabled:opacity-50" data-action="send-back">
            <Undo2 className="size-3.5" />{busy === 'sendBack' ? t('memwise.inbox.sending') : t('memwise.review.sendBack')}
          </button>
        )}
        <button type="submit" disabled={!password || disabled || locked || !!busy} className="inline-flex h-8 items-center gap-1.5 rounded-[7px] bg-foreground px-3 text-label font-medium text-background hover:bg-foreground/85 disabled:opacity-50" data-action="sign">
          <PenLine className="size-3.5" />{busy === 'sign' ? t('memwise.sign.signing') : t('memwise.sign.sign')}
        </button>
      </div>
      {refusal && (
        <p className="mt-2 flex items-center gap-1.5 text-label-sm text-destructive" role="alert" data-sign-error={result?.code ?? 'error'}>
          <AlertTriangle className="size-3.5" />{refusal}
        </p>
      )}
    </form>
  )
}
