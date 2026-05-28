import { describe, expect, it } from 'vitest';
import {
  isVectorExtensionSupportedByPlatform,
  getVectorPlatformReason,
  WIN32_VECTOR_DISABLE_ENV,
} from '../../src/core/platform/capabilities.js';

describe('platform capabilities', () => {
  it('keeps Ladybug VECTOR enabled by default on Windows', () => {
    expect(isVectorExtensionSupportedByPlatform('win32')).toBe(true);
  });

  it('allows forcing exact-scan fallback on Windows via feature flag', () => {
    expect(isVectorExtensionSupportedByPlatform('win32', { [WIN32_VECTOR_DISABLE_ENV]: '1' })).toBe(
      false,
    );
  });

  it('allows VECTOR probing on Linux and macOS', () => {
    expect(isVectorExtensionSupportedByPlatform('linux')).toBe(true);
    expect(isVectorExtensionSupportedByPlatform('darwin')).toBe(true);
  });

  it('reports the Windows rollout note when VECTOR is enabled by default', () => {
    expect(getVectorPlatformReason('win32')).toContain('enabled by default');
  });

  it('reports the Windows disable note when the feature flag is enabled', () => {
    expect(getVectorPlatformReason('win32', { [WIN32_VECTOR_DISABLE_ENV]: '1' })).toContain(
      'disabled via',
    );
  });
});
