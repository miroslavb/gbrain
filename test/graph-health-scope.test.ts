import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { summarizeGraphHealthScope, type GraphHealthRow } from '../src/core/graph-health-scope.ts';
import { buildGraphScopeChecks } from '../src/commands/doctor/checks/graph-scope.ts';
import type { BrainHealth } from '../src/core/types.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const row = (slug: string, type: string, overrides: Partial<GraphHealthRow> = {}): GraphHealthRow => ({
  slug, type, link_count: 0, has_inbound: false, has_timeline: false,
  has_entity_link: false, has_resolvable_entity_hint: false, ...overrides,
});

describe('curated graph health scope', () => {
  test('keeps curated, session archive, and parent-session denominators disjoint', () => {
    const scope = summarizeGraphHealthScope([
      row('concepts/island', 'concept'),
      row('projects/linked', 'project', { link_count: 2, has_inbound: true, has_timeline: true }),
      row('website/concepts/generated', 'concept'),
      row('sessions/claude/parent', 'conversation', { link_count: 1, has_inbound: true, has_entity_link: true }),
      row('sessions/claude/parent/segments/0001', 'conversation-segment'),
      row('raw/archive-note', 'note'),
    ]);

    expect(scope).toEqual({
      typed_curated_pages: 3,
      curated_excluded_pages: 1,
      curated_pages: 2,
      curated_link_endpoints: 2,
      curated_islands: 1,
      curated_no_inbound: 1,
      curated_timeline_pages: 1,
      session_pages: 2,
      session_islands: 1,
      session_parents: 1,
      session_parents_entity_eligible: 1,
      session_parents_entity_hinted: 0,
      session_parents_entity_linked: 1,
    });
  });

  test('doctor reports archive isolation and parent-session entity coverage explicitly', () => {
    const graph_scope = summarizeGraphHealthScope([
      row('concepts/island', 'concept'),
      row('sessions/claude/linked', 'conversation', { link_count: 1, has_entity_link: true }),
      row('sessions/claude/unlinked', 'conversation', { has_resolvable_entity_hint: true }),
      row('sessions/claude/unresolved', 'conversation'),
    ]);
    const checks = buildGraphScopeChecks({ graph_scope } as BrainHealth);

    expect(checks.find((check) => check.name === 'curated_graph_health')?.status).toBe('warn');
    expect(checks.find((check) => check.name === 'session_archive_isolation')?.message)
      .toContain('excluded from brain-score graph denominators');
    expect(checks.find((check) => check.name === 'parent_session_entity_coverage')).toMatchObject({
      status: 'warn',
      message: 'Eligible parent-session curated links: 1/2 (50%); 3 raw parent session(s), 1 with independently resolvable project metadata.',
    });
  });

  test('engine counts a parent-session link to a project as a curated entity link', async () => {
    await engine.putPage('sessions/claude/parent', {
      type: 'conversation', title: 'session', compiled_truth: 'session', frontmatter: {},
    });
    await engine.putPage('projects/gbrain', {
      type: 'project', title: 'GBrain', compiled_truth: 'project', frontmatter: {},
    });
    await engine.addLink('sessions/claude/parent', 'projects/gbrain', '', 'mentions');

    const health = await engine.getHealth();
    expect(health.graph_scope?.session_parents_entity_linked).toBe(1);
  }, 60_000);

  test('engine resolves project metadata independently without counting unresolved hints', async () => {
    await engine.putPage('sessions/claude/hinted', {
      type: 'conversation', title: 'hinted', compiled_truth: 'session', frontmatter: { project: 'gbrain' },
    });
    await engine.putPage('sessions/claude/unresolved', {
      type: 'conversation', title: 'unresolved', compiled_truth: 'session', frontmatter: { project: 'root' },
    });
    await engine.putPage('projects/gbrain', {
      type: 'project', title: 'GBrain', compiled_truth: 'project', frontmatter: {},
    });

    const health = await engine.getHealth();
    expect(health.graph_scope?.session_parents).toBe(2);
    expect(health.graph_scope?.session_parents_entity_eligible).toBe(1);
    expect(health.graph_scope?.session_parents_entity_hinted).toBe(1);
    expect(health.graph_scope?.session_parents_entity_linked).toBe(0);
  }, 60_000);
});
