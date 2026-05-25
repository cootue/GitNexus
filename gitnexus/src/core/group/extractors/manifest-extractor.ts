import type { ContractType, CrossLink, GroupManifestLink, StoredContract } from '../types.js';
import type { CypherExecutor } from '../contract-extractor.js';

import { logger } from '../../logger.js';

export interface ManifestExtractResult {
  contracts: StoredContract[];
  crossLinks: CrossLink[];
}

function normalizeRoutePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '/';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const collapsed = withLeading.replace(/\/+/g, '/');
  if (collapsed === '/') return '/';
  return collapsed.replace(/\/+$/, '');
}

function parseHttpContract(raw: string): { method: string | null; path: string } {
  const match = raw.match(/^([A-Za-z]+)::/);
  if (!match) return { method: null, path: raw };
  return { method: match[1].toUpperCase(), path: raw.slice(match[0].length) };
}

export function manifestSymbolUid(repo: string, contractId: string): string {
  return `manifest::${repo}::${contractId}`;
}

export class ManifestExtractor {
  async extractFromManifest(
    links: GroupManifestLink[],
    dbExecutors?: Map<string, CypherExecutor>,
  ): Promise<ManifestExtractResult> {
    type ResolvedSymbol = { filePath: string; name: string; uid: string } | null;
    const resolveCache = new Map<string, Promise<ResolvedSymbol>>();
    const resolveOnce = (repo: string, link: GroupManifestLink): Promise<ResolvedSymbol> => {
      // Fix 14a: include extSymbol in cache key for extends/implements/override
      // links — multiple ext classes can implement the same base and each must
      // resolve to its own symbol node.
      // Fix 15d: include consumerFilePath for xml-ref links so the same base
      // type referenced from multiple XML files produces distinct consumer-side
      // entries.
      const key = `${repo}\u0000${link.type}\u0000${link.contract}\u0000${link.extSymbol || ''}\u0000${link.consumerFilePath || ''}\u0000${link.consumerModuleDir || ''}`;
      let pending = resolveCache.get(key);
      if (!pending) {
        pending = this.resolveSymbol(repo, link, dbExecutors);
        resolveCache.set(key, pending);
      }
      return pending;
    };

    // Batch processing instead of Promise.all — each link makes up to 2
    // concurrent resolveSymbol calls; firing all at once overwhelms the
    // DB pool on large manifests.
    const BATCH_SIZE = 8;
    const perLink: Array<{
      link: GroupManifestLink;
      contractId: string;
      providerRepo: string;
      consumerRepo: string;
      providerSymbol: ResolvedSymbol;
      consumerSymbol: ResolvedSymbol;
    }> = [];
    for (let i = 0; i < links.length; i += BATCH_SIZE) {
      const batch = links.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (link) => {
          const contractId = this.buildContractId(link.type, link.contract);
          const providerRepo = link.role === 'provider' ? link.from : link.to;
          const consumerRepo = link.role === 'provider' ? link.to : link.from;
          const [providerSymbol, consumerSymbol] = await Promise.all([
            resolveOnce(providerRepo, link),
            resolveOnce(consumerRepo, link),
          ]);
          return { link, contractId, providerRepo, consumerRepo, providerSymbol, consumerSymbol };
        }),
      );
      perLink.push(...batchResults);
    }

    // Use candidate naming — dedup may remove some entries.
    const contractCandidates: StoredContract[] = [];
    const crossLinkCandidates: Array<CrossLink & { _providerFilePath: string }> = [];

    // Helper: manifest:: UIDs indicate unresolved symbols (no graph match).
    // Their confidence is 0.5 (heuristic, not exact graph resolution).
    const isManifest = (uid: string): boolean => uid.startsWith('manifest::');

    for (const {
      link,
      contractId,
      providerRepo,
      consumerRepo,
      providerSymbol,
      consumerSymbol,
    } of perLink) {
      const providerRef = providerSymbol || { filePath: '', name: link.contract };
      // Fix 13/14b: For extends/implements/override links, the consumer
      // symbol name is the ext class (link.extSymbol), not the base class
      // (link.contract).
      // Fix 15d: For xml-ref links the consumer is a resource file,
      // not a graph symbol; use the file's basename as the symbol name.
      const consumerSymbolName =
        (link.type === 'extends' || link.type === 'implements' || link.type === 'override') &&
        link.extSymbol
          ? link.extSymbol
          : link.type === 'xml-ref' && link.consumerFilePath
            ? link.consumerFilePath.split(/[\\/]/).pop()!
            : link.contract;
      const consumerRef = consumerSymbol || {
        filePath: link.type === 'xml-ref' && link.consumerFilePath ? link.consumerFilePath : '',
        name: consumerSymbolName,
      };
      const providerUid = providerSymbol?.uid || manifestSymbolUid(providerRepo, contractId);
      const consumerUid = consumerSymbol?.uid || manifestSymbolUid(consumerRepo, contractId);

      contractCandidates.push({
        contractId,
        type: link.type,
        role: 'provider',
        symbolUid: providerUid,
        symbolRef: providerRef,
        symbolName: link.contract,
        confidence: isManifest(providerUid) ? 0.5 : 1.0,
        meta: { source: 'manifest' },
        repo: providerRepo,
      });

      contractCandidates.push({
        contractId,
        type: link.type,
        role: 'consumer',
        symbolUid: consumerUid,
        symbolRef: consumerRef,
        symbolName: consumerSymbolName,
        confidence: isManifest(consumerUid) ? 0.5 : 1.0,
        meta: { source: 'manifest' },
        repo: consumerRepo,
      });

      crossLinkCandidates.push({
        from: { repo: consumerRepo, symbolUid: consumerUid, symbolRef: consumerRef },
        to: {
          repo: providerRepo,
          symbolUid: providerUid,
          symbolRef: providerRef,
        },
        type: link.type,
        contractId,
        matchType: 'manifest',
        confidence: isManifest(providerUid) || isManifest(consumerUid) ? 0.5 : 1.0,
        _providerFilePath: providerRef.filePath,
      });
    }

    // Dedup over-approximate contracts and cross-links.
    // When multiple claimants map to the same package prefix, the same
    // symbol can produce contracts with different contractIds (e.g.
    // "mathlex::Expression" vs "calculator::Expression" for the same
    // graph node). Group provider contracts by (repo, type, symbolUid,
    // filePath) and keep the best contractId match. Then filter all
    // contracts by the surviving contractIds and dedup cross-links.
    function bestMatchScore(contractId: string, filePath: string): number {
      if (!filePath || filePath === '') return 0;
      // Prefer contractIds that contain the file's directory structure.
      const dirParts = filePath.split('/').slice(0, -1);
      let score = 0;
      for (const part of dirParts) {
        if (contractId.includes(part)) score++;
      }
      return score;
    }

    // Group provider contracts by (repo, type, symbolUid, filePath)
    const providerGroups = new Map<string, StoredContract[]>();
    for (const c of contractCandidates) {
      if (c.role !== 'provider') continue;
      const gk = `${c.repo}\0${c.type}\0${c.symbolUid}\0${c.symbolRef.filePath}`;
      const existing = providerGroups.get(gk);
      if (existing) existing.push(c);
      else providerGroups.set(gk, [c]);
    }

    const bestContractIds = new Set<string>();
    for (const [, group] of providerGroups) {
      if (group.length === 1) {
        bestContractIds.add(group[0].contractId);
        continue;
      }
      // Keep the contract with the best match score.
      let bestIdx = 0;
      let bestScore = bestMatchScore(group[0].contractId, group[0].symbolRef.filePath);
      for (let i = 1; i < group.length; i++) {
        const s = bestMatchScore(group[i].contractId, group[i].symbolRef.filePath);
        if (s > bestScore) {
          bestScore = s;
          bestIdx = i;
        }
      }
      bestContractIds.add(group[bestIdx].contractId);
    }

    // Also keep all consumer contracts (they don't have the over-approximation
    // issue — each consumer is unique per repo).
    for (const c of contractCandidates) {
      if (c.role === 'consumer') bestContractIds.add(c.contractId);
    }

    const contracts = contractCandidates.filter((c) => bestContractIds.has(c.contractId));

    // Dedup cross-links by (type, fromRepo, toRepo, providerFilePath, providerName, consumerName)
    // — keep the best match. Fix 13: type included so extends cross-links aren't deduped
    // against custom. Fix 14a: consumer symbol name included so multiple ext classes
    // implementing the same base each survive dedup.
    const clGroups = new Map<string, typeof crossLinkCandidates>();
    for (const cl of crossLinkCandidates) {
      const gk = `${cl.type}\0${cl.from.repo}\0${cl.to.repo}\0${cl._providerFilePath}\0${cl.to.symbolRef.name}\0${cl.from.symbolRef.name}`;
      const existing = clGroups.get(gk);
      if (existing) existing.push(cl);
      else clGroups.set(gk, [cl]);
    }

    const crossLinks: CrossLink[] = [];
    for (const [, group] of clGroups) {
      if (group.length === 1) {
        // Strip internal _providerFilePath before returning.
        const { _providerFilePath: _, ...cl } = group[0];
        crossLinks.push(cl);
        continue;
      }
      let bestIdx = 0;
      let bestScore = bestMatchScore(group[0].contractId, group[0]._providerFilePath);
      for (let i = 1; i < group.length; i++) {
        const s = bestMatchScore(group[i].contractId, group[i]._providerFilePath);
        if (s > bestScore) {
          bestScore = s;
          bestIdx = i;
        }
      }
      const { _providerFilePath: _, ...cl } = group[bestIdx];
      crossLinks.push(cl);
    }

    return { contracts, crossLinks };
  }

  private async resolveSymbol(
    repoPathKey: string,
    link: GroupManifestLink,
    dbExecutors?: Map<string, CypherExecutor>,
  ): Promise<{ filePath: string; name: string; uid: string } | null> {
    const executor = dbExecutors?.get(repoPathKey);
    if (!executor) return null;

    try {
      let rows: Record<string, unknown>[];
      if (link.type === 'http') {
        const parsed = parseHttpContract(link.contract);
        const normalized = normalizeRoutePath(parsed.path);
        rows = await executor(
          `MATCH (handler)-[r:CodeRelation {type: 'HANDLES_ROUTE'}]->(route:Route)
           WHERE route.name = $normalized
           RETURN handler.id AS uid, handler.name AS name, handler.filePath AS filePath
           ORDER BY handler.filePath ASC
           LIMIT 1`,
          { normalized },
        );
      } else if (link.type === 'topic') {
        rows = await executor(
          `MATCH (n:Function|Method|Class|Interface) WHERE n.name = $contract
           RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
           ORDER BY n.filePath ASC
           LIMIT 1`,
          { contract: link.contract },
        );
      } else if (link.type === 'grpc' || link.type === 'thrift') {
        const parts = link.contract.split('/');
        const rawServiceName = parts[0]?.trim() ?? '';
        const serviceName =
          link.type === 'thrift' ? (rawServiceName.split('.').pop() ?? '') : rawServiceName;
        const methodName = parts[1]?.trim() ?? '';
        if (methodName) {
          rows = await executor(
            `MATCH (n:Function|Method) WHERE n.name = $methodName
             RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
             ORDER BY n.filePath ASC
             LIMIT 1`,
            { methodName },
          );
        } else if (serviceName) {
          rows = await executor(
            `MATCH (n:Class|Interface) WHERE n.name = $serviceName
             RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
             ORDER BY n.filePath ASC
             LIMIT 1`,
            { serviceName },
          );
        } else {
          rows = [];
        }
      } else if (link.type === 'lib') {
        // Package label doesn't exist in LadybugDB for Java repos — use
        // Module|Folder instead, which typically matches Maven module directories.
        rows = await executor(
          `MATCH (n:Module|Folder) WHERE n.name = $contract
           RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
           ORDER BY n.filePath ASC
           LIMIT 1`,
          { contract: link.contract },
        );
      } else if (link.type === 'include') {
        rows = await executor(
          `MATCH (f:File) WHERE f.filePath = $contract
           RETURN f.id AS uid, f.name AS name, f.filePath AS filePath
           ORDER BY f.filePath ASC
           LIMIT 1`,
          { contract: link.contract },
        );
      } else if (link.type === 'custom') {
        // Split 20-label Cypher into two fallback queries. The original
        // single MATCH with all 20 labels can cause LadybugDB query planner
        // issues on large graphs. Primary covers the most common Java types;
        // fallback catches the rest.
        const symbolName = link.contract.includes('::')
          ? link.contract.split('::').pop()!
          : link.contract;
        rows = await executor(
          `MATCH (n:Class|Interface|Method|Function) WHERE n.name = $symbolName
           RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
           ORDER BY n.filePath ASC
           LIMIT 1`,
          { symbolName },
        );
        if (rows.length === 0) {
          rows = await executor(
            `MATCH (n:Enum|Struct|Trait|Constructor|CodeElement) WHERE n.name = $symbolName
             RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
             ORDER BY n.filePath ASC
             LIMIT 1`,
            { symbolName },
          );
        }
      } else if (
        link.type === 'extends' ||
        link.type === 'implements' ||
        link.type === 'override'
      ) {
        // Fix 13/14b/17: Cross-repo inheritance/implements/override link.
        // Provider side: resolve the BASE class (link.contract = "artifactId::BaseName")
        // Consumer side: resolve the EXT class (link.extSymbol = "ExtName")
        const isProvider = repoPathKey === link.from;
        const symbolName = isProvider
          ? link.contract.includes('::')
            ? link.contract.split('::').pop()!
            : link.contract
          : link.extSymbol ||
            (link.contract.includes('::') ? link.contract.split('::').pop()! : link.contract);
        rows = await executor(
          `MATCH (n:Class|Interface|Method|Function) WHERE n.name = $symbolName
           RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
           ORDER BY n.filePath ASC
           LIMIT 1`,
          { symbolName },
        );
        if (rows.length === 0) {
          rows = await executor(
            `MATCH (n:Enum|Struct|Trait|Constructor|CodeElement) WHERE n.name = $symbolName
             RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
             ORDER BY n.filePath ASC
             LIMIT 1`,
            { symbolName },
          );
        }
      } else if (link.type === 'xml-ref') {
        // Fix 15d: xml-ref consumer side is a resource file (not a graph
        // symbol) — return null for consumer. Provider side resolves the
        // Java class.
        const isProvider = repoPathKey === link.from;
        if (!isProvider) return null;
        const symbolName = link.contract.includes('::')
          ? link.contract.split('::').pop()!
          : link.contract;
        rows = await executor(
          `MATCH (n:Class|Interface|Method|Function) WHERE n.name = $symbolName
           RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
           ORDER BY n.filePath ASC
           LIMIT 1`,
          { symbolName },
        );
        if (rows.length === 0) {
          rows = await executor(
            `MATCH (n:Enum|Struct|Trait|Constructor|CodeElement) WHERE n.name = $symbolName
             RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
             ORDER BY n.filePath ASC
             LIMIT 1`,
            { symbolName },
          );
        }
      } else {
        return null;
      }
      if (rows.length > 0) {
        return {
          filePath: rows[0].filePath as string,
          name: rows[0].name as string,
          uid: String(rows[0].uid ?? ''),
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[manifest-extractor] resolveSymbol failed for ${link.type}:${link.contract} ` +
          `in ${repoPathKey}: ${message}`,
      );
    }
    return null;
  }

  private buildContractId(type: ContractType, contract: string): string {
    switch (type) {
      case 'http': {
        const { method, path: rawPath } = parseHttpContract(contract);
        const normalizedPath = normalizeRoutePath(rawPath);
        return method ? `http::${method}::${normalizedPath}` : `http::*::${normalizedPath}`;
      }
      case 'grpc':
        return `grpc::${contract}`;
      case 'thrift':
        return `thrift::${contract}`;
      case 'topic':
        return `topic::${contract}`;
      case 'lib':
        return `lib::${contract}`;
      case 'custom':
        return `custom::${contract}`;
      case 'extends':
        return `extends::${contract}`;
      case 'implements':
        return `implements::${contract}`;
      case 'override':
        return `override::${contract}`;
      case 'xml-ref':
        return `xml-ref::${contract}`;
      case 'include':
        return `include::${contract}`;
      default: {
        const _exhaustive: never = type;
        throw new Error(`Unhandled ContractType: ${String(_exhaustive)}`);
      }
    }
  }
}
