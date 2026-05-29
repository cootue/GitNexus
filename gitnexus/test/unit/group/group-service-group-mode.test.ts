/**
 * Documents MCP → GroupService mapping: callers use `name` + concrete params;
 * the "@group" string is interpreted only in LocalBackend.callTool (Issue #794).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BRIDGE_SCHEMA_VERSION } from '../../../src/core/group/bridge-schema.js';

// Mock the bridge DB layer so group-mode context() cross-link traversal is
// exercised cross-platform (real bridge.lbug reopen is skipped on Windows).
// service.ts loads cross-context.js dynamically; that module + bridge-neighbors
// are the only consumers of these four bridge-db exports.
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
  GroupService,
  type GroupToolPort,
  type GroupRepoHandle,
} from '../../../src/core/group/service.js';

function makeTmpGroup(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = path.join(os.tmpdir(), `gitnexus-gmode-${Date.now()}`);
  const groupDir = path.join(tmpDir, 'groups', 'test-group');
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(
    path.join(groupDir, 'group.yaml'),
    `version: 1
name: test-group
repos:
  app/backend: test-backend
  app/frontend: test-frontend
`,
  );
  return { tmpDir, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

function makePort(overrides: Partial<GroupToolPort> = {}): GroupToolPort {
  return {
    resolveRepo: vi.fn(
      async (name?: string): Promise<GroupRepoHandle> => ({
        id: name || 'test',
        name: name || 'test',
        repoPath: '/tmp/repo',
        storagePath: '/tmp/repo/.gitnexus',
      }),
    ),
    impact: vi.fn(async () => ({ target: {}, byDepth: {} })),
    query: vi.fn(async () => ({
      processes: [{ id: 'p1', heuristicLabel: 'Proc' }],
      process_symbols: [
        { id: 's1', process_id: 'p1', filePath: 'services/auth/a.ts' },
        { id: 's2', process_id: 'p1', filePath: 'other/b.ts' },
      ],
    })),
    impactByUid: vi.fn(async () => null),
    context: vi.fn(async () => ({
      status: 'found',
      symbol: { filePath: 'services/auth/x.ts', uid: 'u1', name: 'X' },
    })),
    ...overrides,
  };
}

describe('GroupService group-mode API surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Defaults: a healthy bridge handle. Tests without a bridge.lbug file on
    // disk still soft-degrade (ensureBridgeReady's fsp.access fails first).
    mockReadBridgeMeta.mockResolvedValue({
      version: BRIDGE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      missingRepos: [],
    });
    mockOpenRO.mockResolvedValue({ _db: {}, _conn: {}, groupDir: '/tmp' });
    mockClose.mockResolvedValue(undefined);
    mockQueryBridge.mockResolvedValue([]);
  });

  it('groupContext returns cross[] for resolved cross-repo neighbors', async () => {
    const { tmpDir, cleanup } = makeTmpGroup();
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    try {
      // Bridge file must exist for ensureBridgeReady's fsp.access to pass.
      fs.writeFileSync(path.join(tmpDir, 'groups', 'test-group', 'bridge.lbug'), '');
      mockQueryBridge.mockImplementation(async (_h: unknown, cypher: string) =>
        cypher.includes('provider.repo = $localRepo')
          ? [
              {
                neighborRepo: 'app/frontend',
                neighborUid: 'Class:fe/Consumer.ts:Consumer',
                neighborFilePath: 'fe/Consumer.ts',
                matchType: 'exact',
                confidence: 0.9,
                contractId: 'custom::lib::Consumer',
                contractType: 'custom',
              },
            ]
          : [],
      );
      // Echo the queried uid so the neighbor's resolved symbol is distinguishable.
      const context = vi.fn(async (_repo: unknown, params: { uid?: string }) => ({
        status: 'found',
        symbol: { uid: params.uid ?? 'u1', name: 'Consumer', filePath: 'fe/Consumer.ts' },
      }));
      const svc = new GroupService(makePort({ context }));
      const r = await svc.groupContext({ name: 'test-group', target: 'MySym' });
      expect(r.results).toHaveLength(2);
      expect(r.cross).toBeDefined();
      expect(r.cross).toHaveLength(1);
      expect(r.cross?.[0].direction).toBe('upstream');
      expect(r.cross?.[0].resolved).toBe(true);
      expect(r.cross?.[0].repo_path).toBe('app/frontend');
      expect(r.cross?.[0].symbol?.uid).toBe('Class:fe/Consumer.ts:Consumer');
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it('groupContext omits cross[] when cross_links is false', async () => {
    const { tmpDir, cleanup } = makeTmpGroup();
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    try {
      fs.writeFileSync(path.join(tmpDir, 'groups', 'test-group', 'bridge.lbug'), '');
      const svc = new GroupService(makePort());
      const r = await svc.groupContext({ name: 'test-group', target: 'MySym', cross_links: false });
      expect(r.results).toHaveLength(2);
      expect(r.cross).toBeUndefined();
      expect(mockQueryBridge).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it('groupContext soft-degrades (no cross[]) when bridge is absent', async () => {
    const { tmpDir, cleanup } = makeTmpGroup();
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    try {
      // No bridge.lbug written → ensureBridgeReady fails → cross omitted.
      const svc = new GroupService(makePort());
      const r = await svc.groupContext({ name: 'test-group', target: 'MySym' });
      expect(r.results).toHaveLength(2);
      expect(r.cross).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it('groupQuery uses name (never @-repo) and optional service filters processes', async () => {
    const { tmpDir, cleanup } = makeTmpGroup();
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    try {
      const query = vi.fn(async () => ({
        processes: [{ id: 'p1' }],
        process_symbols: [
          { id: 's1', process_id: 'p1', filePath: 'services/auth/a.ts' },
          { id: 's2', process_id: 'p1', filePath: 'other/b.ts' },
        ],
      }));
      const svc = new GroupService(makePort({ query }));
      const r = (await svc.groupQuery({
        name: 'test-group',
        query: 'oauth',
        service: 'services/auth',
      })) as { results: Array<{ id?: string }> };
      expect(query).toHaveBeenCalled();
      expect(r.results.every((row) => row.id === 'p1')).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it('groupQuery rejects empty service string', async () => {
    const { tmpDir, cleanup } = makeTmpGroup();
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    try {
      const svc = new GroupService(makePort());
      const r = await svc.groupQuery({ name: 'test-group', query: 'x', service: '  ' });
      expect(r).toEqual({ error: 'service must not be an empty string' });
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it('groupContext uses name + target (MCP maps @group to name)', async () => {
    const { tmpDir, cleanup } = makeTmpGroup();
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    try {
      const svc = new GroupService(makePort());
      const r = await svc.groupContext({ name: 'test-group', target: 'MySym' });
      expect(r.group).toBe('test-group');
      expect(r.results).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });

  it('groupImpact with mock port returns structured result without @ in params', async () => {
    const { tmpDir, cleanup } = makeTmpGroup();
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    try {
      const svc = new GroupService(makePort());
      const r = (await svc.groupImpact({
        name: 'test-group',
        repo: 'app/backend',
        target: 't',
        direction: 'upstream',
      })) as { group?: string; error?: string };
      expect(r.error).toBeUndefined();
      expect(r.group).toBe('test-group');
    } finally {
      vi.unstubAllEnvs();
      cleanup();
    }
  });
});
