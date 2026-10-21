/** `memwise init`: a new project folder, empty or a copy of the intake sample (Phase 3, 20 §7). */
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DRAFTS_DIR } from './draft-types.ts';
import { BINDINGS_DIR } from './plugin-types.ts';

/** The sample project in this repository (examples/intake). */
// A file URL, not import.meta.dir: the bundled CLI runs on Electron's Node (and passes `source`).
// The Electron main process is bundled as CommonJS, where `import.meta.url` is undefined; it never
// uses this default (it seeds from the shipped examples), so fall back to a relative path there.
export const INTAKE_TEMPLATE_DIR = import.meta.url
  ? fileURLToPath(new URL('../../../examples/intake', import.meta.url))
  : resolve('examples/intake');

/** Playbooks every project ships with: building and changing playbooks, and binding plugins, are runs of these (20 §3, 22 §4). */
export const META_PLAYBOOKS = ['create-playbook', 'change-playbook', 'bind-plugin'] as const;

const EMPTY_ROLES = `# The roles people can have. Steps name one as their assignee; playbooks name one as owner.
roles:
  staff:   { title: Staff, description: Does the day-to-day work }
  manager: { title: Manager, description: Owns the playbooks and approves changes to them }
`;

const EMPTY_POLICY = `# The domain policy layer: playbooks and steps may only tighten it.
policy: domain
effects:
  outbound: approve        # a person sees every message before it goes
`;

export interface InitOptions {
  template?: 'empty' | 'intake';
  /** Where the intake sample (and the meta playbooks) are copied from; default the repository's examples/intake. */
  source?: string;
}

/**
 * Makes a project in `dir` (created if missing; refused when it has anything in it but `.git`).
 * `empty`: domain/roles.yaml, domain/policy.yaml, workflows/ with the meta playbooks when the
 * source has them, and an empty domain/bindings/ (with a `.gitkeep`): a fresh domain binds plugin
 * tools only through frozen bindings (22 §3). `intake`: a copy of the sample project, whose own
 * client-intake uses the app's sample tools, so it gets no bindings folder. Returns the files
 * written, relative.
 */
export async function initProject(dir: string, opts: InitOptions = {}): Promise<string[]> {
  const abs = resolve(dir);
  const source = resolve(opts.source ?? INTAKE_TEMPLATE_DIR);
  if (existsSync(abs)) {
    const entries = (await readdir(abs)).filter((e) => e !== '.git');
    if (entries.length) throw new Error(`${dir} is not empty; memwise init makes a new project in an empty folder`);
  }
  await mkdir(abs, { recursive: true });

  if ((opts.template ?? 'empty') === 'intake') {
    if (!existsSync(join(source, 'workflows'))) throw new Error(`the intake template was not found at ${source}`);
    // Drafts and dotfiles are someone's work in progress, not part of the template.
    await cp(source, abs, {
      recursive: true,
      filter: (src) => {
        const rel = src.slice(source.length).replace(/\\/g, '/');
        return !rel.split('/').some((p) => p.startsWith('.')) && !rel.startsWith(`/${DRAFTS_DIR}`);
      },
    });
  } else {
    await mkdir(join(abs, 'domain'), { recursive: true });
    await mkdir(join(abs, 'workflows'), { recursive: true });
    await writeFile(join(abs, 'domain', 'roles.yaml'), EMPTY_ROLES);
    await writeFile(join(abs, 'domain', 'policy.yaml'), EMPTY_POLICY);
    for (const id of META_PLAYBOOKS) {
      const from = join(source, 'workflows', id);
      if (existsSync(join(from, 'workflow.yaml'))) await cp(from, join(abs, 'workflows', id), { recursive: true });
    }
    // `.gitkeep` keeps the empty bindings folder in git; the loaders skip dotfiles.
    await mkdir(join(abs, BINDINGS_DIR), { recursive: true });
    await writeFile(join(abs, BINDINGS_DIR, '.gitkeep'), '');
  }
  return listRelative(abs);
}

async function listRelative(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listRelative(root, rel)));
    else out.push(rel);
  }
  return out.sort();
}
