import { describe, expect, it } from 'bun:test';
import { getPlainToolLabel } from '../toolNames.ts';

describe('getPlainToolLabel', () => {
  it('labels the playbook session tools under either prefix', () => {
    expect(getPlainToolLabel('mcp__session__playbook_finish')).toBe('Send the draft for review');
    expect(getPlainToolLabel('session__playbook_write')).toBe('Edit the draft');
    expect(getPlainToolLabel('playbook_check')).toBe('Check the draft');
  });

  it('leaves other tools, and source tools of the same name, unlabelled', () => {
    expect(getPlainToolLabel('mcp__session__spawn_session')).toBeUndefined();
    expect(getPlainToolLabel('mcp__linear__playbook_finish')).toBeUndefined();
    expect(getPlainToolLabel('Bash')).toBeUndefined();
    expect(getPlainToolLabel('mcp__session__toString')).toBeUndefined();
  });
});
