/**
 * Mermaid export of a playbook's map (05 §9): a `stateDiagram-v2`, left to right, that any
 * Mermaid renderer (GitHub, docs sites, the chat's markdown) can draw.
 */

import type { MwPlaybook } from '@memwise/shared/protocol'
import { END_ID, TIMEOUT_EVENT, humanizeEvent } from './layout'

export interface MermaidOptions {
  /** Title for a state; defaults to the step title, else the state id in plain words. */
  titleOf?: (stateId: string) => string
  /** Label for a timeout edge; defaults to "timeout". */
  timeoutLabel?: (afterMs: number) => string
}

/** Mermaid ids allow letters, digits and underscores. */
function mermaidId(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9_]/g, '_')
  return /^[A-Za-z_]/.test(clean) ? clean : `s_${clean}`
}

/** Text that is safe inside a quoted Mermaid state name or after an edge's colon. */
function mermaidText(text: string): string {
  return text.replace(/"/g, '#quot;').replace(/:/g, '#58;').replace(/[\r\n]+/g, ' ').trim()
}

export function toMermaid(playbook: MwPlaybook, options: MermaidOptions = {}): string {
  const titleOf =
    options.titleOf ??
    ((id: string) => {
      const step = playbook.states.find((s) => s.id === id)?.stepId
      return (step && playbook.steps[step]?.title) || humanizeEvent(id)
    })
  const node = (id: string) => (id === END_ID ? '[*]' : mermaidId(id))
  const lines = ['stateDiagram-v2', '  direction LR']
  for (const state of playbook.states) {
    lines.push(`  state "${mermaidText(titleOf(state.id))}" as ${mermaidId(state.id)}`)
  }
  if (playbook.states.some((s) => s.id === playbook.start)) lines.push(`  [*] --> ${mermaidId(playbook.start)}`)
  for (const state of playbook.states) {
    for (const [event, target] of Object.entries(state.on)) {
      lines.push(`  ${mermaidId(state.id)} --> ${node(target)}: ${mermaidText(humanizeEvent(event))}`)
    }
    const timeout = state.wait?.timeout
    if (timeout) {
      const label = options.timeoutLabel ? options.timeoutLabel(timeout.afterMs) : TIMEOUT_EVENT
      lines.push(`  ${mermaidId(state.id)} --> ${node(timeout.target)}: ${mermaidText(label)}`)
    }
  }
  return lines.join('\n') + '\n'
}
