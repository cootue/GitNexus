import fs from 'node:fs/promises';
import path from 'node:path';
import type { CypherExecutor } from '../contract-extractor.js';
import type { GroupManifestLink, ContractRole, MatchingConfig } from '../types.js';
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
  fqn: string;
}

interface InheritanceOrOverrideSymbol {
  artifactKey: string;
  baseSymbolName: string;
  extSymbolName: string;
  filePath: string;
  relType: 'extends' | 'implements' | 'override';
  baseFqn: string;
}

interface XmlRefSymbol {
  artifactKey: string;
  symbolName: string;
  filePath: string;
  fqn: string;
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
  // Fix 19: Expand search to include Applications/*/pom.xml for repos
  // without an aggregator POM in the root or Applications/ directly.
  const pomSearchPaths = [
    path.join(repoPath, 'pom.xml'),
    path.join(repoPath, 'Applications', 'pom.xml'),
  ];
  // Add Applications/subdir/pom.xml for repos with multiple sub-apps
  const appsDir = path.join(repoPath, 'Applications');
  try {
    const appEntries = await fs.readdir(appsDir, { withFileTypes: true });
    for (const entry of appEntries) {
      if (entry.isDirectory()) {
        const subPom = path.join(appsDir, entry.name, 'pom.xml');
        if (!pomSearchPaths.includes(subPom)) pomSearchPaths.push(subPom);
      }
    }
  } catch {
    // Applications/ subdir doesn't exist — skip
  }
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
                fqn: fullImport,
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
// resolveTypeName resolves via importMap, same-package fallback, FQN
// passthrough, inner-type handling; localClassNames + jdkClassNames guard
// against intra-repo and JDK false positives.
async function scanJavaInheritance(
  repoPath: string,
  knownPackages: Map<string, Set<string>>,
): Promise<InheritanceOrOverrideSymbol[]> {
  const results: InheritanceOrOverrideSymbol[] = [];
  const sourceFiles = await findJavaFiles(repoPath);
  const sortedPkgs = [...knownPackages.entries()].sort((a, b) => b[0].length - a[0].length);

  // Build set of class names that exist in this repo (from .java filenames).
  // Used to guard against intra-repo same-package fallback FP.
  const localClassNames = new Set<string>();
  for (const relFile of sourceFiles) {
    const baseName = path.basename(relFile, path.extname(relFile));
    if (/^[A-Z]/.test(baseName)) localClassNames.add(baseName);
  }

  // Common JDK/framework class names to prevent FP from same-package
  // fallback when extending JDK types without explicit import.
  const jdkClassNames = new Set([
    'RuntimeException',
    'Exception',
    'Throwable',
    'Error',
    'AutoCloseable',
    'Closeable',
    'Serializable',
    'Cloneable',
    'Comparable',
    'Runnable',
    'Thread',
    'Object',
    'String',
    'Number',
    'Integer',
    'Long',
    'Double',
    'Float',
    'Short',
    'Byte',
    'Boolean',
    'Character',
    'Void',
    'Enum',
    'Iterable',
    'Iterator',
    'Collection',
    'List',
    'Set',
    'Map',
    'ClassLoader',
    'StackTraceElement',
    'StringBuilder',
    'StringBuffer',
    'Service',
    'Appendable',
    'CharSequence',
    'Readable',
    'SuppressWarnings',
    'Override',
    'Deprecated',
    'FunctionalInterface',
  ]);

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

    // Same-package fallback for type resolution. When `extends Foo` has
    // no `import` it's a same-package reference. Resolve to
    // `<thisPackage>.Foo` so the multi-claimant package lookup can still
    // link it to cross-repo providers exporting the same package.
    // Filter via sortedPkgs guarantees JDK/framework classes are dropped.
    const packageMatch = content.match(/^package\s+([\w.]+)\s*;/m);
    const thisPackage = packageMatch ? packageMatch[1] : null;

    const resolveTypeName = (name: string): string | null => {
      // Inner-type handling: OuterType.InnerType
      if (name.includes('.')) {
        const firstDot = name.indexOf('.');
        const outerName = name.substring(0, firstDot);
        if (/^[A-Z]/.test(outerName)) {
          // Inner-type notation: resolve outer's FQN first
          const innerPart = name.substring(firstDot);
          const outerFqn = importMap.get(outerName);
          if (outerFqn) return outerFqn + innerPart;
          if (localClassNames.has(outerName)) return null; // intra-repo
          if (jdkClassNames.has(outerName)) return null; // JDK
          if (thisPackage) return `${thisPackage}.${name}`;
          return null;
        }
        // True FQN (lowercase first segment = package): passthrough
        return name;
      }
      // Simple name
      const fromImport = importMap.get(name);
      if (fromImport) return fromImport;
      if (localClassNames.has(name)) return null; // intra-repo
      if (jdkClassNames.has(name)) return null; // JDK
      if (thisPackage) return `${thisPackage}.${name}`;
      return null;
    };

    // Parse class/interface/enum extends (single base from declRegex).
    const declRegex =
      /^(?:public\s+|protected\s+|private\s+)?(?:abstract\s+)?(?:static\s+)?(?:final\s+)?(?:class|interface|enum)\s+([A-Z]\w*)(?:<[^{]*>)?\s+extends\s+([\w.]+)(?:<[^{]*>)?/gm;
    let declMatch: RegExpExecArray | null;
    while ((declMatch = declRegex.exec(content)) !== null) {
      const extClassName = declMatch[1];
      const baseRaw = declMatch[2];
      // Inner-type uses outer class name for contract symbol.
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
              baseFqn,
            });
          }
        }
      }
    }

    // Parse implements clause (comma-separated).
    // class X extends Y implements A, B<T>, C
    // enum X implements A, B<T>, C
    // Strip generics BEFORE splitting on comma to avoid breaking on
    // type-arg commas (e.g. Foo<A, B>, Qux).
    const implRegex =
      /^(?:public\s+|protected\s+)?(?:abstract\s+)?(?:static\s+)?(?:final\s+)?(?:class|enum)\s+[A-Z]\w*(?:<[^{]*>)?(?:\s+extends\s+[\w.]+(?:<[^{]*>)?)?\s+implements\s+([\w.]+(?:<[^{]*>)?(?:\s*,\s*[\w.]+(?:<[^{]*>)?)*)/gm;
    let implMatch: RegExpExecArray | null;
    while ((implMatch = implRegex.exec(content)) !== null) {
      const implList = implMatch[1];
      let implCleaned = implList;
      while (/<[^<>]*>/.test(implCleaned)) implCleaned = implCleaned.replace(/<[^<>]*>/g, '');
      // Accept FQN (com.foo.Bar) and short names; filter by Pascal last segment.
      const implNames = implCleaned
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^[\w.]+$/.test(s) && /^[A-Z]\w*$/.test(s.split('.').pop()!));
      const extMatch = content.slice(implMatch.index).match(/(?:class|enum)\s+([A-Z]\w*)/);
      if (!extMatch) continue;
      const extClassName = extMatch[1];

      for (const implRaw of implNames) {
        // Inner-type uses outer class name for contract symbol.
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
                baseFqn: implFqn,
              });
            }
          }
        }
      }
    }

    // Parse interface multi-base extends.
    // declRegex captures only the FIRST base for `interface X extends A, B`.
    // This regex captures the full comma-separated list and lets the dedup
    // in the main loop skip overlap with declRegex's single-base emission.
    const ifaceExtendsRegex =
      /^(?:public\s+|protected\s+)?interface\s+([A-Z]\w*)(?:<[^{]*>)?\s+extends\s+([^{]+?)\s*\{/gm;
    let ifaceMatch: RegExpExecArray | null;
    while ((ifaceMatch = ifaceExtendsRegex.exec(content)) !== null) {
      const extClassName = ifaceMatch[1];
      const basesList = ifaceMatch[2];
      let baseCleaned = basesList;
      while (/<[^<>]*>/.test(baseCleaned)) baseCleaned = baseCleaned.replace(/<[^<>]*>/g, '');
      const baseNames = baseCleaned
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^[\w.]+$/.test(s) && /^[A-Z]\w*$/.test(s.split('.').pop()!));

      for (const baseRaw of baseNames) {
        let baseShortName: string;
        if (baseRaw.includes('.') && /^[A-Z]/.test(baseRaw.split('.')[0])) {
          baseShortName = baseRaw.split('.')[0]; // inner-type: outer class
        } else if (baseRaw.includes('.')) {
          baseShortName = baseRaw.split('.').pop()!; // FQN: last segment
        } else {
          baseShortName = baseRaw;
        }
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
                baseFqn,
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

  // Build set of class names that exist in this repo.
  const localClassNames = new Set<string>();
  for (const relFile of sourceFiles) {
    const baseName = path.basename(relFile, path.extname(relFile));
    if (/^[A-Z]/.test(baseName)) localClassNames.add(baseName);
  }

  const jdkClassNames = new Set([
    'RuntimeException',
    'Exception',
    'Throwable',
    'Error',
    'AutoCloseable',
    'Closeable',
    'Serializable',
    'Cloneable',
    'Comparable',
    'Runnable',
    'Thread',
    'Object',
    'String',
    'Number',
    'Integer',
    'Long',
    'Double',
    'Float',
    'Short',
    'Byte',
    'Boolean',
    'Character',
    'Void',
    'Enum',
    'Iterable',
    'Iterator',
    'Collection',
    'List',
    'Set',
    'Map',
    'ClassLoader',
    'StackTraceElement',
    'StringBuilder',
    'StringBuffer',
    'Service',
    'Appendable',
    'CharSequence',
    'Readable',
    'SuppressWarnings',
    'Override',
    'Deprecated',
    'FunctionalInterface',
  ]);

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

    // Same-package fallback + local/JDK guards.
    const packageMatch = content.match(/^package\s+([\w.]+)\s*;/m);
    const thisPackage = packageMatch ? packageMatch[1] : null;

    const resolveTypeName = (name: string): string | null => {
      // NO inner-type handling — overrideRegex captures only simple names.
      if (name.includes('.')) {
        if (/^[a-z]/.test(name)) return name; // FQN passthrough
        return null; // shouldn't happen for override, but guard
      }
      const fromImport = importMap.get(name);
      if (fromImport) return fromImport;
      if (localClassNames.has(name)) return null; // intra-repo
      if (jdkClassNames.has(name)) return null; // JDK
      if (thisPackage) return `${thisPackage}.${name}`;
      return null;
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
              baseFqn,
            });
          }
        }
      }
    }
  }
  return results;
}

// Walk resource files (.xml, .properties, .tld, .drl) for FQN scanning.
// Skips pom.xml since Maven deps are already handled by parseJavaManifest.
async function findResourceFiles(repoPath: string): Promise<string[]> {
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
      } else {
        const lower = entry.name.toLowerCase();
        if (lower === 'pom.xml') continue;
        if (
          !(
            lower.endsWith('.xml') ||
            lower.endsWith('.properties') ||
            lower.endsWith('.tld') ||
            lower.endsWith('.drl')
          )
        )
          continue;
        if (shouldIgnorePath(childRel)) continue;
        if (ig && ig.ignores(childRel)) continue;
        results.push(childRel);
      }
    }
  }

  await walk(repoPath, '');
  return results;
}

// Scan resource files for FQN references to types provided by known group
// packages. Uses knownPackages multi-map for filtering — no hardcoded
// namespace prefix. Each unique (file, symbol) pair is emitted once as
// `xml-ref` so the manifest-extractor surfaces the resource file in
// cross-impact reports when the referenced symbol changes.
async function scanResourceFqnReferences(
  repoPath: string,
  knownPackages: Map<string, Set<string>>,
): Promise<XmlRefSymbol[]> {
  const results: XmlRefSymbol[] = [];
  const sortedPkgs = [...knownPackages.entries()].sort((a, b) => b[0].length - a[0].length);

  // Build set of FQNs that exist in this repo (local Java classes).
  // Used to guard against intra-repo FQN references in resource files.
  const localFqnSet = new Set<string>();
  const javaFiles = await findJavaFiles(repoPath);
  for (const relFile of javaFiles) {
    const absPath = path.join(repoPath, relFile);
    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf-8');
    } catch {
      continue;
    }
    const pkgMatch = content.match(/^package\s+([\w.]+)\s*;/m);
    if (!pkgMatch) continue;
    const className = path.basename(relFile, path.extname(relFile));
    if (/^[A-Z]/.test(className)) {
      localFqnSet.add(`${pkgMatch[1]}.${className}`);
    }
  }

  const resourceFiles = await findResourceFiles(repoPath);
  // Generic FQN: at least 2 lowercase segments + PascalCase tail.
  const fqnRegex = /\b([a-z][\w]*(?:\.[a-z][\w]*){1,}\.[A-Z]\w+)\b/g;
  for (const relFile of resourceFiles) {
    const absPath = path.join(repoPath, relFile);
    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf-8');
    } catch {
      continue;
    }
    const seenInFile = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = fqnRegex.exec(content)) !== null) {
      const fqn = m[1];
      if (seenInFile.has(fqn)) continue;
      seenInFile.add(fqn);
      const className = fqn.split('.').pop()!;
      if (!/^[A-Z]\w*$/.test(className)) continue;
      for (const [basePkg, claimants] of sortedPkgs) {
        if (fqn.startsWith(basePkg + '.') || fqn === basePkg) {
          // Skip if FQN matches a class in the scanned repo (intra-repo).
          if (localFqnSet.has(fqn)) break;
          for (const ak of claimants) {
            results.push({
              artifactKey: ak,
              symbolName: className,
              filePath: relFile,
              fqn,
            });
          }
          break;
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

// Fix 20: Order-independent Maven module discovery. Recursively walks
// the repo to discover ALL pom.xml files (stop-recurse-on-pom),
// classifies into aggregators vs leaves, BFS from aggregators (sorted
// by module count — super-aggregators first), registers uncovered leaves,
// and fixes the orphan bug (missing moduleDir). Returns false if no
// Maven candidates found (caller falls back to parseJavaManifest for
// Gradle repos).
async function scanRepoMavenProjects(
  repoPath: string,
  groupPath: string,
  projectsByKey: Map<string, JavaProjectMeta>,
  moduleDirToKey: Map<string, string>,
  projectsByGroupPath: Map<string, JavaProjectMeta>,
): Promise<boolean> {
  interface PomCandidate extends PomResult {
    pomDir: string;
  }

  const candidates: PomCandidate[] = [];
  const skipDirNames = new Set(['node_modules', 'target']);
  const skipDirPrefixes = ['.'];

  async function findPomFiles(dir: string, depth: number): Promise<void> {
    if (depth > 10) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (skipDirPrefixes.some((p) => name.startsWith(p)) || skipDirNames.has(name)) continue;
      if (!entry.isDirectory()) continue;
      const childDir = path.join(dir, name);
      const childPom = path.join(childDir, 'pom.xml');
      let pomContent: string | undefined;
      try {
        pomContent = await fs.readFile(childPom, 'utf-8');
      } catch {
        /* no pom.xml */
      }
      if (pomContent) {
        const result = parsePom(pomContent);
        if (result) {
          candidates.push({ ...result, pomDir: childDir });
        }
        continue; // stop-recurse-on-pom
      }
      await findPomFiles(childDir, depth + 1);
    }
  }

  let rootResult: PomResult | null = null;
  try {
    const rootContent = await fs.readFile(path.join(repoPath, 'pom.xml'), 'utf-8');
    rootResult = parsePom(rootContent);
  } catch {
    /* no root pom.xml */
  }
  if (rootResult) {
    candidates.unshift({ ...rootResult, pomDir: repoPath });
  }
  await findPomFiles(repoPath, 0);
  if (candidates.length === 0) return false;

  const aggregators = candidates.filter((c) => c.modules.length > 0);
  const leaves = candidates.filter((c) => c.modules.length === 0);
  aggregators.sort((a, b) => b.modules.length - a.modules.length);

  const manifest = aggregators[0] || leaves[0];
  const manifestKey = `${manifest.groupId}:${manifest.artifactId}`;
  const existing = projectsByKey.get(manifestKey);
  if (existing) {
    logger.warn(
      `[java-workspace-extractor] duplicate artifact "${manifestKey}" in "${groupPath}" and "${existing.groupPath}" — skipping "${groupPath}"`,
    );
    return true;
  }
  const meta: JavaProjectMeta = {
    groupId: manifest.groupId,
    artifactId: manifest.artifactId,
    groupPath,
    repoPath,
    deps: manifest.deps,
  };
  projectsByKey.set(manifestKey, meta);
  projectsByGroupPath.set(groupPath, meta);
  logger.info(
    `[java-workspace-extractor] manifest: ${manifestKey} in ${groupPath} (${aggregators.length} aggregators, ${leaves.length} leaves, ${candidates.length} total candidates)`,
  );

  const visited = new Set<string>();
  for (const agg of aggregators) {
    const aggKey = `${agg.groupId}:${agg.artifactId}`;
    if (aggKey !== manifestKey) {
      if (!projectsByKey.has(aggKey)) {
        const aggMeta: JavaProjectMeta = {
          groupId: agg.groupId,
          artifactId: agg.artifactId,
          groupPath,
          repoPath,
          moduleDir: agg.pomDir,
          deps: agg.deps,
        };
        projectsByKey.set(aggKey, aggMeta);
        moduleDirToKey.set(agg.pomDir, aggKey);
        logger.info(
          `[java-workspace-extractor] aggregator: ${aggKey} in ${groupPath} (${agg.modules.length} modules)`,
        );
      } else if (!projectsByKey.get(aggKey)!.moduleDir) {
        projectsByKey.get(aggKey)!.moduleDir = agg.pomDir;
        moduleDirToKey.set(agg.pomDir, aggKey);
      }
    }
    let currentLevel: Array<{
      pomDir: string;
      parentGroupId: string;
      pomResult: PomResult;
    }> = [{ pomDir: agg.pomDir, parentGroupId: agg.groupId, pomResult: agg }];
    for (let depth = 0; depth < 5 && currentLevel.length > 0; depth++) {
      const nextLevel: typeof currentLevel = [];
      for (const { pomDir, parentGroupId, pomResult } of currentLevel) {
        if (!pomResult.modules || pomResult.modules.length === 0) continue;
        for (const moduleName of pomResult.modules) {
          const moduleDir = path.join(pomDir, moduleName);
          const normDir = moduleDir.split(path.sep).join(path.sep);
          if (visited.has(normDir)) continue;
          visited.add(normDir);
          const modulePomPath = path.join(moduleDir, 'pom.xml');
          let moduleContent: string;
          try {
            moduleContent = await fs.readFile(modulePomPath, 'utf-8');
          } catch {
            continue;
          }
          const moduleResult = parsePom(moduleContent);
          if (!moduleResult) continue;
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
              `[java-workspace-extractor] module: ${moduleKey} in ${groupPath} (depth ${depth + 1})`,
            );
          } else if (!projectsByKey.get(moduleKey)!.moduleDir) {
            projectsByKey.get(moduleKey)!.moduleDir = moduleDir;
            moduleDirToKey.set(moduleDir, moduleKey);
          }
          nextLevel.push({
            pomDir: moduleDir,
            parentGroupId: moduleGroupId,
            pomResult: moduleResult,
          });
        }
      }
      currentLevel = nextLevel;
    }
  }

  // Register uncovered leaves that weren't reached via BFS from aggregators.
  for (const leaf of leaves) {
    const leafKey = `${leaf.groupId}:${leaf.artifactId}`;
    if (leafKey === manifestKey) continue;
    if (!projectsByKey.has(leafKey)) {
      const leafMeta: JavaProjectMeta = {
        groupId: leaf.groupId,
        artifactId: leaf.artifactId,
        groupPath,
        repoPath,
        moduleDir: leaf.pomDir,
        deps: leaf.deps,
      };
      projectsByKey.set(leafKey, leafMeta);
      moduleDirToKey.set(leaf.pomDir, leafKey);
      logger.info(`[java-workspace-extractor] leaf: ${leafKey} in ${groupPath}`);
    } else if (!projectsByKey.get(leafKey)!.moduleDir) {
      projectsByKey.get(leafKey)!.moduleDir = leaf.pomDir;
      moduleDirToKey.set(leaf.pomDir, leafKey);
    }
  }

  return true;
}

export interface JavaWorkspaceResult {
  links: GroupManifestLink[];
  discoveredProjects: Map<string, JavaProjectMeta>;
}

export async function extractJavaWorkspaceLinks(
  repos: Record<string, string>,
  repoPaths: Map<string, string>,
  _dbExecutors?: Map<string, CypherExecutor>,
  matchingConfig?: MatchingConfig,
): Promise<JavaWorkspaceResult> {
  const projectsByKey = new Map<string, JavaProjectMeta>();
  const projectsByGroupPath = new Map<string, JavaProjectMeta>();
  const moduleDirToKey = new Map<string, string>();

  for (const [groupPath] of Object.entries(repos)) {
    const repoPath = repoPaths.get(groupPath);
    if (!repoPath) continue;

    // Fix 20: Order-independent Maven module discovery replaces
    // parseJavaManifest + old BFS block. Falls back to parseJavaManifest
    // for Gradle-only repos.
    const mavenFound = await scanRepoMavenProjects(
      repoPath,
      groupPath,
      projectsByKey,
      moduleDirToKey,
      projectsByGroupPath,
    );
    if (!mavenFound) {
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

      // Multi-module Maven from parseJavaManifest (Gradle fallback path)
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
  // Fix 21: exclude workspace modules by path.
  const excludeWsPaths = matchingConfig?.exclude_workspace_paths || [];
  const allModules = [...projectsByKey.values()].filter((proj) => {
    if (!proj.moduleDir || excludeWsPaths.length === 0) return true;
    const relModuleDir = path.relative(proj.repoPath, proj.moduleDir).replace(/\\/g, '/');
    return !excludeWsPaths.some((p) => relModuleDir.startsWith(p.replace(/\\/g, '/')));
  });
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
        providerFqn: imp.fqn,
        consumerModuleDir: proj.moduleDir
          ? path.relative(proj.repoPath, proj.moduleDir).replace(/\\/g, '/')
          : null,
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
        providerFqn: inh.baseFqn,
        role: 'provider' as ContractRole,
        consumerModuleDir: proj.moduleDir
          ? path.relative(proj.repoPath, proj.moduleDir).replace(/\\/g, '/')
          : null,
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
        providerFqn: ov.baseFqn,
        role: 'provider' as ContractRole,
        consumerModuleDir: proj.moduleDir
          ? path.relative(proj.repoPath, proj.moduleDir).replace(/\\/g, '/')
          : null,
      });
    }

    // Scan XML/properties/TLD/DRL files for FQN references to known group
    // packages. Resource files carry semantic references invisible to the
    // .java-only scanners above. Generic — driven entirely by knownPackages.
    const xmlRefs = await scanResourceFqnReferences(scanDir, knownPackages);
    for (const ref of xmlRefs) {
      const providerProj = projectsByKey.get(ref.artifactKey);
      if (!providerProj) continue;
      if (providerProj.groupPath === proj.groupPath) continue;

      const qualifiedContract = `${providerProj.artifactId}::${ref.symbolName}`;
      const dedupKey = `${proj.groupPath}→${providerProj.groupPath}::xml-ref::${qualifiedContract}::${ref.filePath}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      links.push({
        from: providerProj.groupPath,
        to: proj.groupPath,
        type: 'xml-ref',
        contract: qualifiedContract,
        consumerFilePath: ref.filePath,
        providerFqn: ref.fqn,
        role: 'provider' as ContractRole,
        consumerModuleDir: proj.moduleDir
          ? path.relative(proj.repoPath, proj.moduleDir).replace(/\\/g, '/')
          : null,
      });
    }
  }

  return { links, discoveredProjects: projectsByGroupPath };
}
