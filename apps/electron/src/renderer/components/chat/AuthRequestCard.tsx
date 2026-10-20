import * as React from 'react'
import { useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Key, KeyRound, User, Lock, Eye, EyeOff, CheckCircle2, ShieldCheck, XCircle, type LucideIcon } from 'lucide-react'
import { Spinner } from '@memwise/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { Message, CredentialResponse } from '../../../shared/types'
import type { AuthRequestType } from '@memwise/core/types'
import { validateBasicAuthCredentials, getPasswordValue, getPasswordLabel, getPasswordPlaceholder } from '@/utils/auth-validation'
import {
  DECISION_ACTION,
  DecisionActions,
  DecisionBody,
  DecisionCard,
  DecisionDetails,
  DecisionFoot,
  DecisionHeader,
} from '@/components/app-shell/input/structured/DecisionCard'

// ============================================================================
// Primitives
// ============================================================================

/** Outcome tones (spec §2.4): role tint + solved text, plus a distinct icon so it is never color alone. */
type AuthOutcomeTone = 'success' | 'error' | 'muted'

const OUTCOME_STYLES: Record<AuthOutcomeTone, { container: string; icon: string; title: string }> = {
  success: { container: 'bg-success-tint', icon: 'text-success', title: 'text-success' },
  error: { container: 'bg-destructive-tint', icon: 'text-destructive', title: 'text-destructive' },
  muted: { container: 'bg-fill-hover', icon: 'text-tertiary', title: 'text-secondary' },
}

/** Field chrome shared by every credential input: icon inset, reveal toggle on the right. */
const FIELD_LABEL = 'text-label-sm text-secondary'
const FIELD_ICON = 'pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-tertiary'
const REVEAL_BUTTON = 'absolute right-3 top-1/2 -translate-y-1/2 text-tertiary transition-colors hover:text-foreground hover:duration-instant'

/** A finished auth request: quiet tinted card with icon, title and up to two detail lines. */
function AuthOutcome({
  tone,
  icon: Icon,
  title,
  subtitle,
  subtitleSecondary,
  className,
}: {
  tone: AuthOutcomeTone
  icon: LucideIcon
  title: string
  subtitle?: string
  subtitleSecondary?: string
  className?: string
}) {
  const style = OUTCOME_STYLES[tone]
  return (
    <div className={cn('flex gap-2.5 rounded-lg py-2.5 pl-3.5 pr-4 select-none', style.container, className)}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', style.icon)} />
      <div className="min-w-0 flex-1">
        <div className={cn('text-label font-medium', style.title)}>{title}</div>
        {subtitle && (
          <div className="mt-0.5 text-label-sm text-secondary">{subtitle}</div>
        )}
        {subtitleSecondary && (
          <div className="mt-0.5 text-label-sm text-secondary">{subtitleSecondary}</div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

interface AuthRequestCardProps {
  message: Message
  /** Callback to respond to credential request */
  onRespondToCredential?: (sessionId: string, requestId: string, response: CredentialResponse) => void
  /** Session ID for this auth request */
  sessionId: string
  /** Whether the card is interactive (last message, no user message after). Default true. */
  isInteractive?: boolean
}

/**
 * AuthRequestCard - Inline auth UI displayed in chat history
 *
 * Renders different UIs based on auth type:
 * - credential: Form for API key, bearer token, basic auth
 * - oauth/oauth-google/oauth-slack/oauth-microsoft: OAuth flow with browser redirect
 *
 * Status handling:
 * - pending: Show interactive form/button
 * - completed: Show success state
 * - cancelled: Show cancelled state
 * - failed: Show error state
 */
export function AuthRequestCard({ message, onRespondToCredential, sessionId, isInteractive = true }: AuthRequestCardProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const {
    authRequestId,
    authRequestType,
    authSourceSlug,
    authSourceName,
    authStatus,
    authCredentialMode,
    authHeaderName,
    authHeaderNames,
    authLabels,
    authDescription,
    authHint,
    authSourceUrl,
    authPasswordRequired,
    authError,
    authEmail,
    authWorkspace,
  } = message

  // Multi-header state: { "DD-API-KEY": "", "DD-APPLICATION-KEY": "" }
  const [headerValues, setHeaderValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    if (authHeaderNames) {
      for (const name of authHeaderNames) {
        initial[name] = ''
      }
    }
    return initial
  })

  const isBasicAuth = authCredentialMode === 'basic'
  const isMultiHeader = authCredentialMode === 'multi-header'
  const passwordRequired = authPasswordRequired ?? true  // default true for backward compatibility

  // Validation logic
  const isValid = isBasicAuth
    ? validateBasicAuthCredentials(username, password, passwordRequired)
    : isMultiHeader
    ? authHeaderNames?.every(name => headerValues[name]?.trim().length > 0) ?? false
    : value.trim().length > 0

  const handleSubmit = useCallback(() => {
    if (!isValid || !authRequestId || !onRespondToCredential) return

    setIsSubmitting(true)

    if (isBasicAuth) {
      onRespondToCredential(sessionId, authRequestId, {
        type: 'credential',
        username: username.trim(),
        password: getPasswordValue(password, passwordRequired),
        cancelled: false
      })
    } else if (isMultiHeader) {
      // Trim all header values
      const trimmedHeaders: Record<string, string> = {}
      for (const [key, val] of Object.entries(headerValues)) {
        trimmedHeaders[key] = val.trim()
      }
      onRespondToCredential(sessionId, authRequestId, {
        type: 'credential',
        headers: trimmedHeaders,
        cancelled: false
      })
    } else {
      onRespondToCredential(sessionId, authRequestId, {
        type: 'credential',
        value: value.trim(),
        cancelled: false
      })
    }
  }, [isBasicAuth, isMultiHeader, username, password, value, headerValues, isValid, onRespondToCredential, sessionId, authRequestId, passwordRequired])

  const handleCancel = useCallback(() => {
    if (!authRequestId || !onRespondToCredential) return
    onRespondToCredential(sessionId, authRequestId, { type: 'credential', cancelled: true })
  }, [onRespondToCredential, sessionId, authRequestId])

  const handleFormSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    handleSubmit()
  }, [handleSubmit])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && isValid) {
      handleSubmit()
    } else if (e.key === 'Escape') {
      handleCancel()
    }
  }, [isValid, handleSubmit, handleCancel])

  // Restarting supersedes the running attempt; only the latest one may end the spinner
  const oauthAttemptRef = useRef(0)
  const startOAuth = useCallback(async (restart: boolean) => {
    // Client-driven OAuth: callback server runs locally, server owns tokens. If another
    // session is already signing in to this source, this waits for that sign-in instead.
    if (!authRequestId || !authSourceSlug) {
      console.warn('[AuthRequestCard] handleOAuthClick bailed: missing', {
        authRequestId: authRequestId ?? 'MISSING',
        authSourceSlug: authSourceSlug ?? 'MISSING',
        sessionId,
      })
      return
    }
    const attempt = ++oauthAttemptRef.current
    setIsSubmitting(true)
    try {
      const result = await window.electronAPI.performOAuth({
        sourceSlug: authSourceSlug,
        sessionId,
        authRequestId,
        restart,
      })
      if (!result.success) {
        console.warn('[AuthRequestCard] performOAuth returned failure:', result.error)
      }
    } catch (error) {
      console.error('[AuthRequestCard] performOAuth threw:', error)
    } finally {
      if (oauthAttemptRef.current === attempt) setIsSubmitting(false)
    }
  }, [sessionId, authRequestId, authSourceSlug])
  const handleOAuthClick = useCallback(() => startOAuth(false), [startOAuth])
  // The browser sign-in was closed or lost: replace it with a fresh one
  const handleRestartOAuth = useCallback(() => startOAuth(true), [startOAuth])

  // Get field labels
  const credentialLabel = authLabels?.credential ||
    (authCredentialMode === 'bearer' ? 'Bearer Token' : 'API Key')
  const usernameLabel = authLabels?.username || 'Username'
  const basePasswordLabel = authLabels?.password || 'Password'
  const passwordLabel = getPasswordLabel(basePasswordLabel, passwordRequired)
  const passwordPlaceholder = getPasswordPlaceholder(basePasswordLabel, passwordRequired)

  // Card title per auth type (each language orders name and type itself)
  const getAuthTitle = (type: AuthRequestType | undefined) => {
    const name = authSourceName ?? ''
    switch (type) {
      case 'oauth':
        return t('chat.authCard.titleOAuth', { name })
      case 'oauth-google':
        return t('chat.authCard.titleGoogle', { name })
      case 'oauth-slack':
        return t('chat.authCard.titleSlack', { name })
      case 'oauth-microsoft':
        return t('chat.authCard.titleMicrosoft', { name })
      case 'credential':
      default:
        return t('chat.authCard.titleCredential', { name })
    }
  }

  // Provider shown on the OAuth sign-in button (brand names stay untranslated)
  const getSignInProvider = (type: AuthRequestType | undefined) => {
    switch (type) {
      case 'oauth-google':
        return 'Google'
      case 'oauth-slack':
        return 'Slack'
      case 'oauth-microsoft':
        return 'Microsoft'
      default:
        return 'OAuth'
    }
  }

  // Determine the outcome tone for finished requests
  const outcomeTone: AuthOutcomeTone | null =
    authStatus === 'completed' ? 'success' :
    authStatus === 'cancelled' ? 'muted' :
    authStatus === 'failed' ? 'error' :
    null

  const outcomeTitle =
    authStatus === 'completed' ? t('chat.authCard.connected', { name: authSourceName ?? '' }) :
    authStatus === 'cancelled' ? t('chat.authCard.cancelled', { name: authSourceName ?? '' }) :
    t('chat.authCard.failed', { name: authSourceName ?? '' })

  // Every pending card has actions: the credential form, the OAuth sign-in button, or
  // (while the browser sign-in runs) a way to restart it
  const isOAuth = authRequestType && authRequestType !== 'credential'
  const hasActions = authStatus === 'pending'

  // Compact card view for non-interactive terminal states (after user sends message)
  if (!isInteractive && authStatus !== 'pending' && outcomeTone) {
    const subtitle =
      authStatus === 'completed' && authEmail ? t('chat.authCard.signedInAs', { email: authEmail }) :
      authStatus === 'failed' && authError ? authError :
      undefined

    return (
      <AuthOutcome
        tone={outcomeTone}
        icon={authStatus === 'completed' ? CheckCircle2 : XCircle}
        title={outcomeTitle}
        subtitle={subtitle}
        className="w-fit"
      />
    )
  }

  // Finished request that is still the latest message: same outcome card, full width
  if (outcomeTone) {
    return (
      <AuthOutcome
        tone={outcomeTone}
        icon={authStatus === 'completed' ? CheckCircle2 : XCircle}
        title={outcomeTitle}
        subtitle={
          authStatus === 'completed' ? (authEmail ? t('chat.authCard.signedInAs', { email: authEmail }) : undefined) :
          authStatus === 'failed' ? (authError || undefined) :
          undefined
        }
        subtitleSecondary={authStatus === 'completed' && authWorkspace ? t('chat.authCard.workspace', { workspace: authWorkspace }) : undefined}
      />
    )
  }

  // Render the header based on the pending state
  const renderContent = () => {
    // OAuth authenticating state (waiting for browser)
    if (isOAuth && isSubmitting) {
      return (
        <>
          <DecisionHeader
            tone="info"
            icon={<Spinner className="text-label-sm" />}
            title={t('chat.authCard.authenticating', { name: authSourceName ?? '' })}
          />
          <DecisionDetails>
            <p className="text-label text-secondary">{t('chat.authCard.completeInBrowser')}</p>
          </DecisionDetails>
        </>
      )
    }

    // OAuth pending state (button) or credential form header
    return (
      <>
        <DecisionHeader
          tone="info"
          icon={isOAuth ? <KeyRound /> : <Key />}
          title={getAuthTitle(authRequestType)}
        />
        {authDescription && (
          <DecisionDetails>
            <p className="text-label text-secondary">{authDescription}</p>
          </DecisionDetails>
        )}
      </>
    )
  }

  // Render the credential form fields (separate from header for layout)
  const renderCredentialFields = () => {
    if (authStatus !== 'pending' || isOAuth) return null

    return (
      <DecisionDetails>
      <div className="mt-2 space-y-3">
        {isBasicAuth ? (
          <>
            {/* Username field */}
            <div className="space-y-1.5">
              <Label htmlFor={`auth-username-${authRequestId}`} className={FIELD_LABEL}>
                {usernameLabel}
              </Label>
              <div className="relative">
                <User className={FIELD_ICON} />
                <Input
                  id={`auth-username-${authRequestId}`}
                  name="username"
                  autoComplete="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="pl-9"
                  placeholder={`Enter ${usernameLabel.toLowerCase()}`}
                  autoFocus
                  disabled={isSubmitting}
                />
              </div>
            </div>
            {/* Password field */}
            <div className="space-y-1.5">
              <Label htmlFor={`auth-password-${authRequestId}`} className={FIELD_LABEL}>
                {passwordLabel}
              </Label>
              <div className="relative">
                <Lock className={FIELD_ICON} />
                <Input
                  id={`auth-password-${authRequestId}`}
                  name="password"
                  autoComplete="current-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="pl-9 pr-9"
                  placeholder={passwordPlaceholder}
                  disabled={isSubmitting}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className={REVEAL_BUTTON}
                  aria-label={showPassword ? t('chat.credentials.hideValue') : t('chat.credentials.showValue')}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </>
        ) : isMultiHeader && authHeaderNames ? (
          /* Multi-header fields (e.g., Datadog DD-API-KEY + DD-APPLICATION-KEY) */
          <>
            {authHeaderNames.map((headerName, index) => (
              <div key={headerName} className="space-y-1.5">
                <Label htmlFor={`auth-header-${authRequestId}-${index}`} className={FIELD_LABEL}>
                  {headerName}
                </Label>
                <div className="relative">
                  <Key className={FIELD_ICON} />
                  <Input
                    id={`auth-header-${authRequestId}-${index}`}
                    name={headerName}
                    autoComplete="off"
                    type={showPassword ? 'text' : 'password'}
                    value={headerValues[headerName] || ''}
                    onChange={(e) => setHeaderValues(prev => ({
                      ...prev,
                      [headerName]: e.target.value
                    }))}
                    onKeyDown={handleKeyDown}
                    className="pl-9 pr-9"
                    placeholder={`Enter ${headerName}`}
                    autoFocus={index === 0}
                    disabled={isSubmitting}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className={REVEAL_BUTTON}
                    aria-label={showPassword ? t('chat.credentials.hideValue') : t('chat.credentials.showValue')}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            ))}
          </>
        ) : (
          /* Single credential field (API key, bearer token) */
          <div className="space-y-1.5">
            <Label htmlFor={`auth-value-${authRequestId}`} className={FIELD_LABEL}>
              {credentialLabel}
              {authCredentialMode === 'header' && authHeaderName && (
                <span className="ml-1 font-normal text-tertiary">
                  ({authHeaderName})
                </span>
              )}
            </Label>
            <div className="relative">
              <Key className={FIELD_ICON} />
              <Input
                id={`auth-value-${authRequestId}`}
                name="credential"
                autoComplete="current-password"
                type={showPassword ? 'text' : 'password'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                className="pl-9 pr-9"
                placeholder={`Enter ${credentialLabel.toLowerCase()}`}
                autoFocus
                disabled={isSubmitting}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className={REVEAL_BUTTON}
                aria-label={showPassword ? t('chat.credentials.hideValue') : t('chat.credentials.showValue')}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        )}

        {/* Hint */}
        {authHint && (
          <p className="text-label-sm text-tertiary">
            {authHint}
          </p>
        )}
      </div>
      </DecisionDetails>
    )
  }

  // Render action buttons
  const renderActions = () => {
    if (!hasActions) return null

    // OAuth in progress - the browser sign-in may have been closed or lost
    if (isOAuth && isSubmitting) {
      return (
        <DecisionActions>
          <Button
            size="lg"
            variant="ghost"
            className={DECISION_ACTION}
            onClick={handleRestartOAuth}
          >
            {t('chat.authCard.restartSignIn')}
          </Button>
        </DecisionActions>
      )
    }

    // OAuth pending - sign in button
    if (isOAuth) {
      return (
        <DecisionActions>
          <Button
            size="lg"
            variant="primary"
            className={DECISION_ACTION}
            onClick={handleOAuthClick}
            data-tutorial="oauth-sign-in-button"
          >
            {t('chat.authCard.signInWith', { provider: getSignInProvider(authRequestType) })}
          </Button>
          <Button
            size="lg"
            variant="ghost"
            className={DECISION_ACTION}
            onClick={handleCancel}
          >
            {t('common.cancel')}
          </Button>
        </DecisionActions>
      )
    }

    // Credential form - save button
    return (
      <>
        <DecisionActions>
          <Button
            size="lg"
            variant="primary"
            className={DECISION_ACTION}
            onClick={handleSubmit}
            disabled={!isValid || isSubmitting}
          >
            {isSubmitting && <Spinner className="text-label-sm" />}
            {isSubmitting ? t('common.saving') : t('common.save')}
          </Button>
          <Button
            // The credential form's Cancel must not also submit the typed credential
            type="button"
            size="lg"
            variant="ghost"
            className={DECISION_ACTION}
            onClick={handleCancel}
            disabled={isSubmitting}
          >
            {t('common.cancel')}
          </Button>
        </DecisionActions>
        <DecisionFoot icon={<ShieldCheck />}>{t('chat.authCard.encryptedAtRest')}</DecisionFoot>
      </>
    )
  }

  // Whether this is a pending credential form (needs form wrapper for 1Password)
  const isCredentialForm = authStatus === 'pending' && !isOAuth

  const cardContent = (
    <>
      <DecisionBody className={cn('overflow-visible', !hasActions && 'pb-3.5')}>
        {renderContent()}
        {renderCredentialFields()}
      </DecisionBody>

      {hasActions && renderActions()}
    </>
  )

  return (
    <DecisionCard tone="info" standalone>
      {/* Form wrapper enables password manager (1Password) detection and autofill.
          action points to the source URL for domain-based credential matching. */}
      {isCredentialForm ? (
        <form
          onSubmit={handleFormSubmit}
          action={authSourceUrl || undefined}
          method="post"
        >
          {cardContent}
        </form>
      ) : (
        cardContent
      )}
    </DecisionCard>
  )
}

/**
 * Memoized version for performance in chat list
 */
export const MemoizedAuthRequestCard = React.memo(AuthRequestCard, (prev, next) => {
  return (
    prev.message.id === next.message.id &&
    prev.message.authStatus === next.message.authStatus &&
    prev.sessionId === next.sessionId &&
    prev.isInteractive === next.isInteractive
  )
})
