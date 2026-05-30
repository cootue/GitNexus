import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export type CapabilityStatus = 'available' | 'degraded' | 'unavailable';
export type SemanticSearchMode = 'vector-index' | 'exact-scan' | 'unavailable';

export interface RuntimeFingerprint {
  platform: NodeJS.Platform;
  arch: string;
  node: string;
  gitnexus: string;
  ladybugdb?: string;
  onnxruntime?: string;
}

export interface RuntimeCapabilities {
  graph: CapabilityStatus;
  fts: CapabilityStatus;
  vector: CapabilityStatus;
  semanticMode: SemanticSearchMode;
  exactScanLimit: number;
  reason?: string;
}

export const WIN32_VECTOR_DISABLE_ENV = 'GITNEXUS_DISABLE_VECTOR_WIN32';

const packageVersion = (name: string): string | undefined => {
  try {
    return require(`${name}/package.json`).version;
  } catch {
    return undefined;
  }
};

const gitnexusVersion = (): string => {
  try {
    return require('../../../package.json').version;
  } catch {
    return 'unknown';
  }
};

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const isTruthyFlag = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test(value ?? '');

export const DEFAULT_EXACT_SCAN_LIMIT = 10_000;

export const getExactScanLimit = (): number =>
  parsePositiveInt(process.env.GITNEXUS_SEMANTIC_EXACT_SCAN_LIMIT, DEFAULT_EXACT_SCAN_LIMIT);

export const getRuntimeFingerprint = (): RuntimeFingerprint => ({
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  gitnexus: gitnexusVersion(),
  ladybugdb: packageVersion('@ladybugdb/core'),
  onnxruntime: packageVersion('onnxruntime-node'),
});

export const isWin32VectorRolloutEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !isTruthyFlag(env[WIN32_VECTOR_DISABLE_ENV]);

export const getVectorPlatformReason = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  if (platform !== 'win32') return undefined;
  if (!isWin32VectorRolloutEnabled(env)) {
    return (
      `LadybugDB VECTOR on Windows was disabled via ${WIN32_VECTOR_DISABLE_ENV}=1. ` +
      'Semantic search uses exact scan when embeddings exist.'
    );
  }
  if (isWin32VectorRolloutEnabled(env)) {
    return (
      'LadybugDB VECTOR on Windows is enabled by default. ' +
      `Set ${WIN32_VECTOR_DISABLE_ENV}=1 to force exact scan fallback.`
    );
  }
  return undefined;
};

export const getVectorExactScanReason = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string =>
  platform === 'win32'
    ? isWin32VectorRolloutEnabled(env)
      ? 'LadybugDB VECTOR could not be verified on this Windows runtime; semantic search uses exact scan when embeddings exist.'
      : `LadybugDB VECTOR on Windows was disabled via ${WIN32_VECTOR_DISABLE_ENV}=1. Semantic search uses exact scan when embeddings exist.`
    : 'Semantic embeddings were generated without a VECTOR index; queries will use exact scan fallback within the configured limit.';

export const isVectorExtensionSupportedByPlatform = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean => platform !== 'win32' || isWin32VectorRolloutEnabled(env);

export const getRuntimeCapabilities = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeCapabilities => {
  const vector = isVectorExtensionSupportedByPlatform(platform, env) ? 'available' : 'unavailable';
  const exactScanLimit = getExactScanLimit();
  return {
    graph: 'available',
    fts: 'available',
    vector,
    semanticMode: vector === 'available' ? 'vector-index' : 'exact-scan',
    exactScanLimit,
    reason: getVectorPlatformReason(platform, env),
  };
};

export const defaultEmbeddingThreads = (): number => {
  const available =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, Math.floor(available / 2) || 1));
};
