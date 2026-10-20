/**
 * The project folder (19 §9): definitions stay files (D13). On first start it is seeded from the
 * bundled `examples/intake`, found among the bundled resources or, in dev, in the repo.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const EXAMPLE = join('examples', 'intake')

function isProject(dir: string): boolean {
  return existsSync(join(dir, 'workflows')) || existsSync(join(dir, 'domain'))
}

/** Walks up from `start` looking for `examples/intake`. */
function findUp(start: string): string | undefined {
  let dir = resolve(start)
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, EXAMPLE)
    if (isProject(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * The example project to seed from: `MEMWISE_EXAMPLE_PROJECT_DIR`, then `<root>/examples/intake`
 * under each given root (bundled resources, app root), then walking up from them and from cwd.
 */
export function findExampleProject(roots: (string | undefined)[] = []): string | undefined {
  const env = process.env.MEMWISE_EXAMPLE_PROJECT_DIR
  if (env && isProject(env)) return resolve(env)
  const starts = [...roots.filter((r): r is string => !!r), process.cwd()]
  for (const root of starts) {
    const direct = join(root, EXAMPLE)
    if (isProject(direct)) return direct
  }
  for (const root of starts) {
    const found = findUp(root)
    if (found) return found
  }
  return undefined
}

/** Seeds `projectDir` from the example when it is missing or empty. Returns whether it seeded. */
export function seedProject(projectDir: string, exampleDir: string | undefined): boolean {
  const empty = !existsSync(projectDir) || readdirSync(projectDir).filter((f) => !f.startsWith('.')).length === 0
  if (!empty) return false
  if (!exampleDir) throw new Error(`The example playbooks were not found, so ${projectDir} could not be set up.`)
  mkdirSync(projectDir, { recursive: true })
  cpSync(exampleDir, projectDir, { recursive: true })
  return true
}

/** The meta playbooks that build and change playbooks (20 §3); shipped with the example project. */
export const META_PLAYBOOK_DIRS = ['create-playbook', 'change-playbook'] as const

/**
 * Adds the meta playbooks to a project that lacks them (installs seeded in Phase 2 got only
 * client-intake). Copies `workflows/<id>/` from the example when the project has no folder of
 * that name; never touches one that is there. Returns the ids it added.
 */
export function addMissingMetaPlaybooks(projectDir: string, exampleDir: string | undefined): string[] {
  if (!exampleDir || !existsSync(projectDir)) return []
  const added: string[] = []
  for (const id of META_PLAYBOOK_DIRS) {
    const from = join(exampleDir, 'workflows', id)
    const to = join(projectDir, 'workflows', id)
    if (!existsSync(from) || existsSync(to)) continue
    mkdirSync(join(projectDir, 'workflows'), { recursive: true })
    cpSync(from, to, { recursive: true })
    added.push(id)
  }
  return added
}

/**
 * Whether a change in the project folder should re-index it: only `domain/` and `workflows/`
 * are live. Drafts (`drafts/`) are edited all the time by chats and the editor and never
 * affect the index; publishing writes to `workflows/`, which does.
 */
export function affectsIndex(relativePath: string | null | undefined): boolean {
  if (!relativePath) return true // the platform didn't say which file: be safe
  const first = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').split('/')[0]
  return first === 'domain' || first === 'workflows'
}
