import fs from 'node:fs/promises';
import path from 'node:path';
import type { CypherExecutor } from '../contract-extractor.js';
import type { GroupManifestLink, ContractRole } from '../types.js';
import { shouldIgnorePath, loadIgnoreRules } from '../../../config/ignore-service.js';

import { logger } from '../../logger.js';

interface JavaProjectMeta {
  groupId: string;
  artifactId: string;
  groupPath: string;
  repoPath: string;
  deps: string[];
  moduleDir?: string;
}

interface ImportedSymbol {
  artifactKey: string;
  symbolName: string;
  filePath: string;
}

interface InheritanceOrOverrideSymbol {
  artifactKey: string;
  baseSymbolName: string;
  extSymbolName: string;
  filePath: string;
  relType: 'extends' | 'implements' | 'override';
}

interface PomResult {
  groupId: string;
  artifactId: string;
  deps: string[];
  modules: string[];
}

async function parseJavaManifest(
  repoPath: string,
): Promise<(PomResult & { pomPath: string }) | null> {
  const pomSearchPaths = [
    path.join(repoPath, 'pom.xml'),
    path.join(repoPath, 'Applications', 'pom.xml'),
  ];
  for (const pomPath of pomSearchPaths) {
    try {
      const content = await fs.readFile(pomPath, 'utf-8');
      const result = parsePom(content);
      if (result) return { ...result, pomPath };
    } catch {
      continue;
    }
  }
  for (const name of ['build.gradle.kts', 'build.gradle']) {
    const gradlePath = path.join(repoPath, name);
    try {
      const content = await fs.readFile(gradlePath, 'utf-8');
      return parseGradle(content, repoPath);
    } catch {
      continue;
    }
  }
  return null;
}

function parsePom(content: string): PomResult | null {
  // Strip nested XML blocks that contain their own <groupId>/<artifactId>
  // (parent, dependencies, build, etc.) before matching at project level.
  // Module POMs often omit <groupId> (inheriting from parent) so we need
  // a careful fallback chain.
  const projectLevel = content
    .replace(/<parent>[\s\S]*?<\/parent>/g, '')
    .replace(/<dependencies>[\s\S]*?<\/dependencies>/g, '')
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '')
    .replace(/<build>[\s\S]*?<\/build>/g, '')
    .replace(/<modules>[\s\S]*?<\/modules>/g, '')
    .replace(/<profiles>[\s\S]*?<\/profiles>/g, '')
    .replace(/<repositories>[\s\S]*?<\/repositories>/g, '')
    .replace(/<pluginRepositories>[\s\S]*?<\/pluginRepositories>/g, '')
    .replace(/<reporting>[\s\S]*?<\/reporting>/g, '')
    .replace(/<properties>[\s\S]*?<\/properties>/g, '')
    .replace(/<scm>[\s\S]*?<\/scm>/g, '')
    .replace(/<organization>[\s\S]*?<\/organization>/g, '')
    .replace(/<developers>[\s\S]*?<\/developers>/g, '')
    .replace(/<contributors>[\s\S]*?<\/contributors>/g, '')
    .replace(/<licenses>[\s\S]*?<\/licenses>/g, '')
    .replace(/<distributionManagement>[\s\S]*?<\/distributionManagement>/g, '')
    .replace(/<issueManagement>[\s\S]*?<\/issueManagement>/g, '')
    .replace(/<ciManagement>[\s\S]*?<\/ciManagement>/g, '')
    .replace(/<mailingLists>[\s\S]*?<\/mailingLists>/g, '');

  const projectGroupMatch = projectLevel.match(/<groupId>([^<]+)<\/groupId>/);
  const projectArtifactMatch = projectLevel.match(/<artifactId>([^<]+)<\/artifactId>/);
  if (!projectArtifactMatch) return null;

  const artifactId = projectArtifactMatch[1].trim();
  let groupId = projectGroupMatch ? projectGroupMatch[1].trim() : null;

  // Fall back: module POMs inherit groupId from <parent>
  if (!groupId) {
    const parentGroupMatch = content.match(/<parent>[\s\S]*?<groupId>([^<]+)<\/groupId>/);
    groupId = parentGroupMatch ? parentGroupMatch[1].trim() : null;
  }
  if (!groupId) return null;

  // Extract deps from the FULL content (including dependencyManagement).
  const deps: string[] = [];
  const depBlocks = content.matchAll(/<dependency>\s*([\s\S]*?)<\/dependency>/g);
  for (const block of depBlocks) {
    const gMatch = block[1].match(/<groupId>([^<]+)<\/groupId>/);
    const aMatch = block[1].match(/<artifactId>([^<]+)<\/artifactId>/);
    if (gMatch && aMatch) {
      deps.push(`${gMatch[1].trim()}:${aMatch[1].trim()}`);
    }
  }

  // Extract modules from the FULL content.
  const modules: string[] = [];
  const moduleMatches = content.matchAll(/<module>([^<]+)<\/module>/g);
  for (const m of moduleMatches) {
    modules.push(m[1].trim());
  }

  return { groupId, artifactId, deps: [...new Set(deps)], modules };
}

function parseGradle(content: string, repoPath: string): (PomResult & { pomPath: string }) | null {
  const groupMatch = content.match(/group\s*=\s*['"]([^'"]+)['"]/);
  const dirName = path.basename(repoPath);
  const groupId = groupMatch ? groupMatch[1] : '';
  if (!groupId) return null;

  const artifactId = dirName;

  const deps: string[] = [];
  const depMatches = content.matchAll(
    /(?:implementation|api|compileOnly|runtimeOnly)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  );
  for (const m of depMatches) {
    const parts = m[1].split(':');
    if (parts.length >= 2) {
      deps.push(`${parts[0]}:${parts[1]}`);
    }
  }

  const projDeps = content.matchAll(
    /(?:implementation|api)\s*\(\s*project\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g,
  );
  for (const m of projDeps) {
    const subName = m[1].replace(/^:/, '');
    deps.push(`${groupId}:${subName}`);
  }

  return { groupId, artifactId, deps: [...new Set(deps)], modules: [], pomPath: '' };
}

// Scan actual Java package declarations from source files instead of using
// the broken deriveBasePackage heuristic. Returns full package names plus
// intermediate prefixes down to 3 segments. Full package names + sortedPkgs
// (longest-first) ensure the most-specific prefix matches first; 3-segment
// prefixes serve as fallback for transitive deps. Multi-claimant FP on short
// prefixes is handled by dedupeMultiClaimantCrossLinks in sync.js.
async function discoverActualPackages(
  repoPath: string,
  maxFiles = 5000,
  excludeDirs: string[] = [],
): Promise<Set<string>> {
  const packages = new Set<string>();
  const ig = await loadIgnoreRules(repoPath);
  let fileCount = 0;

  async function walk(dir: string, rel: string): Promise<void> {
    if (fileCount >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (fileCount >= maxFiles) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (shouldIgnorePath(childRel)) continue;
        if (ig && ig.ignores(childRel + '/')) continue;
        if (entry.name === 'target' || entry.name === 'node_modules' || entry.name === '.git')
          continue;
        // Exclude sub-module directories so aggregator modules don't claim
        // packages from their children.
        if (excludeDirs.some((d) => path.join(dir, entry.name) === d)) continue;
        await walk(path.join(dir, entry.name), childRel);
      } else if (entry.name.endsWith('.java') || entry.name.endsWith('.kt')) {
        if (shouldIgnorePath(childRel)) continue;
        if (ig && ig.ignores(childRel)) continue;
        const absPath = path.join(dir, entry.name);
        try {
          const content = await fs.readFile(absPath, 'utf-8');
          const pkgMatch = content.match(/^package\s+([a-zA-Z][\w.]*)/m);
          if (pkgMatch) packages.add(pkgMatch[1].trim());
          fileCount++;
        } catch {
          /* skip */
        }
      }
    }
  }

  await walk(repoPath, '');

  const allPackages = new Set<string>();
  for (const pkg of packages) {
    allPackages.add(pkg);
    const parts = pkg.split('.');
    for (let i = parts.length - 1; i >= 3; i--) {
      allPackages.add(parts.slice(0, i).join('.'));
    }
  }
  return allPackages;
}

async function scanJavaImports(
  repoPath: string,
  knownPackages: Map<string, Set<string>>,
): Promise<ImportedSymbol[]> {
  const results: ImportedSymbol[] = [];
  const sourceFiles = await findJavaFiles(repoPath);

  // Sort knownPackages by key length descending so the most-specific
  // (longest) package prefix is checked first.
  const sortedPkgs = [...knownPackages.entries()].sort((a, b) => b[0].length - a[0].length);

  for (const relFile of sourceFiles) {
    const absPath = path.join(repoPath, relFile);
    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf-8');
    } catch {
      continue;
    }

    const importRegex = /^import\s+(?:static\s+)?([a-zA-Z][\w.]*\.[A-Z]\w*)/gm;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const fullImport = match[1];
      // Multi-map: when multiple modules claim the same package prefix,
      // emit a result for EACH claimant. No break after first prefix match —
      // allows fallthrough when most-specific prefix has only intra-repo
      // claimants. Dedup via emitted Set prevents duplicate entries.
      const emitted = new Set<string>();
      for (const [basePkg, claimants] of sortedPkgs) {
        if (fullImport.startsWith(basePkg + '.') || fullImport === basePkg) {
          const parts = fullImport.split('.');
          const className = parts[parts.length - 1];
          if (isPascalCase(className)) {
            for (const artifactKey of claimants) {
              const dedup = `${basePkg}::${artifactKey}`;
              if (emitted.has(dedup)) continue;
              emitted.add(dedup);
              results.push({
                artifactKey,
                symbolName: className,
                filePath: relFile,
              });
            }
          }
        }
      }
    }
  }

  return results;
}

// Cross-repo inheritance detection: parse extends/implements from Java
// class/interface/enum declarations. When a base class/interface belongs
// to a different artifact (dependency), emit a cross-repo inheritance link.
// Uses importMap for FQN resolution; Commit 8 adds resolveTypeName with
// same-package fallback, FQN passthrough, and local/JDK guards.
async function scanJavaInheritance(
  repoPath: string,
  knownPackages: Map<string, Set<string>>,
): Promise<InheritanceOrOverrideSymbol[]> {
  const results: InheritanceOrOverrideSymbol[] = [];
  const sourceFiles = await findJavaFiles(repoPath);
  const sortedPkgs = [...knownPackages.entries()].sort((a, b) => b[0].length - a[0].length);

  for (const relFile of sourceFiles) {
    const absPath = path.join(repoPath, relFile);
    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf-8');
    } catch {
      continue;
    }

    // Build import table: short name → FQN
    const importMap = new Map<string, string>();
    const importRegex = /^import\s+(?:static\s+)?([a-zA-Z][\w.]*\.[A-Z]\w*)/gm;
    let imMatch: RegExpExecArray | null;
    while ((imMatch = importRegex.exec(content)) !== null) {
      const fqn = imMatch[1];
      const parts = fqn.split('.');
      const shortName = parts[parts.length - 1];
      importMap.set(shortName, fqn);
    }

    // Basic type resolution: importMap lookup + FQN passthrough.
    // Commit 8 will add same-package fallback, local/JDK guards, inner-type.
    const resolveTypeName = (name: string): string | null => {
      if (name.includes('.')) {
        // If first segment starts with uppercase → inner-type notation
        // (not handled here, Commit 8). True FQN: passthrough.
        if (/^[a-z]/.test(name)) return name;
        return null; // inner-type — skip for now
      }
      return importMap.get(name) ?? null;
    };

    // Parse class/interface/enum extends (single base).
    // Commit 8 adds ifaceExtendsRegex for multi-base interface extends.
    const declRegex =
      /^(?:public\s+|protected\s+|private\s+)?(?:abstract\s+)?(?:static\s+)?(?:final\s+)?(?:class|interface|enum)\s+([A-Z]\w*)(?:<[^{]*>)?\s+extends\s+([\w.]+)(?:<[^{]*>)?/gm;
    let declMatch: RegExpExecArray | null;
    while ((declMatch = declRegex.exec(content)) !== null) {
      const extClassName = declMatch[1];
      const baseRaw = declMatch[2];
      let baseShortName: string;
      if (baseRaw.includes('.') && /^[A-Z]/.test(baseRaw.split('.')[0])) {
        baseShortName = baseRaw.split('.')[0]; // inner-type: outer class
      } else if (baseRaw.includes('.')) {
        baseShortName = baseRaw.split('.').pop()!; // FQN: last segment
      } else {
        baseShortName = baseRaw;
      }
      if (!/^[A-Z]\w*$/.test(baseShortName)) continue;
      const baseFqn = resolveTypeName(baseRaw);
      if (!baseFqn) continue;

      const emitted = new Set<string>();
      for (const [basePkg, claimants] of sortedPkgs) {
        if (baseFqn.startsWith(basePkg + '.') || baseFqn === basePkg) {
          for (const ak of claimants) {
            const dk = `${basePkg}::${ak}`;
            if (emitted.has(dk)) continue;
            emitted.add(dk);
            results.push({
              artifactKey: ak,
              baseSymbolName: baseShortName,
              extSymbolName: extClassName,
              filePath: relFile,
              relType: 'extends',
            });
          }
        }
      }
    }

    // Parse implements clause (comma-separated).
    // class X extends Y implements A, B<T>, C
    // enum X implements A, B<T>, C
    const implRegex =
      /^(?:public\s+|protected\s+)?(?:abstract\s+)?(?:static\s+)?(?:final\s+)?(?:class|enum)\s+[A-Z]\w*(?:<[^{]*>)?(?:\s+extends\s+[\w.]+(?:<[^{]*>)?)?\s+implements\s+([\w.]+(?:<[^{]*>)?(?:\s*,\s*[\w.]+(?:<[^{]*>)?)*)/gm;
    let implMatch: RegExpExecArray | null;
    while ((implMatch = implRegex.exec(content)) !== null) {
      const implList = implMatch[1];
      // Strip generics before splitting on comma to avoid
      // breaking on type-arg commas (e.g. Foo<A, B>, Qux).
      let implCleaned = implList;
      while (/<[^<>]*>/.test(implCleaned)) implCleaned = implCleaned.replace(/<[^<>]*>/g, '');
      const implNames = implCleaned
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^[\w.]+$/.test(s) && /^[A-Z]\w*$/.test(s.split('.').pop()!));
      const extMatch = content.slice(implMatch.index).match(/(?:class|enum)\s+([A-Z]\w*)/);
      if (!extMatch) continue;
      const extClassName = extMatch[1];

      for (const implRaw of implNames) {
        let implShortName: string;
        if (implRaw.includes('.') && /^[A-Z]/.test(implRaw.split('.')[0])) {
          implShortName = implRaw.split('.')[0]; // inner-type: outer class
        } else if (implRaw.includes('.')) {
          implShortName = implRaw.split('.').pop()!; // FQN: last segment
        } else {
          implShortName = implRaw;
        }
        const implFqn = resolveTypeName(implRaw);
        if (!implFqn) continue;

        const emitted = new Set<string>();
        for (const [basePkg, claimants] of sortedPkgs) {
          if (implFqn.startsWith(basePkg + '.') || implFqn === basePkg) {
            for (const ak of claimants) {
              const dk = `${basePkg}::${ak}`;
              if (emitted.has(dk)) continue;
              emitted.add(dk);
              results.push({
                artifactKey: ak,
                baseSymbolName: implShortName,
                extSymbolName: extClassName,
                filePath: relFile,
                relType: 'implements',
              });
            }
          }
        }
      }
    }
  }
  return results;
}

// Detect non-inheritance factory override patterns.
// *Factory.override*(Base.class, Ext.class) links factories where
// ExtFactory extends AbstractRequestFactory, not BaseFactory — the
// override call IS the cross-repo dependency link.
// Fix 15a: Generic regex (not hardcoded TransactionFactory).
async function scanJavaOverride(
  repoPath: string,
  knownPackages: Map<string, Set<string>>,
): Promise<InheritanceOrOverrideSymbol[]> {
  const results: InheritanceOrOverrideSymbol[] = [];
  const sourceFiles = await findJavaFiles(repoPath);
  const sortedPkgs = [...knownPackages.entries()].sort((a, b) => b[0].length - a[0].length);

  for (const relFile of sourceFiles) {
    const absPath = path.join(repoPath, relFile);
    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf-8');
    } catch {
      continue;
    }

    // Build import table: short name → FQN
    const importMap = new Map<string, string>();
    const importRegex = /^import\s+(?:static\s+)?([a-zA-Z][\w.]*\.[A-Z]\w*)/gm;
    let imMatch: RegExpExecArray | null;
    while ((imMatch = importRegex.exec(content)) !== null) {
      const fqn = imMatch[1];
      const parts = fqn.split('.');
      const shortName = parts[parts.length - 1];
      importMap.set(shortName, fqn);
    }

    const resolveTypeName = (name: string): string | null => {
      if (name.includes('.')) {
        if (/^[a-z]/.test(name)) return name;
        return null;
      }
      return importMap.get(name) ?? null;
    };

    // Generic override pattern: SomeFactory.overrideSomething(Base.class, Ext.class)
    const overrideRegex =
      /([A-Z]\w*Factory)\s*\.\s*(override\w+)\s*\(\s*([A-Z]\w*)\.class\s*,\s*([A-Z]\w*)\.class\s*\)/g;
    let overrideMatch: RegExpExecArray | null;
    while ((overrideMatch = overrideRegex.exec(content)) !== null) {
      const baseShortName = overrideMatch[3];
      const extShortName = overrideMatch[4];
      const baseFqn = resolveTypeName(baseShortName);
      if (!baseFqn) continue;

      const emitted = new Set<string>();
      for (const [basePkg, claimants] of sortedPkgs) {
        if (baseFqn.startsWith(basePkg + '.') || baseFqn === basePkg) {
          for (const ak of claimants) {
            const dk = `${basePkg}::${ak}`;
            if (emitted.has(dk)) continue;
            emitted.add(dk);
            results.push({
              artifactKey: ak,
              baseSymbolName: baseShortName,
              extSymbolName: extShortName,
              filePath: relFile,
              relType: 'override',
            });
          }
        }
      }
    }
  }
  return results;
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

async function findJavaFiles(repoPath: string): Promise<string[]> {
  const results: string[] = [];
  const ig = await loadIgnoreRules(repoPath);

  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (shouldIgnorePath(childRel)) continue;
        if (ig && ig.ignores(childRel + '/')) continue;
        await walk(path.join(dir, entry.name), childRel);
      } else if (entry.name.endsWith('.java') || entry.name.endsWith('.kt')) {
        if (shouldIgnorePath(childRel)) continue;
        if (ig && ig.ignores(childRel)) continue;
        results.push(childRel);
      }
    }
  }

  await walk(repoPath, '');
  return results;
}

export interface JavaWorkspaceResult {
  links: GroupManifestLink[];
  discoveredProjects: Map<string, JavaProjectMeta>;
}

export async function extractJavaWorkspaceLinks(
  repos: Record<string, string>,
  repoPaths: Map<string, string>,
  _dbExecutors?: Map<string, CypherExecutor>,
): Promise<JavaWorkspaceResult> {
  const projectsByKey = new Map<string, JavaProjectMeta>();
  const projectsByGroupPath = new Map<string, JavaProjectMeta>();
  const moduleDirToKey = new Map<string, string>();

  for (const [groupPath] of Object.entries(repos)) {
    const repoPath = repoPaths.get(groupPath);
    if (!repoPath) continue;

    const manifest = await parseJavaManifest(repoPath);
    if (!manifest) continue;

    const key = `${manifest.groupId}:${manifest.artifactId}`;
    const meta: JavaProjectMeta = {
      groupId: manifest.groupId,
      artifactId: manifest.artifactId,
      groupPath,
      repoPath,
      deps: manifest.deps,
    };
    const existing = projectsByKey.get(key);
    if (existing) {
      logger.warn(
        `[java-workspace-extractor] duplicate artifact "${key}" in "${groupPath}" and "${existing.groupPath}" — skipping "${groupPath}"`,
      );
      continue;
    }
    projectsByKey.set(key, meta);
    projectsByGroupPath.set(groupPath, meta);

    // Multi-module Maven: BFS from <modules> list up to 5 levels deep.
    if (manifest.modules && manifest.modules.length > 0 && manifest.pomPath) {
      let currentLevel: Array<{
        pomDir: string;
        parentGroupId: string;
        pomResult: PomResult;
      }> = [
        {
          pomDir: path.dirname(manifest.pomPath),
          parentGroupId: manifest.groupId,
          pomResult: manifest,
        },
      ];
      for (let depth = 0; depth < 5 && currentLevel.length > 0; depth++) {
        const nextLevel: typeof currentLevel = [];
        for (const { pomDir, parentGroupId, pomResult } of currentLevel) {
          if (!pomResult.modules || pomResult.modules.length === 0) continue;
          for (const moduleName of pomResult.modules) {
            const moduleDir = path.join(pomDir, moduleName);
            const modulePomPath = path.join(moduleDir, 'pom.xml');
            try {
              const moduleContent = await fs.readFile(modulePomPath, 'utf-8');
              const moduleResult = parsePom(moduleContent);
              if (moduleResult) {
                const moduleGroupId = moduleResult.groupId || parentGroupId;
                const moduleKey = `${moduleGroupId}:${moduleResult.artifactId}`;
                if (!projectsByKey.has(moduleKey)) {
                  const moduleMeta: JavaProjectMeta = {
                    groupId: moduleGroupId,
                    artifactId: moduleResult.artifactId,
                    groupPath,
                    repoPath,
                    moduleDir,
                    deps: moduleResult.deps,
                  };
                  projectsByKey.set(moduleKey, moduleMeta);
                  moduleDirToKey.set(moduleDir, moduleKey);
                  logger.info(
                    `[java-workspace-extractor] discovered module ${moduleKey} in ${groupPath} (depth ${depth + 1})`,
                  );
                  nextLevel.push({
                    pomDir: moduleDir,
                    parentGroupId: moduleGroupId,
                    pomResult: moduleResult,
                  });
                }
              }
            } catch {
              // Module POM not found or unreadable — skip
            }
          }
        }
        currentLevel = nextLevel;
      }
    }
  }

  // Discover actual Java packages for each module and build a
  // package→artifactKey multi-map. Scan only the MODULE DIRECTORY,
  // not the repo root, and exclude sub-module directories so aggregator
  // modules don't claim packages from their children.
  const pkgClaimants = new Map<string, Set<string>>();
  for (const [moduleDir, artifactKey] of moduleDirToKey) {
    const childDirs = [...moduleDirToKey.keys()].filter(
      (d) => d.startsWith(moduleDir + path.sep) && d !== moduleDir,
    );
    const actualPkgs = await discoverActualPackages(moduleDir, 5000, childDirs);
    for (const pkg of actualPkgs) {
      if (!pkgClaimants.has(pkg)) pkgClaimants.set(pkg, new Set());
      pkgClaimants.get(pkg)!.add(artifactKey);
    }
    if (actualPkgs.size > 0) {
      logger.info(
        `[java-workspace-extractor] ${artifactKey} exports packages: ${[...actualPkgs].join(', ')}`,
      );
    }
  }

  const links: GroupManifestLink[] = [];
  const seen = new Set<string>();

  // Iterate ALL modules (top-level + leaf modules from BFS) as potential
  // consumers. For each module, scan Java imports only within its own
  // directory so imports from sibling modules don't pollute the results.
  const allModules = [...projectsByKey.values()];
  for (const proj of allModules) {
    const groupDeps = proj.deps.filter((d) => projectsByKey.has(d));
    if (groupDeps.length === 0) continue;

    // Build knownPackages from actual Java packages per-consumer
    // (only claimants that are deps of this module).
    const knownPackages = new Map<string, Set<string>>();
    for (const dep of groupDeps) {
      for (const [pkg, claimants] of pkgClaimants) {
        if (claimants.has(dep)) {
          if (!knownPackages.has(pkg)) knownPackages.set(pkg, new Set());
          knownPackages.get(pkg)!.add(dep);
        }
      }
    }
    if (knownPackages.size === 0) continue;

    // Scan only the module's own directory for leaf modules, or the
    // entire repo for top-level projects (no moduleDir set).
    const scanDir = proj.moduleDir || proj.repoPath;
    const imports = await scanJavaImports(scanDir, knownPackages);

    for (const imp of imports) {
      const providerProj = projectsByKey.get(imp.artifactKey);
      if (!providerProj) continue;
      // Skip intra-repo links — only cross-repo links are useful.
      if (providerProj.groupPath === proj.groupPath) continue;

      const qualifiedContract = `${providerProj.artifactId}::${imp.symbolName}`;
      const dedupKey = `${proj.groupPath}→${providerProj.groupPath}::${qualifiedContract}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const link: GroupManifestLink = {
        from: providerProj.groupPath,
        to: proj.groupPath,
        type: 'custom',
        contract: qualifiedContract,
        role: 'provider' as ContractRole,
      };
      links.push(link);
    }

    // Scan cross-repo inheritance (extends/implements). Emits links with
    // the ext class name in extSymbol so manifest-extractor can resolve
    // the consumer symbol as the ext class (not the base class).
    const inheritances = await scanJavaInheritance(scanDir, knownPackages);
    for (const inh of inheritances) {
      const providerProj = projectsByKey.get(inh.artifactKey);
      if (!providerProj) continue;
      if (providerProj.groupPath === proj.groupPath) continue;

      const qualifiedContract = `${providerProj.artifactId}::${inh.baseSymbolName}`;
      const dedupKey = `${proj.groupPath}→${providerProj.groupPath}::${inh.relType}::${qualifiedContract}::${inh.extSymbolName}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      links.push({
        from: providerProj.groupPath,
        to: proj.groupPath,
        type: inh.relType,
        contract: qualifiedContract,
        extSymbol: inh.extSymbolName,
        role: 'provider' as ContractRole,
      });
    }

    // Scan for non-inheritance factory override patterns.
    // *Factory.override*(Base.class, Ext.class) links factories where
    // ExtFactory extends AbstractRequestFactory, not BaseFactory.
    const overrides = await scanJavaOverride(scanDir, knownPackages);
    for (const ov of overrides) {
      const providerProj = projectsByKey.get(ov.artifactKey);
      if (!providerProj) continue;
      if (providerProj.groupPath === proj.groupPath) continue;

      const qualifiedContract = `${providerProj.artifactId}::${ov.baseSymbolName}`;
      const dedupKey = `${proj.groupPath}→${providerProj.groupPath}::override::${qualifiedContract}::${ov.extSymbolName}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      links.push({
        from: providerProj.groupPath,
        to: proj.groupPath,
        type: 'override',
        contract: qualifiedContract,
        extSymbol: ov.extSymbolName,
        role: 'provider' as ContractRole,
      });
    }
  }

  return { links, discoveredProjects: projectsByGroupPath };
}
