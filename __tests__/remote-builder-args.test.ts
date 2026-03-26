import {describe, test, expect, vi, afterEach} from 'vitest';
import * as os from 'os';
import {getRemoteBuilderArgs, resolveRemoteBuilderPlatforms} from '../src/context.js';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  error: vi.fn()
}));

describe('Remote builder platform argument resolution', () => {
  const builderName = 'test-builder';
  const builderUrl = 'tcp://127.0.0.1:1234';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('returns comma-separated list when platforms are supplied', async () => {
    const platforms = ['linux/arm64', 'linux/amd64'];
    const platformStr = resolveRemoteBuilderPlatforms(platforms);
    expect(platformStr).toBe('linux/arm64,linux/amd64');

    const args = await getRemoteBuilderArgs(builderName, builderUrl, platforms);
    const idx = args.indexOf('--platform');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('linux/arm64,linux/amd64');
  });

  test('falls back to host architecture when no platforms supplied', async () => {
    const platformStr = resolveRemoteBuilderPlatforms([]);
    const expectedPlatform = os.arch() === 'arm64' ? 'linux/arm64' : 'linux/amd64';
    expect(platformStr).toBe(expectedPlatform);

    const args = await getRemoteBuilderArgs(builderName, builderUrl, []);
    const idx = args.indexOf('--platform');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe(expectedPlatform);
  });
});
