/**
 * Cross-repo `context()` traversal. Mirrors the Phase-2 fan-out of
 * `cross-impact.ts`, but anchored on a single resolved symbol and calling
 * `port.context` (not an impact walk) on each neighbor.
 *
 * Shared bridge plumbing (Cypher, row mapper, open guard) lives in
 * `bridge-neighbors.ts`.
 */

import type { ContractType, CrossRepoContext, GroupConfig, MatchType } from './types.js';
import type { GroupRepoHandle, GroupToolPort } from './service.js';
import { fileMatchesServicePrefix, repoInSubgroup } from './group-path-utils.js';
import { closeBridgeDb, queryBridge } from './bridge-db.js';
import {
  CY_NEIGHBORS_DOWNSTREAM,
  CY_NEIGHBORS_UPSTREAM,
  ensureBridgeReady,
  rowToNeighbor,
  type BridgeNeighborRow,
} from './bridge-neighbors.js';

/** Hard cap on neighbors materialized into `cross[]` after confidence-sort. */
export const MAX_CONTEXT_NEIGHBORS = 25;

/**
 * Per-neighbor wall-clock budget for the `port.context` lookup. `context()`
 * exposes no `AbortSignal` (unlike `impactByUid`), so this only bounds how
 * long we *await* — the underlying call may still run to completion in the
 * background (gotcha G2). A timed-out neighbor still surfaces as a visible
 * connection with `resolved:false`.
 */
export const NEIGHBOR_CONTEXT_TIMEOUT_MS = 5_000;

export interface RunGroupContextCrossDeps {
  port: GroupToolPort;
  config: GroupConfig;
  groupDir: string;
}

export interface GroupContextAnchor {
  repoPath: string;
  uids: string[];
}

export interface RunGroupContextCrossOpts {
  minConfidence: number;
  servicePrefix?: string;
  subgroup?: string;
  /**
   * When the caller targeted a single member (`@group/member`), the subgroup
   * constrains where the *anchor* is resolved — NOT where its cross-links may
   * land. Subgroup-filtering the neighbor side in that case would discard
   * exactly the cross-repo neighbors the traversal exists to surface
   * (gotcha G3), so neighbor subgroup-filtering is skipped when this is true.
   */
  subgroupExact?: boolean;
}

/** Extract process names from a neighbor `context` payload (gotcha G1). */
function contextProcessNames(payload: unknown): string[] {
  const procs = (payload as { processes?: Array<{ name?: string }> } | null)?.processes;
  if (!Array.isArray(procs)) return [];
  return procs.map((p) => String(p?.name ?? '')).filter(Boolean);
}

/**
 * Race a single `port.context` lookup against a per-neighbor timeout. No
 * `AbortSignal` is available on `context`, so a timeout abandons the await
 * (the call may finish in the background) and yields `null` — mirroring the
 * `fan == null` dead-end contract in `cross-impact.ts` (gotcha G2).
 */
async function safeNeighborContext(
  port: GroupToolPort,
  repo: GroupRepoHandle,
  uid: string,
  timeoutMs: number,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const callP = port.context(repo, { uid }).catch(() => null);
  const timeoutP = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs));
  });
  const won = await Promise.race([callP, timeoutP]);
  if (timer !== undefined) clearTimeout(timer);
  return won;
}

export async function runGroupContextCrossLinks(
  deps: RunGroupContextCrossDeps,
  anchors: GroupContextAnchor[],
  opts: RunGroupContextCrossOpts,
): Promise<{ cross: CrossRepoContext[]; truncated: boolean }> {
  const { port, config, groupDir } = deps;
  const { minConfidence, servicePrefix, subgroup, subgroupExact } = opts;

  const anchorsWithUids = anchors.filter((a) => a.uids.length > 0);
  if (anchorsWithUids.length === 0) return { cross: [], truncated: false };

  const bridgePrep = await ensureBridgeReady(groupDir);
  if ('error' in bridgePrep) return { cross: [], truncated: false };
  const handle = bridgePrep.handle;

  const cross: CrossRepoContext[] = [];
  let truncated = false;

  try {
    type Candidate = { neighbor: BridgeNeighborRow; direction: 'upstream' | 'downstream' };
    const candidates: Candidate[] = [];

    for (const anchor of anchorsWithUids) {
      for (const direction of ['upstream', 'downstream'] as const) {
        const cypher = direction === 'upstream' ? CY_NEIGHBORS_UPSTREAM : CY_NEIGHBORS_DOWNSTREAM;
        const rows = await queryBridge<Record<string, unknown>>(handle, cypher, {
          localRepo: anchor.repoPath,
          uids: anchor.uids,
        });
        for (const raw of rows) {
          const n = rowToNeighbor(raw);
          if (n) candidates.push({ neighbor: n, direction });
        }
      }
    }

    candidates.sort((a, b) => b.neighbor.confidence - a.neighbor.confidence);

    const seen = new Set<string>();
    const selected: Candidate[] = [];
    for (const c of candidates) {
      const n = c.neighbor;
      if (n.confidence < minConfidence) continue;
      if (servicePrefix && !fileMatchesServicePrefix(n.neighborFilePath, servicePrefix)) continue;
      // G3: only subgroup-filter neighbors when NOT targeting a single member.
      if (!subgroupExact && !repoInSubgroup(n.neighborRepo, subgroup)) continue;

      const key = `${n.neighborRepo}\0${n.neighborUid}\0${n.contractId}\0${c.direction}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (selected.length >= MAX_CONTEXT_NEIGHBORS) {
        truncated = true;
        break;
      }
      selected.push(c);
    }

    for (const c of selected) {
      const n = c.neighbor;
      const regName = config.repos[n.neighborRepo];
      if (!regName) continue;

      let payload: unknown = null;
      try {
        const repoObj = await port.resolveRepo(regName);
        payload = await safeNeighborContext(
          port,
          repoObj,
          n.neighborUid,
          NEIGHBOR_CONTEXT_TIMEOUT_MS,
        );
      } catch {
        payload = null;
      }

      const found =
        payload !== null &&
        typeof payload === 'object' &&
        (payload as { status?: string }).status === 'found';
      const sym = found
        ? ((payload as { symbol?: CrossRepoContext['symbol'] }).symbol ?? null)
        : null;

      cross.push({
        repo: regName,
        repo_path: n.neighborRepo,
        direction: c.direction,
        contract: {
          id: n.contractId,
          type: n.contractType as ContractType,
          match_type: (n.matchType as MatchType) || 'exact',
          confidence: n.confidence,
        },
        resolved: found,
        symbol: sym,
        processes: found ? contextProcessNames(payload) : [],
      });
    }
  } finally {
    await closeBridgeDb(handle);
  }

  return { cross, truncated };
}
