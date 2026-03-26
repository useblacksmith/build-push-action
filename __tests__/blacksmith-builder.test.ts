import {describe, test, expect, vi, beforeEach} from 'vitest';
import * as core from '@actions/core';
import * as main from '../src/main.js';
import * as reporter from '../src/reporter.js';
import {getDockerfilePath} from '../src/context.js';

vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  saveState: vi.fn(),
  getState: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  error: vi.fn()
}));

vi.mock('../src/context.js', () => ({
  getDockerfilePath: vi.fn(),
  Inputs: vi.fn()
}));

vi.mock('../src/reporter.js', async () => {
  const actual = await vi.importActual('../src/reporter.js');
  return {
    ...actual,
    reportBuildPushActionFailure: vi.fn().mockResolvedValue(undefined),
    reportBuild: vi.fn()
  };
});

describe('reportBuildStart', () => {
  let mockInputs;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInputs = {
      setupOnly: false,
      platforms: []
    };
  });

  test('should handle missing dockerfile path', async () => {
    vi.mocked(getDockerfilePath).mockReturnValue(null);

    const result = await main.reportBuildStart(mockInputs);

    expect(result).toBeNull();
    expect(core.warning).toHaveBeenCalledWith('Error when reporting build metrics: Failed to resolve dockerfile path');
    expect(reporter.reportBuildPushActionFailure).not.toHaveBeenCalled();
  });

  test('should successfully report build start', async () => {
    const mockBuildId = 'test-build-id';
    vi.mocked(getDockerfilePath).mockReturnValue('/path/to/Dockerfile');
    vi.mocked(reporter.reportBuild).mockResolvedValue({docker_build_id: mockBuildId});

    const result = await main.reportBuildStart(mockInputs);

    expect(result).toBe(mockBuildId);
    expect(reporter.reportBuild).toHaveBeenCalledWith('/path/to/Dockerfile');
    expect(reporter.reportBuildPushActionFailure).not.toHaveBeenCalled();
  });

  test('should handle reportBuildStart returning null', async () => {
    vi.mocked(getDockerfilePath).mockReturnValue('/path/to/Dockerfile');
    vi.mocked(reporter.reportBuild).mockResolvedValue(null);

    const result = await main.reportBuildStart(mockInputs);

    expect(result).toBeNull();
    expect(reporter.reportBuild).toHaveBeenCalledWith('/path/to/Dockerfile');
    expect(reporter.reportBuildPushActionFailure).not.toHaveBeenCalled();
  });

  test('should handle error in reportBuildStart', async () => {
    vi.mocked(getDockerfilePath).mockReturnValue('/path/to/Dockerfile');
    vi.mocked(reporter.reportBuild).mockRejectedValue(new Error('API error'));

    const result = await main.reportBuildStart(mockInputs);

    expect(result).toBeNull();
    expect(core.warning).toHaveBeenCalledWith('Error reporting build start: API error');
    expect(reporter.reportBuildPushActionFailure).not.toHaveBeenCalled();
  });
});
