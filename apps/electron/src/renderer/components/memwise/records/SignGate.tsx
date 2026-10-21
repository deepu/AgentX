/**
 * The sign gate for any person step with `sign:` (24 §9). It wraps `submitStep`: an approving
 * answer opens the signing dialog first and is sent with the password; a step the screen did not
 * know signs (the server answers `submit.signature-required`) opens it too. Cancelling sends nothing.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { MwSubmitResult, MwSubmitStepInput } from '@memwise/shared/protocol'
import { isNegativeOutcome } from '../format'
import { SignDialog } from './SignDialog'

export interface Signer {
  name: string
  role?: string
}

interface Pending {
  input: MwSubmitStepInput
  resolve: (r: MwSubmitResult) => void
}

/** The answer a cancelled signature gives back to the screen that asked. */
export const SIGN_CANCELLED: MwSubmitResult = { applied: false, code: 'sign.cancelled' }

/** Whether this answer must be signed before it is sent. */
export function needsSignature(sign: { meaning: string } | undefined, outcome: string): boolean {
  return !!sign && !isNegativeOutcome(outcome)
}

export function useSignGate({ sign, signer, submit }: {
  sign?: { meaning: string }
  signer?: Signer
  submit: (input: MwSubmitStepInput) => Promise<MwSubmitResult>
}): { submit: (input: MwSubmitStepInput) => Promise<MwSubmitResult>; dialog: React.ReactNode } {
  const { t } = useTranslation()
  const [pending, setPending] = React.useState<Pending | null>(null)
  const [meaning, setMeaning] = React.useState<string>('')
  // A pending promise is answered once, whichever of sign or cancel comes first.
  const settle = React.useCallback((r: MwSubmitResult) => {
    setPending(p => {
      p?.resolve(r)
      return null
    })
  }, [])

  const gated = React.useCallback(async (input: MwSubmitStepInput): Promise<MwSubmitResult> => {
    if (!input.signature && needsSignature(sign, input.outcome)) {
      setMeaning(sign!.meaning)
      return new Promise<MwSubmitResult>(resolve => setPending({ input, resolve }))
    }
    const r = await submit(input)
    if (!r.applied && (r.code === 'submit.signature-required' || r.code === 'submit.password-not-set') && !input.signature) {
      setMeaning(sign?.meaning ?? r.message ?? '')
      return new Promise<MwSubmitResult>(resolve => setPending({ input, resolve }))
    }
    return r
  }, [sign, submit])

  const dialog = (
    <SignDialog
      open={!!pending}
      onOpenChange={open => { if (!open) settle(SIGN_CANCELLED) }}
      name={signer?.name ?? t('memwise.sign.you')}
      role={signer?.role}
      meaning={meaning}
      action={t('memwise.review.signAndApprove')}
      onSign={async password => {
        if (!pending) return SIGN_CANCELLED
        const r = await submit({ ...pending.input, signature: { password } })
        // A wrong password or a lock-out stays in the dialog; anything else goes back to the screen.
        if (r.applied || (r.code !== 'submit.signature-failed' && r.code !== 'submit.locked' && r.code !== 'submit.password-not-set')) settle(r)
        return r
      }}
    />
  )
  return { submit: gated, dialog }
}
