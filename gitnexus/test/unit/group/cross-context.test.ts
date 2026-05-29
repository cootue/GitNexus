import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BRIDGE_SCHEMA_VERSION } from '../../../src/core/group/bridge-schema.js';

// Mock the bridge DB layer so traversal logic is unit-tested cross-platform.
// (Real bridge.lbug reopen is skipped on Windows due to a LadybugDB file-lock
// regression — see bridge-db.test.ts `itLbugReopen`.) `ensureBridgeReady`
// (in bridge-neighbors.ts) and `runGroupContextCrossLinks` both consume these.
const { mockQueryBridge, mockReadBridgeMeta, mockOpenRO, mockClose } = vi.hoisted(() => ({
  mockQueryBridge: vi.fn(),
  mockReadBridgeMeta: vi.fn(),
  mockOpenRO: vi.fn(),
  mockClose: vi.fn(),
}));

vi.mock('../../../src/core/group/bridge-db.js', () => ({
  queryBridge: mockQueryBridge,
  closeBridgeDb: mockClose,
  readBridgeMeta: mockReadBridgeMeta,
  openBridgeDbReadOnly: mockOpenRO,
}));

import {
  runGroupContextCrossLinks,
  MAX_CONTEXT_NEIGHBORS,
} from '../../../src/core/group/cross-context.js';
import type { GroupToolPort } from '../../../src/core/group/service.js';
import type { GroupConfig } from '../../../src/core/group/types.js';

const UP = 'provider.repo = $localRepo';

function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    neighborRepo: 'ext',
    neighborUid: 'Class:ext/Consumer.java:Consumer',
    neighborFilePath: 'ext/Consumer.java',
    matchType: 'exact',
    confidence: 1.0,
    contractId: 'custom::lib::Consumer',
    contractType: 'custom',
    ...over,
  };
}

function makeConfig(): GroupConfig {
  return {
    version: 1,
    name: 'g1',
    description: '',
    repos: { common: 'common-reg', ext: 'ext-reg' },
    links: [],
    packages: {},
    detect: {
      http: true,
      grpc: true,
      topics: true,
      shared_libs: true,
      embedding_fallback: true,
    } as GroupConfig['detect'],
    matching: {
      bm25_threshold: 0.7,
      embedding_threshold: 0.65,
      max_candidates_per_step: 3,
    } as GroupConfig['matching'],
  };
}

/** Fake port: context resolves any uid not starting with `manifest::`. */
function makePort(over: Partial<GroupToolPort> = {}): GroupToolPort {
  return {
    resolveRepo: vi.fn(async (reg?: string) => ({
      id: String(reg),
      name: String(reg),
      repoPath: '/r',
      storagePath: '/r/.gitnexus',
    })),
    impact: vi.fn(),
    query: vi.fn(),
    impactByUid: vi.fn(),
    context: vi.fn(async (_repo: unknown, params: { uid?: string }) => {
      const uid = params.uid ?? '';
      if (uid.startsWith('manifest::')) return { status: 'not_found' };
      return {
        status: 'found',
        symbol: { uid, name: 'Consumer', kind: 'Class', filePath: 'ext/Consumer.java' },
        incoming: {},
        outgoing: {},
        processes: [
          { name: 'P1', id: 'p1' },
          { name: 'P2', id: 'p2' },
        ],
      };
    }),
    ...over,
  } as GroupToolPort;
}

describe('cross-context', () => {
  let tmpDir: string;
  let groupDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xctx-'));
    groupDir = path.join(tmpDir, 'groups', 'g1');
    fs.mkdirSync(groupDir, { recursive: true });
    mockReadBridgeMeta.mockResolvedValue({
      version: BRIDGE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      missingRepos: [],
    });
    mockOpenRO.mockResolvedValue({ _db: {}, _conn: {}, groupDir });
    mockClose.mockResolvedValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create the bridge.lbug file so ensureBridgeReady's fsp.access passes. */
  function touchBridge(): void {
    fs.writeFileSync(path.join(groupDir, 'bridge.lbug'), '');
  }

  /** Route upstream rows to the upstream cypher, [] to downstream. */
  function upstreamOnly(rows: Record<string, unknown>[]): void {
    mockQueryBridge.mockImplementation(async (_h: unknown, cypher: string) =>
      cypher.includes(UP) ? rows : [],
    );
  }

  it('test_no_anchors_short_circuits_without_touching_bridge', async () => {
    const r = await runGroupContextCrossLinks(
      { port: makePort(), config: makeConfig(), groupDir },
      [{ repoPath: 'common', uids: [] }],
      { minConfidence: 0 },
    );
    expect(r).toEqual({ cross: [], truncated: false });
    expect(mockReadBridgeMeta).not.toHaveBeenCalled();
  });

  it('test_resolved_traversal_maps_symbol_and_processes', async () => {
    touchBridge();
    upstreamOnly([makeRow()]);
    const r = await runGroupContextCrossLinks(
      { port: makePort(), config: makeConfig(), groupDir },
      [{ repoPath: 'common', uids: ['Provider'] }],
      { minConfidence: 0 },
    );
    expect(r.cross).toHaveLength(1);
    const c = r.cross[0];
    expect(c.direction).toBe('upstream');
    expect(c.resolved).toBe(true);
    expect(c.repo).toBe('ext-reg');
    expect(c.repo_path).toBe('ext');
    expect(c.symbol?.uid).toBe('Class:ext/Consumer.java:Consumer');
    expect(c.processes).toEqual(['P1', 'P2']); // G1: names extracted from objects
    expect(c.contract.confidence).toBe(1.0);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('test_manifest_uid_is_dead_end_resolved_false', async () => {
    touchBridge();
    upstreamOnly([
      makeRow({ neighborUid: 'manifest::ext::custom::lib::Consumer', confidence: 0.5 }),
    ]);
    const r = await runGroupContextCrossLinks(
      { port: makePort(), config: makeConfig(), groupDir },
      [{ repoPath: 'common', uids: ['Provider'] }],
      { minConfidence: 0 },
    );
    expect(r.cross).toHaveLength(1);
    expect(r.cross[0].resolved).toBe(false);
    expect(r.cross[0].symbol).toBeNull();
    expect(r.cross[0].processes).toEqual([]);
  });

  it('test_minConfidence_filters_low_confidence_links', async () => {
    touchBridge();
    upstreamOnly([
      makeRow({ neighborUid: 'Class:ext/A.java:A', contractId: 'c-a', confidence: 0.5 }),
      makeRow({ neighborUid: 'Class:ext/B.java:B', contractId: 'c-b', confidence: 0.9 }),
    ]);
    const r = await runGroupContextCrossLinks(
      { port: makePort(), config: makeConfig(), groupDir },
      [{ repoPath: 'common', uids: ['Provider'] }],
      { minConfidence: 0.6 },
    );
    expect(r.cross).toHaveLength(1);
    expect(r.cross[0].symbol?.uid).toBe('Class:ext/B.java:B');
  });

  it('test_service_prefix_scopes_neighbors', async () => {
    touchBridge();
    upstreamOnly([makeRow({ neighborFilePath: 'ext/other/Consumer.java' })]);
    const r = await runGroupContextCrossLinks(
      { port: makePort(), config: makeConfig(), groupDir },
      [{ repoPath: 'common', uids: ['Provider'] }],
      { minConfidence: 0, servicePrefix: 'ext/keep' },
    );
    expect(r.cross).toHaveLength(0);
  });

  it('test_G3_subgroupExact_does_not_prune_cross_repo_neighbors', async () => {
    touchBridge();
    upstreamOnly([makeRow()]); // neighbor in 'ext'
    const r = await runGroupContextCrossLinks(
      { port: makePort(), config: makeConfig(), groupDir },
      [{ repoPath: 'common', uids: ['Provider'] }],
      { minConfidence: 0, subgroup: 'common', subgroupExact: true },
    );
    // subgroup 'common' would exclude 'ext', but a single targeted member
    // must still reach cross-repo neighbors → not pruned.
    expect(r.cross).toHaveLength(1);
    expect(r.cross[0].repo_path).toBe('ext');
  });

  it('test_subgroup_prunes_neighbors_when_not_exact', async () => {
    touchBridge();
    upstreamOnly([makeRow()]); // neighbor in 'ext'
    const r = await runGroupContextCrossLinks(
      { port: makePort(), config: makeConfig(), groupDir },
      [{ repoPath: 'common', uids: ['Provider'] }],
      { minConfidence: 0, subgroup: 'common', subgroupExact: false },
    );
    expect(r.cross).toHaveLength(0);
  });

  it('test_caps_at_MAX_CONTEXT_NEIGHBORS_and_flags_truncated', async () => {
    touchBridge();
    const rows = Array.from({ length: MAX_CONTEXT_NEIGHBORS + 5 }, (_, i) =>
      makeRow({ neighborUid: `Class:ext/C${i}.java:C${i}`, contractId: `c-${i}` }),
    );
    upstreamOnly(rows);
    const r = await runGroupContextCrossLinks(
      { port: makePort(), config: makeConfig(), groupDir },
      [{ repoPath: 'common', uids: ['Provider'] }],
      { minConfidence: 0 },
    );
    expect(r.cross).toHaveLength(MAX_CONTEXT_NEIGHBORS);
    expect(r.truncated).toBe(true);
  });

  it('test_bridge_absent_soft_degradation', async () => {
    // No touchBridge() → ensureBridgeReady's fsp.access fails → error path.
    upstreamOnly([makeRow()]);
    const r = await runGroupContextCrossLinks(
      { port: makePort(), config: makeConfig(), groupDir },
      [{ repoPath: 'common', uids: ['Provider'] }],
      { minConfidence: 0 },
    );
    expect(r).toEqual({ cross: [], truncated: false });
    expect(mockQueryBridge).not.toHaveBeenCalled();
  });
});
