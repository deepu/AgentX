/**
 * Whether the Guarded permission mode is offered: the decision layer is on, its
 * `guardedMode` feature is enabled and a key (or keyless provider) is set, as reported
 * by the server the active workspace talks to. AppShell refreshes it on workspace switch
 * and on the `memwise:decision-settings-changed` event the AI settings page dispatches
 * (other windows pick it up on their next workspace switch).
 */

import { atom } from 'jotai'

export const guardedModeAvailableAtom = atom(false)

/** Dispatched after the decision model settings change, so mode pickers refresh. */
export const DECISION_SETTINGS_CHANGED_EVENT = 'memwise:decision-settings-changed'
