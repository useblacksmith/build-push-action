import * as fs from 'fs';
import * as core from '@actions/core';
import {ChildProcess, exec, spawn} from 'child_process';
import {promisify} from 'util';
import * as TOML from '@iarna/toml';
import * as reporter from './reporter';
import {execa} from 'execa';

// Constants for configuration.
const BUILDKIT_DAEMON_ADDR = 'tcp://127.0.0.1:1234';
const mountPoint = '/var/lib/buildkit';
const execAsync = promisify(exec);

export async function getTailscaleIP(): Promise<string | null> {
  try {
    const {stdout} = await execAsync('tailscale ip -4');
    return stdout.trim();
  } catch (error) {
    core.debug(`Error getting tailscale IP: ${error.message}`);
    return null;
  }
}

async function maybeFormatBlockDevice(device: string): Promise<string> {
  try {
    // Check if device is formatted with ext4
    try {
      const {stdout} = await execAsync(`sudo blkid -o value -s TYPE ${device}`);
      if (stdout.trim() === 'ext4') {
        core.debug(`Device ${device} is already formatted with ext4`);
        try {
          // Run resize2fs to ensure filesystem uses full block device
          await execAsync(`sudo resize2fs -f ${device}`);
          core.debug(`Resized ext4 filesystem on ${device}`);
        } catch (error) {
          core.warning(`Error resizing ext4 filesystem on ${device}: ${error}`);
        }
        return device;
      }
    } catch (error) {
      // blkid returns non-zero if no filesystem found, which is fine
      core.debug(`No filesystem found on ${device}, will format it`);
    }

    // Format device with ext4
    core.debug(`Formatting device ${device} with ext4`);
    await execAsync(`sudo mkfs.ext4 -m0 -Enodiscard,lazy_itable_init=1,lazy_journal_init=1 -F ${device}`);
    core.debug(`Successfully formatted ${device} with ext4`);
    return device;
  } catch (error) {
    core.error(`Failed to format device ${device}:`, error);
    throw error;
  }
}

export async function getNumCPUs(): Promise<number> {
  try {
    const {stdout} = await execAsync('sudo nproc');
    return parseInt(stdout.trim());
  } catch (error) {
    core.warning('Failed to get CPU count, defaulting to 1:', error);
    return 1;
  }
}

async function writeBuildkitdTomlFile(parallelism: number, addr: string): Promise<void> {
  const jsonConfig: TOML.JsonMap = {
    root: '/var/lib/buildkit',
    grpc: {
      address: [addr]
    },
    registry: {
      'docker.io': {
        mirrors: ['http://192.168.127.1:5000'],
        http: true,
        insecure: true
      },
      '192.168.127.1:5000': {
        http: true,
        insecure: true
      }
    },
    worker: {
      oci: {
        enabled: true,
        // Disable automatic garbage collection, since we will prune manually. Automatic GC
        // has been seen to negatively affect startup times of the daemon.
        gc: false,
        'max-parallelism': parallelism,
        snapshotter: 'overlayfs'
      },
      containerd: {
        enabled: false
      }
    }
  };

  const tomlString = TOML.stringify(jsonConfig);

  try {
    await fs.promises.writeFile('buildkitd.toml', tomlString);
    core.debug(`TOML configuration is ${tomlString}`);
  } catch (err) {
    core.warning('error writing TOML configuration:', err);
    throw err;
  }
}

export async function startBuildkitd(parallelism: number, addr: string, setupOnly: boolean): Promise<string> {
  try {
    await writeBuildkitdTomlFile(parallelism, addr);

    // Creates a log stream to write buildkitd output to a file.
    const logStream = fs.createWriteStream('/tmp/buildkitd.log', {flags: 'a'});
    let buildkitd: ChildProcess;
    if (!setupOnly) {
      buildkitd = spawn('sudo', ['buildkitd', '--debug', '--config=buildkitd.toml', '--allow-insecure-entitlement', 'security.insecure', '--allow-insecure-entitlement', 'network.host'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } else {
      const buildkitdCommand = 'nohup sudo buildkitd --debug --config=buildkitd.toml --allow-insecure-entitlement security.insecure --allow-insecure-entitlement network.host > /tmp/buildkitd.log 2>&1 &';
      buildkitd = execa(buildkitdCommand, {
        shell: '/bin/bash',
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        cleanup: false
      });
    }

    // Pipe stdout and stderr to log file
    if (buildkitd.stdout) {
      buildkitd.stdout.pipe(logStream);
    }
    if (buildkitd.stderr) {
      buildkitd.stderr.pipe(logStream);
    }

    buildkitd.on('error', error => {
      throw new Error(`Failed to start buildkitd: ${error.message}`);
    });

    // Wait for buildkitd PID to appear with backoff retry
    const startTime = Date.now();
    const timeout = 10000; // 10 seconds
    const backoff = 300; // 300ms

    while (Date.now() - startTime < timeout) {
      try {
        const {stdout} = await execAsync('pgrep buildkitd');
        if (stdout.trim()) {
          core.info(`buildkitd daemon started successfully with PID ${stdout.trim()}`);
          return addr;
        }
      } catch (error) {
        // pgrep returns non-zero if process not found, which is expected while waiting
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }

    throw new Error('Timed out waiting for buildkitd to start after 10 seconds');
  } catch (error) {
    core.error('failed to start buildkitd daemon:', error);
    throw error;
  }
}

export async function getStickyDisk(options?: {signal?: AbortSignal}): Promise<{expose_id: string; device: string}> {
  const client = await reporter.createBlacksmithAgentClient();
  core.info(`Created Blacksmith agent client`);

  // Test connection using up endpoint
  try {
    await client.up({}, {signal: options?.signal});
    core.info('Successfully connected to Blacksmith agent');
  } catch (error) {
    throw new Error(`grpc connection test failed: ${error.message}`);
  }

  const stickyDiskKey = process.env.GITHUB_REPO_NAME || '';
  if (stickyDiskKey === '') {
    throw new Error('GITHUB_REPO_NAME is not set');
  }
  core.info(`Getting sticky disk for ${stickyDiskKey}`);

  const response = await client.getStickyDisk(
    {
      stickyDiskKey: stickyDiskKey,
      region: process.env.BLACKSMITH_REGION || 'eu-central',
      installationModelId: process.env.BLACKSMITH_INSTALLATION_MODEL_ID || '',
      vmId: process.env.BLACKSMITH_VM_ID || '',
      stickyDiskType: 'dockerfile',
      repoName: process.env.GITHUB_REPO_NAME || '',
      stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || ''
    },
    {
      signal: options?.signal
    }
  );
  return {
    expose_id: response.exposeId || '',
    device: response.diskIdentifier || ''
  };
}

export async function joinTailnet(): Promise<void> {
  const token = process.env.BLACKSMITH_TAILSCALE_TOKEN;
  if (!token || token === 'unset') {
    core.debug('BLACKSMITH_TAILSCALE_TOKEN environment variable not set, skipping tailnet join');
    return;
  }

  try {
    await execAsync(`sudo tailscale up --authkey=${token} --hostname=${process.env.BLACKSMITH_VM_ID}`);

    core.info('Successfully joined tailnet');
  } catch (error) {
    throw new Error(`Failed to join tailnet: ${error.message}`);
  }
}

export async function leaveTailnet(): Promise<void> {
  try {
    // Check if we're part of a tailnet before trying to leave
    try {
      const {stdout} = await execAsync('sudo tailscale status');
      if (stdout.trim() !== '') {
        await execAsync('sudo tailscale down');
        core.debug('Successfully left tailnet.');
      } else {
        core.debug('Not part of a tailnet, skipping leave.');
      }
    } catch (error: unknown) {
      // Type guard for ExecException which has the code property
      if (error && typeof error === 'object' && 'code' in error && error.code === 1) {
        core.debug('Not part of a tailnet, skipping leave.');
        return;
      }
      // Any other exit code indicates a real error
      throw error;
    }
  } catch (error) {
    core.warning(`Error leaving tailnet: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// buildkitdTimeoutMs states the max amount of time this action will wait for the buildkitd
// daemon to start have its socket ready. It also additionally governs how long we will wait for
// the buildkitd workers to be ready.
const buildkitdTimeoutMs = 30000;

export async function startAndConfigureBuildkitd(parallelism: number, setupOnly: boolean, platforms?: string[]): Promise<string> {
  // For multi-platform builds, we need to use the tailscale IP
  let buildkitdAddr = BUILDKIT_DAEMON_ADDR;
  const nativeMultiPlatformBuildsEnabled = false && (platforms?.length ?? 0 > 1);

  // If we are doing a multi-platform build, we need to join the tailnet and bind buildkitd to the tailscale IP.
  // We do this so that the remote VM can join the same buildkitd cluster as a worker.
  if (nativeMultiPlatformBuildsEnabled) {
    await joinTailnet();
    const tailscaleIP = await getTailscaleIP();
    if (!tailscaleIP) {
      throw new Error('Failed to get tailscale IP for multi-platform build');
    }
    buildkitdAddr = `tcp://${tailscaleIP}:1234`;
    core.info(`Using tailscale IP for multi-platform build: ${buildkitdAddr}`);
  }

  const addr = await startBuildkitd(parallelism, buildkitdAddr, setupOnly);
  core.debug(`buildkitd daemon started at addr ${addr}`);

  // Check that buildkit instance is ready by querying workers for up to 30s
  const startTimeBuildkitReady = Date.now();
  const timeoutBuildkitReady = buildkitdTimeoutMs;

  while (Date.now() - startTimeBuildkitReady < timeoutBuildkitReady) {
    try {
      const {stdout} = await execAsync(`sudo buildctl --addr ${addr} debug workers`);
      const lines = stdout.trim().split('\n');
      // For multi-platform builds, we need at least 2 workers
      const requiredWorkers = nativeMultiPlatformBuildsEnabled ? 2 : 1;
      if (lines.length > requiredWorkers) {
        core.info(`Found ${lines.length - 1} workers, required ${requiredWorkers}`);
        break;
      }
    } catch (error) {
      core.debug(`Error checking buildkit workers: ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Final check after timeout.
  try {
    const {stdout} = await execAsync(`sudo buildctl --addr ${addr} debug workers`);
    const lines = stdout.trim().split('\n');
    const requiredWorkers = nativeMultiPlatformBuildsEnabled ? 2 : 1;
    if (lines.length <= requiredWorkers) {
      throw new Error(`buildkit workers not ready after ${buildkitdTimeoutMs}ms timeout. Found ${lines.length - 1} workers, required ${requiredWorkers}`);
    }
  } catch (error) {
    core.warning(`Error checking buildkit workers: ${error.message}`);
    throw error;
  }

  return addr;
}

/**
 * Prunes buildkit cache data older than 7 days.
 * We don't specify any keep bytes here since we are
 * handling the ceph volume size limits ourselves in
 * the VM Agent.
 * @throws Error if buildctl prune command fails
 */
export async function pruneBuildkitCache(): Promise<void> {
  try {
    const sevenDaysInHours = 7 * 24;
    await execAsync(`sudo buildctl --addr ${BUILDKIT_DAEMON_ADDR} prune --keep-duration ${sevenDaysInHours}h --all`);
    core.debug('Successfully pruned buildkit cache');
  } catch (error) {
    core.warning(`Error pruning buildkit cache: ${error.message}`);
    throw error;
  }
}

// stickyDiskTimeoutMs states the max amount of time this action will wait for the VM agent to
// expose the sticky disk from the storage agent, map it onto the host and then patch the drive
// into the VM.
const stickyDiskTimeoutMs = 45000;

// setupStickyDisk mounts a sticky disk for the entity and returns the device information.
// throws an error if it is unable to do so because of a timeout or an error
export async function setupStickyDisk(dockerfilePath: string, setupOnly: boolean): Promise<{device: string; buildId?: string | null; exposeId: string}> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), stickyDiskTimeoutMs);

    let buildResponse: {docker_build_id: string} | null = null;
    let exposeId: string = '';
    let device: string = '';
    const stickyDiskResponse = await getStickyDisk({signal: controller.signal});
    exposeId = stickyDiskResponse.expose_id;
    device = stickyDiskResponse.device;
    if (device === '') {
      // TODO(adityamaru): Remove this once all of our VM agents are returning the device in the stickydisk response.
      device = '/dev/vdb';
    }
    clearTimeout(timeoutId);
    await maybeFormatBlockDevice(device);

    // If setup-only is true, we don't want to report the build to our control plane.
    let buildId: string | undefined = undefined;
    if (!setupOnly) {
      buildResponse = await reporter.reportBuild(dockerfilePath);
      buildId = buildResponse?.docker_build_id;
    }
    await execAsync(`sudo mkdir -p ${mountPoint}`);
    await execAsync(`sudo mount ${device} ${mountPoint}`);
    core.debug(`${device} has been mounted to ${mountPoint}`);
    core.info('Successfully obtained sticky disk');

    // Check inode usage at mountpoint, and report if over 80%.
    try {
      const {stdout} = await execAsync(`df -i ${mountPoint} | tail -1 | awk '{print $5}' | sed 's/%//'`);
      const inodePercentage = parseInt(stdout.trim());
      if (!isNaN(inodePercentage) && inodePercentage > 80) {
        // Report if over 80%
        await reporter.reportBuildPushActionFailure(new Error(`High inode usage (${inodePercentage}%) detected at ${mountPoint}`), 'setupStickyDisk', true /* isWarning */);
        core.warning(`High inode usage (${inodePercentage}%) detected at ${mountPoint}`);
      }
    } catch (error) {
      core.debug(`Error checking inode usage: ${error.message}`);
    }
    return {device, buildId, exposeId};
  } catch (error) {
    core.warning(`Error in setupStickyDisk: ${(error as Error).message}`);
    throw error;
  }
}
