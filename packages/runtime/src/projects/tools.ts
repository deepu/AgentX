/**
 * The kernel's `projects.*` tools (26 §3): what the `create-project` meta playbook's conversation
 * calls when someone describes a new project in chat. `projects.options` reads what the app offers
 * (template cards, projects to copy); `projects.create_draft` makes the draft, exactly as New
 * project does. Nothing runs in it until someone presses Start study.
 */
import type { ToolDefinition } from '@memwise/gateway';
import type { Actor } from '../types.ts';
import type { ProjectsService } from './types.ts';

export const PROJECT_TOOLS_PLUGIN = 'memwise';
export const PROJECT_OPTIONS_TOOL = 'projects.options';
export const CREATE_DRAFT_PROJECT_TOOL = 'projects.create_draft';

const str = { type: 'string' } as const;
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const actorOf = (onBehalfOf?: string): Actor => (onBehalfOf ? { kind: 'person', personId: onBehalfOf, roles: [] } : { kind: 'system' });

/**
 * `service` absent (`memwise check`, example cases that stub them): definitions only. `actor`
 * turns the person a step acts for into their actor with grants.
 */
export function projectTools(service?: () => ProjectsService | undefined, actor?: (personId: string) => Promise<Actor>): ToolDefinition[] {
  const source = { plugin: PROJECT_TOOLS_PLUGIN };
  const need = (): ProjectsService => {
    const s = service?.();
    if (!s) throw new Error('projects tools need a kernel with a workspace folder');
    return s;
  };
  const who = async (onBehalfOf?: string): Promise<Actor> => (onBehalfOf && actor ? actor(onBehalfOf) : actorOf(onBehalfOf));

  const options: ToolDefinition<{ app: string }> = {
    name: PROJECT_OPTIONS_TOOL,
    description: "What a new project of an app can start from: the app's template cards and the projects there are to copy (their way of working, never their records).",
    inputSchema: object({ app: { ...str, description: 'The app id, e.g. etmf' } }, ['app']),
    effect: 'read',
    source,
    async execute({ app }, ctx) {
      const apps = await need().apps(await who(ctx.token.onBehalfOf));
      const a = apps.find((x) => x.id === app);
      if (!a) throw new Error(`there is no app ${app}`);
      return {
        app: a.id, title: a.title, nouns: a.nouns, version: a.version,
        templates: a.templates.map((t) => ({ id: t.id, title: t.title, ...(t.description ? { description: t.description } : {}) })),
        projects: a.projects.map((p) => ({ id: p.id, name: p.name, status: p.status, ...(p.study ? { study: p.study } : {}) })),
      };
    },
  };

  const createDraft: ToolDefinition<{ app: string; name: string; template?: string; copy_from?: string; study?: string }> = {
    name: CREATE_DRAFT_PROJECT_TOOL,
    description: 'Make a new project as a draft, from a template card or a copy of a project (no records are copied). Nothing runs in it until someone starts it.',
    inputSchema: object({
      app: str, name: { ...str, description: 'What people call it, e.g. Study MW-310' },
      template: { ...str, description: 'A template card id from projects.options' },
      copy_from: { ...str, description: 'A project id to copy the way of working from' },
      study: { ...str, description: 'The study key, e.g. MW-310' },
    }, ['app', 'name']),
    effect: 'draft',
    idempotent: true,
    source,
    async execute({ app, name, template, copy_from, study }, ctx) {
      const s = need();
      const by = await who(ctx.token.onBehalfOf);
      // The same draft asked for twice (a retried call) is the one already made.
      const existing = (await s.list(by, { app })).find((p) => p.name === name.trim() && p.status === 'draft');
      const p = existing ?? await s.create({ app, name, ...(template ? { template } : {}), ...(copy_from ? { copyFrom: copy_from } : {}), ...(study ? { study } : {}) }, by);
      return { project: p.id, name: p.name, status: p.status };
    },
  };

  return [options, createDraft];
}
