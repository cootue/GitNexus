import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { initLbug, closeLbug, executeParameterized } from '../lbug/pool-adapter.js';
import { readRegistry, type RegistryEntry } from '../../storage/repo-manager.js';
import type { GroupConfig, RepoHandle, RepoSnapshot, StoredContract, CrossLink } from './types.js';
import { HttpRouteExtractor } from './extractors/http-route-extractor.js';
import { GrpcExtractor } from './extractors/grpc-extractor.js';
import { ThriftExtractor } from './extractors/thrift-extractor.js';
import { TopicExtractor } from './extractors/topic-extractor.js';
import { IncludeExtractor } from './extractors/include-extractor.js';
import { ManifestExtractor } from './extractors/manifest-extractor.js';
import { discoverWorkspaceLinks } from './extractors/workspace-extractor.js';
import { buildProviderIndex, runExactMatch, runWildcardMatch } from './matching.js';
import { detectServiceBoundaries, assignService } from './service-boundary-detector.js';
import type { CypherExecutor } from './contract-extractor.js';
import { writeContractRegistry } from './storage.js';
import { writeBridge } from './bridge-db.js';
import type { ContractRegistry } from './types.js';

import { logger } from '../logger.js';
export interface SyncOptions {
  extractorOverride?:
    | ((repo: RepoHandle) => Promise<StoredContract[]>)
    | (() => Promise<StoredContract[]>);
  resolveRepoHandle?: (registryName: string, groupPath: string) => Promise<RepoHandle | null>;
  skipWrite?: boolean;
  groupDir?: string;
  allowStale?: boolean;
  verbose?: boolean;
  exactOnly?: boolean;
  skipEmbeddings?: boolean;
}

export interface SyncResult {
  contracts: StoredContract[];
  crossLinks: CrossLink[];
  unmatched: StoredContract[];
  missingRepos: string[];
  repoSnapshots: Record<string, RepoSnapshot>;
}

export function stableRepoPoolId(entry: RegistryEntry, allEntries: RegistryEntry[]): string {
  const base = entry.name.toLowerCase();
  const resolved = path.resolve(entry.path);
  for (const other of allEntries) {
    if (other.name.toLowerCase() === base && path.resolve(other.path) !== resolved) {
      const hash = Buffer.from(entry.path).toString('base64url').slice(0, 6);
      return `${base}-${hash}`;
    }
  }
  return base;
}

function defaultResolveHandle(allEntries: RegistryEntry[]) {
  return async (registryName: string, groupPath: string): Promise<RepoHandle | null> => {
    const e = allEntries.find((en) => en.name === registryName);
    if (!e) return null;
    const poolId = stableRepoPoolId(e, allEntries);
    return {
      id: poolId,
      path: groupPath,
      repoPath: e.path,
      storagePath: e.storagePath,
    };
  };
}

/**
 * Dedupe cross-links that point from the same consumer endpoint to the same
 * provider endpoint for the same contract. Preserves first-seen order so the
 * caller controls precedence (e.g., pass manifest links first).
 */
function dedupeCrossLinks(links: CrossLink[]): CrossLink[] {
  const seen = new Set<string>();
  const out: CrossLink[] = [];
  for (const link of links) {
    const key = `${link.from.repo}::${link.from.symbolUid}|${link.to.repo}::${link.to.symbolUid}|${link.type}|${link.contractId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

// Fix 16B: eliminate multi-claimant FP where multiple contractIds for the
// same symbol resolve to the same target file (wrong-artifact FP) or to
// N/A (local-class FP). Runs after dedupeCrossLinks.
function dedupeMultiClaimantCrossLinks(links: CrossLink[]): CrossLink[] {
  const byKey = new Map<string, CrossLink[]>();
  for (const link of links) {
    const parts = link.contractId.split('::');
    const type = parts[0];
    const symbol = parts.slice(2).join('::');
    // Fix: include consumer symbol name for extends/implements/override
    // so that different ext classes inheriting the same base each produce
    // their own cross-link. For other types (custom, xml-ref, etc.) the
    // consumer symbol name is the claimant artifact key (e.g.
    // "clm-api::LoginResponse") which varies per claimant — including it
    // would prevent multi-claimant dedup, causing a 4x explosion in
    // cross-links.
    const isExtendsLike = type === 'extends' || type === 'implements' || type === 'override';
    const consumerSymName = isExtendsLike ? link.from?.symbolRef?.name || '' : '';
    const gk = `${type}\0${symbol}\0${link.from?.repo || ''}\0${consumerSymName}`;
    if (!byKey.has(gk)) byKey.set(gk, []);
    byKey.get(gk)!.push(link);
  }
  const out: CrossLink[] = [];
  let dropped = 0;
  for (const [, group] of byKey) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const resolved = group.filter((l) => l.to?.symbolRef?.filePath);
    if (resolved.length === 0) {
      // All N/A — likely local-class FP; keep first only
      out.push(group[0]);
      dropped += group.length - 1;
      continue;
    }
    const uniqueFiles = [...new Set(resolved.map((l) => l.to.symbolRef.filePath))];
    if (uniqueFiles.length === 1) {
      // Same target — prefer the link whose artifact appears in the file path
      const fp = uniqueFiles[0];
      const best =
        resolved.find((l) => {
          const art = l.contractId.split('::')[1];
          return fp.includes('/' + art + '/') || fp.includes('\\' + art + '\\');
        }) ?? resolved[0];
      out.push(best);
      dropped += group.length - 1;
    } else {
      // Different targets — genuine multi-target, keep all
      out.push(...group);
    }
  }
  if (dropped > 0) logger.info(`[group/sync] deduplicated ${dropped} multi-claimant cross-links`);
  return out;
}

export async function syncGroup(config: GroupConfig, opts?: SyncOptions): Promise<SyncResult> {
  const missingRepos: string[] = [];
  const repoSnapshots: Record<string, RepoSnapshot> = {};
  let autoContracts: StoredContract[] = [];
  let manifestCrossLinks: CrossLink[] = [];
  let dbExecutors: Map<string, CypherExecutor> | undefined;
  let registryEntries: RegistryEntry[] | undefined;

  const eo = opts?.extractorOverride;
  if (eo && eo.length === 0) {
    autoContracts = await (eo as () => Promise<StoredContract[]>)();
  } else {
    registryEntries = await readRegistry();
    const entries = registryEntries;
    const resolve = opts?.resolveRepoHandle ?? defaultResolveHandle(entries);
    const httpEx = new HttpRouteExtractor();
    const grpcEx = new GrpcExtractor();
    const thriftEx = new ThriftExtractor();
    const topicEx = new TopicExtractor();
    const includeEx = new IncludeExtractor();
    dbExecutors = new Map<string, CypherExecutor>();
    const openPoolIds: string[] = [];

    try {
      for (const [groupPath, regName] of Object.entries(config.repos)) {
        const handle = await resolve(regName, groupPath);
        if (!handle) {
          missingRepos.push(groupPath);
          continue;
        }

        const poolId = handle.id;
        const lbugPath = path.join(handle.storagePath, 'lbug');
        try {
          await initLbug(poolId, lbugPath);
          openPoolIds.push(poolId);

          const executor: CypherExecutor = (query, params) =>
            executeParameterized(poolId, query, params ?? {});

          dbExecutors.set(groupPath, executor);

          const boundaries = await detectServiceBoundaries(handle.repoPath);

          if (config.detect.http) {
            const extracted = await httpEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          if (config.detect.grpc) {
            const extracted = await grpcEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          if (config.detect.thrift) {
            const extracted = await thriftEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          if (config.detect.topics) {
            const extracted = await topicEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          if (config.detect.includes) {
            const extracted = await includeEx.extract(executor, handle.repoPath, handle);
            for (const c of extracted) {
              autoContracts.push({
                ...c,
                repo: groupPath,
                service: assignService(c.symbolRef.filePath, boundaries),
              });
            }
          }

          const metaPath = path.join(handle.storagePath, 'meta.json');
          try {
            const raw = await fs.readFile(metaPath, 'utf-8');
            const m = JSON.parse(raw) as { indexedAt?: string; lastCommit?: string };
            repoSnapshots[groupPath] = {
              indexedAt: m.indexedAt || '',
              lastCommit: m.lastCommit || '',
            };
          } catch {
            const e = entries.find((en) => en.name === regName);
            repoSnapshots[groupPath] = {
              indexedAt: e?.indexedAt || '',
              lastCommit: e?.lastCommit || '',
            };
          }
        } catch {
          missingRepos.push(groupPath);
        }
      }
      // Auto-discover workspace dependency contracts (Rust Cargo workspaces, etc.)
      // and merge them with explicit manifest links. Discovered links use the same
      // ManifestExtractor pipeline as hand-written links in group.yaml.
      // MUST run inside the try block — while DB pools are still open — so that
      // resolveSymbol can query the graph instead of falling back to synthetic UIDs.
      let allLinks = [...config.links];

      if (config.detect.workspace_deps) {
        const repoPaths = new Map<string, string>();
        if (!registryEntries) registryEntries = await readRegistry();
        for (const [groupPath, regName] of Object.entries(config.repos)) {
          const e = registryEntries.find((en) => en.name === regName);
          if (e) repoPaths.set(groupPath, e.path);
        }

        const wsResult = await discoverWorkspaceLinks(
          config.repos,
          repoPaths,
          dbExecutors,
          config.matching,
        );
        if (wsResult.links.length > 0) {
          allLinks = [...allLinks, ...wsResult.links];
          if (opts?.verbose) {
            for (const s of wsResult.stats) {
              logger.info(
                `  workspace-deps: discovered ${s.linkCount} cross-${s.ecosystem.toLowerCase()} links from ${s.projectCount} ${s.ecosystem} projects`,
              );
            }
          }
        }
      }

      // Process manifest links declared in group.yaml (plus any auto-discovered).
      // Running inside the try block ensures dbExecutors are live, so resolveSymbol
      // can resolve to real graph symbols. Falls back to synthetic UIDs only when a
      // specific repo's pool failed to open (missingRepos).
      if (allLinks.length > 0) {
        const knownRepos = new Set(Object.keys(config.repos));
        for (const link of allLinks) {
          const dangling = [link.from, link.to].filter((r) => !knownRepos.has(r));
          if (dangling.length > 0) {
            logger.warn(
              `[group/sync] manifest link ${link.type}:${link.contract} references repos not in config.repos: ${dangling.join(', ')} — cross-links will use synthetic UIDs`,
            );
          }
        }

        const manifestEx = new ManifestExtractor();
        const manifestResult = await manifestEx.extractFromManifest(allLinks, dbExecutors);
        autoContracts.push(...manifestResult.contracts);
        manifestCrossLinks = manifestResult.crossLinks;
        if (opts?.verbose) {
          logger.info(
            `  manifest: ${manifestCrossLinks.length} cross-links from ${allLinks.length} links (${config.links.length} declared + ${allLinks.length - config.links.length} discovered)`,
          );
        }
      }
    } finally {
      for (const id of [...new Set(openPoolIds)]) {
        await closeLbug(id).catch(() => {});
      }
    }
  }

  const providerIndex = buildProviderIndex(autoContracts, config.matching);
  const { matched, unmatched } = runExactMatch(autoContracts, providerIndex, config.matching);
  const wildcard = runWildcardMatch(unmatched, providerIndex);

  // Dedupe cross-links. Manifest contracts participate in runExactMatch, so a
  // manifest-declared link can also emit a matchType:'exact' CrossLink with the
  // same endpoints. Prefer the manifest version — it reflects operator intent
  // and carries matchType:'manifest' which downstream consumers may rely on.
  const crossLinks = dedupeMultiClaimantCrossLinks(
    dedupeCrossLinks([...manifestCrossLinks, ...matched, ...wildcard.matched]),
  );

  // Consumer contract dedup (fix for Commit 6's incorrect "each consumer
  // is unique per repo" assumption). After Commit 5's multi-claimant
  // emission, the same symbol in the same repo can have multiple consumer
  // contracts with different claimant artifact keys. Group by
  // (repo, type, bareSymbolName, filePath) and keep the best matchScore,
  // but unconditionally preserve contracts referenced by surviving cross-links.
  // This MUST run after the final cross-link dedup so we know which
  // cross-links actually survive the full pipeline.
  // NOTE: We match by contractId (not symbolUid) because multi-claimant
  // consumers in the same dedup group share the same symbolUid — a uid-based
  // check would preserve ALL of them, defeating the dedup.
  const crossLinkContractIds = new Set<string>();
  for (const cl of crossLinks) {
    crossLinkContractIds.add(cl.contractId);
  }
  function bestMatchScore(contractId: string, filePath: string): number {
    if (!filePath || filePath === '') return 0;
    const dirParts = filePath.split('/').slice(0, -1);
    let score = 0;
    for (const part of dirParts) {
      if (contractId.includes(part)) score++;
    }
    return score;
  }
  const consumerGroups = new Map<string, StoredContract[]>();
  for (const c of autoContracts) {
    if (c.role !== 'consumer') continue;
    const bareSymbol = c.contractId.split('::').pop() ?? c.contractId;
    const gk = `${c.repo}\0${c.type}\0${bareSymbol}\0${c.symbolRef.filePath}`;
    const existing = consumerGroups.get(gk);
    if (existing) existing.push(c);
    else consumerGroups.set(gk, [c]);
  }
  const survivingConsumerIds = new Set<string>();
  for (const [, group] of consumerGroups) {
    if (group.length <= 1) {
      survivingConsumerIds.add(group[0].contractId);
      continue;
    }
    // Keep contracts referenced by surviving cross-links (by contractId)
    let groupHasCrossLinkRef = false;
    for (const c of group) {
      if (crossLinkContractIds.has(c.contractId)) {
        survivingConsumerIds.add(c.contractId);
        groupHasCrossLinkRef = true;
      }
    }
    // If no contract in this group is referenced by cross-links, keep the best match score
    if (!groupHasCrossLinkRef) {
      let bestIdx = 0;
      let bestScore = bestMatchScore(group[0].contractId, group[0].symbolRef.filePath);
      for (let i = 1; i < group.length; i++) {
        const s = bestMatchScore(group[i].contractId, group[i].symbolRef.filePath);
        if (s > bestScore) {
          bestScore = s;
          bestIdx = i;
        }
      }
      survivingConsumerIds.add(group[bestIdx].contractId);
    }
  }
  // Provider contract dedup (same root cause as consumer — multi-claimant
  // over-approximation from JW's pkgClaimants). Group by
  // (repo, type, bareSymbolName, filePath) using bareSymbolName (not
  // symbolUid) because 24% of providers are unresolved (manifest:: UID)
  // and their symbolUid varies per claimant, defeating symbolUid-based
  // grouping. For resolved providers, both keys produce identical groups.
  const providerGroups = new Map<string, StoredContract[]>();
  for (const c of autoContracts) {
    if (c.role !== 'provider') continue;
    const bareSymbol = c.contractId.split('::').pop() ?? c.contractId;
    const gk = `${c.repo}\0${c.type}\0${bareSymbol}\0${c.symbolRef.filePath}`;
    const existing = providerGroups.get(gk);
    if (existing) existing.push(c);
    else providerGroups.set(gk, [c]);
  }
  const survivingProviderIds = new Set<string>();
  for (const [, group] of providerGroups) {
    if (group.length <= 1) {
      survivingProviderIds.add(group[0].contractId);
      continue;
    }
    // Keep providers referenced by surviving cross-links (by contractId)
    let groupHasCrossLinkRef = false;
    for (const c of group) {
      if (crossLinkContractIds.has(c.contractId)) {
        survivingProviderIds.add(c.contractId);
        groupHasCrossLinkRef = true;
      }
    }
    // If no provider in this group is referenced by cross-links, keep the best match score
    if (!groupHasCrossLinkRef) {
      let bestIdx = 0;
      let bestScore = bestMatchScore(group[0].contractId, group[0].symbolRef.filePath);
      for (let i = 1; i < group.length; i++) {
        const s = bestMatchScore(group[i].contractId, group[i].symbolRef.filePath);
        if (s > bestScore) {
          bestScore = s;
          bestIdx = i;
        }
      }
      survivingProviderIds.add(group[bestIdx].contractId);
    }
  }

  const dedupedContracts = autoContracts.filter(
    (c) =>
      (c.role === 'consumer' && survivingConsumerIds.has(c.contractId)) ||
      (c.role === 'provider' && survivingProviderIds.has(c.contractId)),
  );
  const consumerRemoved =
    autoContracts.filter((c) => c.role === 'consumer').length -
    dedupedContracts.filter((c) => c.role === 'consumer').length;
  const providerRemoved =
    autoContracts.filter((c) => c.role === 'provider').length -
    dedupedContracts.filter((c) => c.role === 'provider').length;
  if (consumerRemoved > 0) {
    logger.info(
      `[group/sync] consumer contract dedup: removed ${consumerRemoved} multi-claimant consumers`,
    );
  }
  if (providerRemoved > 0) {
    logger.info(
      `[group/sync] provider contract dedup: removed ${providerRemoved} multi-claimant providers`,
    );
  }

  const allContracts: StoredContract[] = dedupedContracts;

  const registry: ContractRegistry = {
    version: 1,
    generatedAt: new Date().toISOString(),
    repoSnapshots,
    missingRepos,
    contracts: allContracts,
    crossLinks,
  };

  if (opts?.groupDir && !opts.skipWrite) {
    await writeContractRegistry(opts.groupDir, registry);
    // writeBridge failure (disk full, schema error, permission denied) must
    // not mask the registry — contracts.json was just written successfully
    // and is the canonical source of truth. A stale or absent bridge
    // degrades impact queries to empty results, which is recoverable on
    // the next sync. Surface the failure as a warning so operators can
    // act, but do not propagate it.
    // (PR #1156 follow-up review: writeBridge error in sync.ts propagates
    // uncaught.)
    try {
      await writeBridge(opts.groupDir, {
        contracts: allContracts,
        crossLinks,
        repoSnapshots,
        missingRepos,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err: msg, groupDir: opts.groupDir },
        '⚠️ writeBridge failed; contracts.json is intact but bridge.lbug is stale. Re-run `gitnexus group sync` to retry.',
      );
    }
  }

  return {
    contracts: allContracts,
    crossLinks,
    unmatched: wildcard.remaining,
    missingRepos,
    repoSnapshots,
  };
}
