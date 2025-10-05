import * as core from '@actions/core';
import {getArgs, Inputs} from '../context';
import {Toolkit} from '@docker/actions-toolkit/lib/toolkit';

jest.mock('@actions/core');

// Mock the Toolkit.
jest.mock('@docker/actions-toolkit/lib/toolkit');

describe('eStargz compression', () => {
  let mockToolkit: jest.Mocked<Toolkit>;
  let baseInputs: Inputs;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create a mock toolkit with all necessary methods.
    mockToolkit = {
      buildx: {
        versionSatisfies: jest.fn(),
        getCommand: jest.fn(),
        printVersion: jest.fn(),
        isAvailable: jest.fn()
      },
      buildxBuild: {
        getImageIDFilePath: jest.fn().mockReturnValue('/tmp/iidfile'),
        getMetadataFilePath: jest.fn().mockReturnValue('/tmp/metadata'),
        resolveImageID: jest.fn(),
        resolveMetadata: jest.fn(),
        resolveDigest: jest.fn(),
        resolveWarnings: jest.fn(),
        resolveRef: jest.fn()
      },
      builder: {
        inspect: jest.fn().mockResolvedValue({
          name: 'default',
          driver: 'docker-container',
          nodes: []
        })
      },
      buildkit: {
        versionSatisfies: jest.fn().mockResolvedValue(false)
      }
    } as any;

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
    (mockToolkit.buildx.versionSatisfies as jest.Mock).mockResolvedValue(true);

    const inputs = {...baseInputs, push: true, estargz: false};
    const args = await getArgs(inputs, mockToolkit);

    expect(args.join(' ')).not.toContain('compression=estargz');
  });

  test('should not add estargz parameters when push is false', async () => {
    (mockToolkit.buildx.versionSatisfies as jest.Mock).mockResolvedValue(true);

    const inputs = {...baseInputs, push: false, estargz: true};
    const args = await getArgs(inputs, mockToolkit);

    expect(args.join(' ')).not.toContain('compression=estargz');
    expect(core.warning).toHaveBeenCalledWith("eStargz compression requires push: true; the input 'estargz' is ignored.");
  });

  test('should not add estargz parameters when buildx version is < 0.10.0', async () => {
    (mockToolkit.buildx.versionSatisfies as jest.Mock).mockImplementation(async (version: string) => {
      return version === '>=0.6.0'; // Only 0.6.0 check passes, not 0.10.0.
    });

    const inputs = {...baseInputs, push: true, estargz: true};
    const args = await getArgs(inputs, mockToolkit);

    expect(args.join(' ')).not.toContain('compression=estargz');
    expect(core.warning).toHaveBeenCalledWith("eStargz compression requires buildx >= 0.10.0; the input 'estargz' is ignored.");
  });

  test('should add estargz output when estargz is true, push is true, and buildx >= 0.10.0', async () => {
    (mockToolkit.buildx.versionSatisfies as jest.Mock).mockResolvedValue(true);

    const inputs = {...baseInputs, push: true, estargz: true};
    const args = await getArgs(inputs, mockToolkit);

    expect(args).toContain('--output');
    const outputIndex = args.indexOf('--output');
    expect(args[outputIndex + 1]).toBe('type=registry,compression=estargz,force-compression=true,oci-mediatypes=true');
  });

  test('should modify existing registry output with estargz parameters', async () => {
    (mockToolkit.buildx.versionSatisfies as jest.Mock).mockResolvedValue(true);

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
    (mockToolkit.buildx.versionSatisfies as jest.Mock).mockResolvedValue(true);

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
    (mockToolkit.buildx.versionSatisfies as jest.Mock).mockResolvedValue(true);

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
    (mockToolkit.buildx.versionSatisfies as jest.Mock).mockResolvedValue(true);

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
