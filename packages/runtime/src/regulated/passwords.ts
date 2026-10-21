// Passwords in a regulated workspace (24 §9): at least 12 characters, since a password is also
// a signature there. The kernel's people service with that rule on create and setPassword.
import type { PgPeopleStore } from '@memwise/db';
import type { ProjectDefs } from '@memwise/defs';

export const REGULATED_PASSWORD_MIN = 12;

/** Refuses a short password when any domain of the project is regulated. */
export function checkPasswordRule(project: ProjectDefs | undefined, password: string | undefined): void {
  if (password === undefined) return;
  const regulated = Object.values(project?.domains ?? {}).some((d) => d.regulated);
  if (regulated && password.length < REGULATED_PASSWORD_MIN) {
    throw new Error(`a password here must be at least ${REGULATED_PASSWORD_MIN} characters, because it is also used to sign`);
  }
}

export function withPasswordRule(people: PgPeopleStore, project: () => ProjectDefs | undefined): PgPeopleStore {
  return new Proxy(people, {
    get(target, key, receiver) {
      if (key === 'create') {
        return async (input: Parameters<PgPeopleStore['create']>[0]) => { checkPasswordRule(project(), input.password); return target.create(input); };
      }
      if (key === 'setPassword') {
        return async (personId: string, password: string) => { checkPasswordRule(project(), password); return target.setPassword(personId, password); };
      }
      const v = Reflect.get(target, key, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
