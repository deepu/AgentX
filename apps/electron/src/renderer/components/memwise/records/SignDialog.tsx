/**
 * Signing a person step (24 §9): who you are signing as, what the signature means, and your
 * password. A wrong password says so plainly; after too many tries the account is locked
 * until a time the server gives. Someone with no password yet (the desktop owner) chooses one
 * first, then signs with it. `SignForm` is the dialog's body (rendered on its own in tests).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, PenLine } from 'lucide-react'
import { useAtomValue } from 'jotai'
import type { MwSetPasswordResult, MwSubmitResult } from '@memwise/shared/protocol'
import { memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi } from '@/hooks/useMemwise'
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
  /** Sets the person's first password (they have none to sign with yet). */
  onSetPassword?: (password: string) => Promise<MwSetPasswordResult>
}

/** The shortest password a regulated workspace takes (24 §9). */
export const MIN_SIGNING_PASSWORD = 12

/** Why a signature was refused, in words. */
export function signRefusal(result: MwSubmitResult, t: ReturnType<typeof useTranslation>['t'], locale?: string): string | undefined {
  if (result.applied) return undefined
  if (result.code === 'submit.locked') return lockedMessage(result.retryAfter, t, locale)
  if (result.code === 'submit.signature-failed') return t('memwise.sign.wrongPassword')
  if (result.code === 'submit.signature-required') return t('memwise.sign.passwordNeeded')
  if (result.code === 'submit.password-not-set') return undefined
  return resultMessage(result, t) ?? t('memwise.inbox.notApplied')
}

export function SignForm({ name, role, meaning, action, onSign, onCancel, initialResult = null, onSetPassword }: SignFormProps) {
  const { t, i18n } = useTranslation()
  const [password, setPassword] = React.useState('')
  const [repeat, setRepeat] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<MwSubmitResult | null>(initialResult)
  const [choiceError, setChoiceError] = React.useState<string | null>(null)
  const id = React.useId()
  const locked = result?.code === 'submit.locked'
  // No password yet: choose one (twice), then sign with it.
  const choosing = result?.code === 'submit.password-not-set' && !!onSetPassword
  const refusal = choiceError ?? (result ? signRefusal(result, t, i18n.language) : undefined)

  const sign = async (pw: string) => {
    const r = await onSign(pw)
    setResult(r)
    if (!r.applied) { setPassword(''); setRepeat('') }
  }

  const submit = async () => {
    if (!password || busy || locked) return
    setBusy(true)
    setChoiceError(null)
    try {
      if (choosing) {
        if (password.length < MIN_SIGNING_PASSWORD) { setChoiceError(t('memwise.sign.chooseTooShort', { min: MIN_SIGNING_PASSWORD })); return }
        if (password !== repeat) { setChoiceError(t('memwise.sign.chooseMismatch')); return }
        const set = await onSetPassword!(password)
        if (!set.applied) { setChoiceError(set.message ?? t('memwise.inbox.notApplied')); return }
      }
      await sign(password)
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
      {choosing && <p className="text-label" data-choose-password>{t('memwise.sign.chooseIntro', { min: MIN_SIGNING_PASSWORD })}</p>}
      <div className="space-y-1.5">
        <label htmlFor={id} className="block text-label font-medium text-foreground">{choosing ? t('memwise.sign.choosePassword') : t('memwise.sign.password')}</label>
        <Input
          id={id}
          type="password"
          autoComplete={choosing ? 'new-password' : 'current-password'}
          autoFocus
          value={password}
          onChange={e => setPassword(e.target.value)}
          disabled={busy || locked}
          aria-invalid={!!refusal || undefined}
        />
        {!choosing && <p className="text-label-sm text-tertiary">{t('memwise.sign.stored')}</p>}
      </div>
      {choosing && (
        <div className="space-y-1.5">
          <label htmlFor={`${id}-repeat`} className="block text-label font-medium text-foreground">{t('memwise.sign.chooseRepeat')}</label>
          <Input
            id={`${id}-repeat`}
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={e => setRepeat(e.target.value)}
            disabled={busy}
            data-repeat
          />
        </div>
      )}
      {refusal && (
        <Info_Alert variant="error" inline icon={<AlertTriangle />}>
          <Info_Alert.Title data-sign-error={choiceError ? 'choose' : result?.code ?? 'error'}>{refusal}</Info_Alert.Title>
        </Info_Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button>
        <Button type="submit" variant="primary" disabled={!password || busy || locked} data-action="sign">
          <PenLine />
          {busy ? t('memwise.sign.signing') : choosing ? t('memwise.sign.chooseAndSign') : action ?? t('memwise.sign.sign')}
        </Button>
      </div>
    </form>
  )
}

export interface SignDialogProps extends Omit<SignFormProps, 'onCancel'> {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Sets the signed-in person's first password through the app API. */
function useSetOwnPassword(): (password: string) => Promise<MwSetPasswordResult> {
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  return React.useCallback(async (password: string) => {
    const api = getMemwiseApi()
    if (!api || !workspaceId) return { applied: false }
    return api.memwiseSetOwnPassword(workspaceId, { password })
  }, [workspaceId])
}

export function SignDialog({ open, onOpenChange, ...form }: SignDialogProps) {
  const { t } = useTranslation()
  const setOwnPassword = useSetOwnPassword()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('memwise.sign.title')}</DialogTitle>
          <DialogDescription>{t('memwise.sign.description')}</DialogDescription>
        </DialogHeader>
        {open && <SignForm onSetPassword={setOwnPassword} {...form} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}
