import { describe, it, expect } from '@jest/globals';
import { helpText } from '../../cli/help.js';

describe('help text', () => {
  const text = helpText();

  // Intentional drift guard: static-text smoke test pinning documented
  // flags/commands in the help output; not a behavioral test.
  it('mentions every command', () => {
    for (const token of ['biomcp doctor', '--version', '--help', '--json', '--client']) {
      expect(text).toContain(token);
    }
  });

  it('points at the install guide', () => {
    expect(text).toContain('docs/AGENT-INSTALL.md');
  });
});
