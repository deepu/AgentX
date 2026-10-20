/** Fixture plugins (tests/fixtures/plugins) and a domain to bind them into. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bindingPath, installPlugin, loadPlugin, type CheckEnvironment } from '../src/index.ts';
import { makeProject } from './fixture.ts';

export const FIXTURES = join(import.meta.dir, 'fixtures', 'plugins');
export const INTAKE = join(FIXTURES, 'client-intake');
export const EMAIL = join(FIXTURES, 'sample-email');
export const CRM = join(FIXTURES, 'sample-crm');


/** A domain with its own Customer (gstin, not tax_id) and manager (not approver). */
export const DOMAIN: Record<string, string | null> = {
  'domain/roles.yaml': 'roles:\n  staff: Staff\n  manager: Manager\n',
  'domain/entities/customer.yaml': `entity: Customer
fields:
  name:  PersonName
  email: Email
  gstin: Identifier(GSTIN)
  pan:   Identifier(PAN)
  credit_limit: Money
ownership:
  email: test/sample-crm
`,
  'workflows/demo/steps/review.md': '---\ntitle: Review\nperformer: person\nassignee: manager\noutcomes: [approved]\n---\nA person looks.\n',
};

export const INTAKE_BINDING = (hash: string, extra = ''): string => `plugin: test/client-intake
plugin_version: 1.0.0
plugin_hash: ${hash}
version: 1
frozen: { by: per_1, at: "2026-10-21T02:10:00Z", run: run_1 }
tools:
  gst.validate_gstin: { effect: read }
capabilities: { email_send: mail.send_message }
entities:
  Client: { entity: Customer, fields: { name: name, email: email, tax_id: gstin, pan: pan } }
roles: { staff: staff, approver: manager }
${extra}`;

export const EMAIL_BINDING = (hash: string): string => `plugin: test/sample-email
plugin_version: 1.0.0
plugin_hash: ${hash}
version: 1
frozen: { by: per_1, at: "2026-10-21T02:00:00Z" }
tools:
  mail.send_message: { effect: outbound }
`;

/** A project with both plugins installed and (unless `bind` is false) bound and frozen. */
export async function boundProject(opts: { bind?: boolean; changes?: Record<string, string | null>; intakeExtra?: string } = {}) {
  const root = makeProject({ ...DOMAIN, ...opts.changes });
  const intake = await installPlugin(root, INTAKE);
  const email = await installPlugin(root, EMAIL);
  const hashOf = async (dir: string) => (await loadPlugin(join(root, dir), root)).plugin!.hash;
  if (opts.bind !== false) {
    mkdirSync(join(root, 'domain/bindings'), { recursive: true });
    writeFileSync(join(root, bindingPath('test/client-intake')), INTAKE_BINDING(await hashOf(intake.dir), opts.intakeExtra));
    writeFileSync(join(root, bindingPath('test/sample-email')), EMAIL_BINDING(await hashOf(email.dir)));
  }
  return root;
}

/** Tools the kernel binds itself, for the checks. */
export const KERNEL_ENV: CheckEnvironment = {
  tools: {
    'lookup.customer': { effect: 'read' },
    'domain.customer.create': { effect: 'write', inputSchema: { type: 'object', properties: { name: {}, email: {}, gstin: {}, pan: {} }, required: ['name'], additionalProperties: false } },
    'domain.customer.get': { effect: 'read' },
  },
};

