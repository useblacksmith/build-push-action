import {describe, test, expect, vi, beforeEach} from 'vitest';
import * as core from '@actions/core';
import {getArgs, Inputs} from '../src/context.js';
import {Toolkit} from '@docker/actions-toolkit/lib/toolkit.js';

vi.mock('@actions/core');

// Mock the Toolkit.
vi.mock('@docker/actions-toolkit/lib/toolkit.js');

describe('eStargz compression', () => {
  let mockToolkit: Toolkit;
  let baseInputs: Inputs;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create a mock toolkit with all necessary methods.
    mockToolkit = {
      buildx: {
        versionSatisfies: vi.fn(),
        getCommand: vi.fn(),
        printVersion: vi.fn(),
        isAvailable: vi.fn()
      },
      buildxBuild: {
        getImageIDFilePath: vi.fn().mockReturnValue('/tmp/iidfile'),
        getMetadataFilePath: vi.fn().mockReturnValue('/tmp/metadata'),
        resolveImageID: vi.fn(),
        resolveMetadata: vi.fn(),
        resolveDigest: vi.fn(),
        resolveWarnings: vi.fn(),
        resolveRef: vi.fn()
      },
      builder: {
        inspect: vi.fn().mockResolvedValue({
          name: 'default',
          driver: 'docker-container',
          nodes: []
        })
      },
      buildkit: {
        versionSatisfies: vi.fn().mockResolvedValue(false)
      }
    } as unknown as Toolkit;

    // Base inputs for testing.
    baseInputs = {
      'add-hosts': [],
      allow: [],
      annotations: [],
      attests: [],
      'build-args': [],
      'build-contexts': [],
      builder: '',
      'cache-from': [],
      'cache-to': [],
      call: '',
      'cgroup-parent': '',
      context: '.',
      file: '',
      labels: [],
      load: false,
      network: '',
      'no-cache': false,
      'no-cache-filters': [],
      outputs: [],
      platforms: [],
      provenance: '',
      pull: false,
      push: false,
      sbom: '',
      secrets: [],
      'secret-envs': [],
      'secret-files': [],
      'shm-size': '',
      ssh: [],
      tags: ['user/app:latest'],
      target: '',
      ulimit: [],
      'github-token': '',
      estargz: false
    };
  });

  test('should not add estargz parameters when estargz is false', async () => {
    vi.mocked(mockToolkit.buildx.versionSatisfies).mockResolvedValue(true);

    const inputs = {...baseInputs, push: true, estargz: false};
    const args = await getArgs(inputs, mockToolkit);

    expect(args.join(' ')).not.toContain('compression=estargz');
  });

  test('should not add estargz parameters when push is false', async () => {
    vi.mocked(mockToolkit.buildx.versionSatisfies).mockResolvedValue(true);

    const inputs = {...baseInputs, push: false, estargz: true};
    const args = await getArgs(inputs, mockToolkit);

    expect(args.join(' ')).not.toContain('compression=estargz');
    expect(core.warning).toHaveBeenCalledWith("eStargz compression requires push: true; the input 'estargz' is ignored.");
  });

  test('should not add estargz parameters when buildx version is < 0.10.0', async () => {
    vi.mocked(mockToolkit.buildx.versionSatisfies).mockImplementation(async (version: string) => {
      return version === '>=0.6.0'; // Only 0.6.0 check passes, not 0.10.0.
    });

    const inputs = {...baseInputs, push: true, estargz: true};
    const args = await getArgs(inputs, mockToolkit);

    expect(args.join(' ')).not.toContain('compression=estargz');
    expect(core.warning).toHaveBeenCalledWith("eStargz compression requires buildx >= 0.10.0; the input 'estargz' is ignored.");
  });

  test('should add estargz output when estargz is true, push is true, and buildx >= 0.10.0', async () => {
    vi.mocked(mockToolkit.buildx.versionSatisfies).mockResolvedValue(true);

    const inputs = {...baseInputs, push: true, estargz: true};
    const args = await getArgs(inputs, mockToolkit);

    expect(args).toContain('--output');
    const outputIndex = args.indexOf('--output');
    expect(args[outputIndex + 1]).toBe('type=registry,compression=estargz,force-compression=true,oci-mediatypes=true');
  });

  test('should modify existing registry output with estargz parameters', async () => {
    vi.mocked(mockToolkit.buildx.versionSatisfies).mockResolvedValue(true);

    const inputs = {
      ...baseInputs,
      push: true,
      estargz: true,
      outputs: ['type=registry,dest=output.txt']
    };
    const args = await getArgs(inputs, mockToolkit);

    expect(args).toContain('--output');
    const outputIndex = args.indexOf('--output');
    expect(args[outputIndex + 1]).toBe('type=registry,dest=output.txt,compression=estargz,force-compression=true,oci-mediatypes=true');
  });

  test('should not modify non-registry outputs with estargz parameters', async () => {
    vi.mocked(mockToolkit.buildx.versionSatisfies).mockResolvedValue(true);

    const inputs = {
      ...baseInputs,
      push: true,
      estargz: true,
      outputs: ['type=docker']
    };
    const args = await getArgs(inputs, mockToolkit);

    expect(args).toContain('--output');
    const outputIndex = args.indexOf('--output');
    expect(args[outputIndex + 1]).toBe('type=docker');
  });

  test('should handle multiple outputs correctly', async () => {
    vi.mocked(mockToolkit.buildx.versionSatisfies).mockResolvedValue(true);

    const inputs = {
      ...baseInputs,
      push: true,
      estargz: true,
      outputs: ['type=registry', 'type=docker']
    };
    const args = await getArgs(inputs, mockToolkit);

    const argsStr = args.join(' ');
    expect(argsStr).toContain('type=registry,compression=estargz,force-compression=true,oci-mediatypes=true');
    expect(argsStr).toContain('type=docker');
  });

  test('should work with existing registry output without additional params', async () => {
    vi.mocked(mockToolkit.buildx.versionSatisfies).mockResolvedValue(true);

    const inputs = {
      ...baseInputs,
      push: true,
      estargz: true,
      outputs: ['type=registry']
    };
    const args = await getArgs(inputs, mockToolkit);

    expect(args).toContain('--output');
    const outputIndex = args.indexOf('--output');
    expect(args[outputIndex + 1]).toBe('type=registry,compression=estargz,force-compression=true,oci-mediatypes=true');
  });
});
