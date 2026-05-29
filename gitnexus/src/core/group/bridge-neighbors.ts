/**
 * Shared Contract-Bridge neighbor plumbing.
 *
 * Extracted from `cross-impact.ts` so both the cross-repo `impact()` walk
 * and the cross-repo `context()` traversal reuse one copy of the bridge
 * Cypher, the row mapper, and the read-only open/version guard.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BridgeHandle } from './types.js';
import { openBridgeDbReadOnly, readBridgeMeta } from './bridge-db.js';
import { BRIDGE_SCHEMA_VERSION } from './bridge-schema.js';

export const CY_NEIGHBORS_UPSTREAM = `
MATCH (consumer:Contract)-[l:ContractLink]->(provider:Contract)
WHERE provider.repo = $localRepo
  AND provider.symbolUid IN $uids
  AND provider.role = 'provider'
RETURN consumer.repo AS neighborRepo,
       consumer.symbolUid AS neighborUid,
       consumer.filePath AS neighborFilePath,
       l.matchType AS matchType,
       l.confidence AS confidence,
       l.contractId AS contractId,
       consumer.type AS contractType
`;

export const CY_NEIGHBORS_DOWNSTREAM = `
MATCH (consumer:Contract)-[l:ContractLink]->(provider:Contract)
WHERE consumer.repo = $localRepo
  AND consumer.symbolUid IN $uids
  AND consumer.role = 'consumer'
RETURN provider.repo AS neighborRepo,
       provider.symbolUid AS neighborUid,
       provider.filePath AS neighborFilePath,
       l.matchType AS matchType,
       l.confidence AS confidence,
       l.contractId AS contractId,
       provider.type AS contractType
`;

export type BridgeNeighborRow = {
  neighborRepo: string;
  neighborUid: string;
  neighborFilePath?: string;
  matchType: string;
  confidence: number;
  contractId: string;
  contractType: string;
};

export function rowToNeighbor(r: Record<string, unknown>): BridgeNeighborRow | null {
  const neighborRepo = String(r.neighborRepo ?? r[0] ?? '');
  const neighborUid = String(r.neighborUid ?? r[1] ?? '');
  if (!neighborRepo || !neighborUid) return null;
  return {
    neighborRepo,
    neighborUid,
    neighborFilePath:
      r.neighborFilePath !== undefined ? String(r.neighborFilePath) : String(r[2] ?? ''),
    matchType: String(r.matchType ?? r[3] ?? 'exact'),
    confidence: Number(r.confidence ?? r[4] ?? 0),
    contractId: String(r.contractId ?? r[5] ?? ''),
    contractType: String(r.contractType ?? r[6] ?? 'custom'),
  };
}

export async function ensureBridgeReady(
  groupDir: string,
): Promise<{ handle: BridgeHandle } | { error: string }> {
  const meta = await readBridgeMeta(groupDir);
  if (meta.version > 0 && meta.version !== BRIDGE_SCHEMA_VERSION) {
    return {
      error: `Bridge schema version mismatch (meta.json has ${meta.version}, expected ${BRIDGE_SCHEMA_VERSION}). Run gitnexus group sync for this group.`,
    };
  }
  const dbPath = path.join(groupDir, 'bridge.lbug');
  try {
    await fsp.access(dbPath);
  } catch {
    return {
      error: `No bridge.lbug in this group directory. Run gitnexus group sync (schema ${BRIDGE_SCHEMA_VERSION}).`,
    };
  }
  const handle = await openBridgeDbReadOnly(groupDir);
  if (!handle) {
    return {
      error: `Could not open bridge.lbug read-only (schema ${BRIDGE_SCHEMA_VERSION}). Run gitnexus group sync.`,
    };
  }
  return { handle };
}
