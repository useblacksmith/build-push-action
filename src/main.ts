import * as fs from 'fs';
import * as path from 'path';
import * as stateHelper from './state-helper';
import * as core from '@actions/core';
import * as actionsToolkit from '@docker/actions-toolkit';

import {Buildx} from '@docker/actions-toolkit/lib/buildx/buildx';
import {History as BuildxHistory} from '@docker/actions-toolkit/lib/buildx/history';
import {Context} from '@docker/actions-toolkit/lib/context';
import {Docker} from '@docker/actions-toolkit/lib/docker/docker';
import {Exec} from '@docker/actions-toolkit/lib/exec';
import {GitHub} from '@docker/actions-toolkit/lib/github';
import {Toolkit} from '@docker/actions-toolkit/lib/toolkit';
import {Util} from '@docker/actions-toolkit/lib/util';

import {BuilderInfo} from '@docker/actions-toolkit/lib/types/buildx/builder';
import {ConfigFile} from '@docker/actions-toolkit/lib/types/docker/docker';

import * as context from './context';
import {promisify} from 'util';
import {exec} from 'child_process';
import * as reporter from './reporter';
import {setupStickyDisk, startAndConfigureBuildkitd, getNumCPUs, leaveTailnet, pruneBuildkitCache} from './setup_builder';
import {Metric_MetricType} from '@buf/blacksmith_vm-agent.bufbuild_es/stickydisk/v1/stickydisk_pb';

const DEFAULT_BUILDX_VERSION = 'v0.23.0';

const mountPoint = '/var/lib/buildkit';
const execAsync = promisify(exec);

async function retryWithBackoff<T>(operation: () => Promise<T>, maxRetries: number = 5, initialBackoffMs: number = 200): Promise<T> {
  let lastError: Error = new Error('No error occurred');
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error.message?.includes('429') || error.status === 429) {
        if (attempt < maxRetries - 1) {
          const backoffMs = initialBackoffMs * Math.pow(2, attempt);
          core.info(`Rate limited (429). Retrying in ${backoffMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }
      }
      throw error;
    }
  }
  throw lastError;
}

async function setupBuildx(version: string, toolkit: Toolkit): Promise<void> {
  let toolPath;
  const standalone = await toolkit.buildx.isStandalone();

  if (!(await toolkit.buildx.isAvailable()) || version) {
    await core.group(`Download buildx from GitHub Releases`, async () => {
      toolPath = await retryWithBackoff(() => toolkit.buildxInstall.download(version || 'latest', true));
    });
  }

  if (toolPath) {
    await core.group(`Install buildx`, async () => {
      if (standalone) {
        await toolkit.buildxInstall.installStandalone(toolPath);
      } else {
        await toolkit.buildxInstall.installPlugin(toolPath);
      }
    });
  }

  await core.group(`Buildx version`, async () => {
    await toolkit.buildx.printVersion();
  });
}

// Validates the version string to ensure it matches a basic expected pattern.
// Accepts versions of the form `v<MAJOR>.<MINOR>.<PATCH>` (e.g., v0.20.0) or the literal string `latest`.
function isValidBuildxVersion(version: string): boolean {
  return version === 'latest' || /^v\d+\.\d+\.\d+$/.test(version);
}

/**
 * Attempts to set up a Blacksmith builder for Docker builds.
 *
 * @param inputs - Configuration inputs including the nofallback flag
 * @returns {Object} Builder configuration
 * @returns {string|null} addr - The buildkit socket address if setup succeeded, null if using local build
 * @returns {string|null} buildId - ID used to track build progress and report metrics
 * @returns {string} exposeId - ID used to track and cleanup sticky disk resources
 *
 * The addr is used to configure the Docker buildx builder instance.
 * The buildId is used for build progress tracking and metrics reporting.
 * The exposeId is used during cleanup to ensure proper resource cleanup of sticky disks.
 *
 * Throws an error if setup fails and nofallback is false.
 * Returns null values if setup fails and nofallback is true.
 */
export async function startBlacksmithBuilder(inputs: context.Inputs): Promise<{addr: string | null; buildId: string | null; exposeId: string}> {
  try {
    // We only use the dockerfile path to report the build to our control plane.
    // If setup-only is true, we don't want to report the build to our control plane
    // since we are only setting up the builder and therefore cannot expose any analytics
    // about the build.
    const dockerfilePath = inputs.setupOnly ? '' : context.getDockerfilePath(inputs);
    if (!inputs.setupOnly && !dockerfilePath) {
      throw new Error('Failed to resolve dockerfile path');
    }
    const stickyDiskStartTime = Date.now();
    const stickyDiskSetup = await setupStickyDisk(dockerfilePath || '', inputs.setupOnly);
    const stickyDiskDurationMs = Date.now() - stickyDiskStartTime;
    await reporter.reportMetric(Metric_MetricType.BPA_HOTLOAD_DURATION_MS, stickyDiskDurationMs);
    const parallelism = await getNumCPUs();

    const buildkitdStartTime = Date.now();
    const buildkitdAddr = await startAndConfigureBuildkitd(parallelism, inputs.setupOnly, inputs.platforms);
    const buildkitdDurationMs = Date.now() - buildkitdStartTime;
    await reporter.reportMetric(Metric_MetricType.BPA_BUILDKITD_READY_DURATION_MS, buildkitdDurationMs);
    stateHelper.setExposeId(stickyDiskSetup.exposeId);
    return {addr: buildkitdAddr, buildId: stickyDiskSetup.buildId || null, exposeId: stickyDiskSetup.exposeId};
  } catch (error) {
    // If the builder setup fails for any reason, we check if we should fallback to a local build.
    // If we should not fallback, we rethrow the error and fail the build.
    await reporter.reportBuildPushActionFailure(error, 'starting blacksmith builder');

    let errorMessage = `Error during Blacksmith builder setup: ${error.message}`;
    if (error.message.includes('buildkitd')) {
      errorMessage = `Error during buildkitd setup: ${error.message}`;
    }
    if (inputs.nofallback) {
      core.warning(`${errorMessage}. Failing the build because nofallback is set.`);
      throw error;
    }

    core.warning(`${errorMessage}. Falling back to a local build.`);
    return {addr: null, buildId: null, exposeId: ''};
  } finally {
    await leaveTailnet();
  }
}

actionsToolkit.run(
  // main
  async () => {
    await reporter.reportMetric(Metric_MetricType.BPA_FEATURE_USAGE, 1);
    const startedTime = new Date();
    const inputs: context.Inputs = await context.getInputs();
    stateHelper.setInputs(inputs);

    const toolkit = new Toolkit();

    await core.group(`GitHub Actions runtime token ACs`, async () => {
      try {
        await GitHub.printActionsRuntimeTokenACs();
      } catch (e) {
        core.warning(e.message);
      }
    });

    await core.group(`Docker info`, async () => {
      try {
        await Docker.printVersion();
        await Docker.printInfo();
      } catch (e) {
        core.info(e.message);
      }
    });

    // Determine which Buildx version to install. If the user provided an input, validate it;
    // otherwise, fall back to the default.
    let buildxVersion = DEFAULT_BUILDX_VERSION;
    if (inputs['buildx-version'] && inputs['buildx-version'].trim() !== '') {
      if (isValidBuildxVersion(inputs['buildx-version'])) {
        buildxVersion = inputs['buildx-version'];
      } else {
        core.warning(`Invalid buildx-version '${inputs['buildx-version']}'. ` + `Expected 'latest' or a version in the form v<MAJOR>.<MINOR>.<PATCH>. ` + `Falling back to default ${DEFAULT_BUILDX_VERSION}.`);
      }
    }

    await core.group(`Setup buildx`, async () => {
      await setupBuildx(buildxVersion, toolkit);

      if (!(await toolkit.buildx.isAvailable())) {
        core.setFailed(`Docker buildx is required. See https://github.com/docker/setup-buildx-action to set up buildx.`);
        return;
      }
    });

    let builderInfo = {
      addr: null as string | null,
      buildId: null as string | null,
      exposeId: '' as string
    };
    let buildError: Error | undefined;
    let buildDurationSeconds: string | undefined;
    let ref: string | undefined;
    try {
      await core.group(`Starting Blacksmith builder`, async () => {
        builderInfo = await startBlacksmithBuilder(inputs);
      });

      if (builderInfo.addr) {
        await core.group(`Creating a builder instance`, async () => {
          const name = `blacksmith-${Date.now().toString(36)}`;
          const createCmd = await toolkit.buildx.getCommand(await context.getRemoteBuilderArgs(name, builderInfo.addr!, inputs.platforms));
          core.info(`Creating builder with command: ${createCmd.command}`);
          await Exec.getExecOutput(createCmd.command, createCmd.args, {
            ignoreReturnCode: true
          }).then(res => {
            if (res.stderr.length > 0 && res.exitCode != 0) {
              throw new Error(res.stderr.match(/(.*)\s*$/)?.[0]?.trim() ?? 'unknown error');
            }
          });
          // Set this builder as the global default since future docker commands will use this builder.
          if (inputs.setupOnly) {
            const setDefaultCmd = await toolkit.buildx.getCommand(await context.getUseBuilderArgs(name));
            core.info('Setting builder as global default');
            await Exec.getExecOutput(setDefaultCmd.command, setDefaultCmd.args, {
              ignoreReturnCode: true
            }).then(res => {
              if (res.stderr.length > 0 && res.exitCode != 0) {
                throw new Error(res.stderr.match(/(.*)\s*$/)?.[0]?.trim() ?? 'unknown error');
              }
            });
          }
        });
      } else {
        core.warning('Failed to setup Blacksmith builder, falling back to default builder');
        await core.group(`Checking for configured builder`, async () => {
          try {
            const builder = await toolkit.builder.inspect();
            if (builder) {
              core.info(`Found configured builder: ${builder.name}`);
            } else {
              // Create a local builder using the docker-container driver (which is the default driver in setup-buildx)
              const createLocalBuilderCmd = 'docker buildx create --name local --driver docker-container --use';
              try {
                await Exec.exec(createLocalBuilderCmd);
                core.info('Created and set a local builder for use');
              } catch (error) {
                core.setFailed(`Failed to create local builder: ${error.message}`);
              }
            }
          } catch (error) {
            core.setFailed(`Error configuring builder: ${error.message}`);
          }
        });
      }

      // Write a sentinel file to indicate builder setup is complete.
      const sentinelPath = path.join('/tmp', 'builder-setup-complete');
      try {
        fs.writeFileSync(sentinelPath, 'Builder setup completed successfully.');
        core.debug(`Created builder setup sentinel file at ${sentinelPath}`);
      } catch (error) {
        core.warning(`Failed to create builder setup sentinel file: ${error.message}`);
      }

      let builder: BuilderInfo;
      await core.group(`Builder info`, async () => {
        builder = await toolkit.builder.inspect();
        core.info(JSON.stringify(builder, null, 2));
      });

      // If setup-only is true, we don't want to continue configuring and running the build.
      if (inputs.setupOnly) {
        core.info('setup-only mode enabled, builder is ready for use by Docker');
        stateHelper.setSetupOnly(true);
        // Let's remove the default
        process.exit(0);
      }

      await core.group(`Proxy configuration`, async () => {
        let dockerConfig: ConfigFile | undefined;
        let dockerConfigMalformed = false;
        try {
          dockerConfig = await Docker.configFile();
        } catch (e) {
          dockerConfigMalformed = true;
          core.warning(`Unable to parse config file ${path.join(Docker.configDir, 'config.json')}: ${e}`);
        }
        if (dockerConfig && dockerConfig.proxies) {
          for (const host in dockerConfig.proxies) {
            let prefix = '';
            if (Object.keys(dockerConfig.proxies).length > 1) {
              prefix = '  ';
              core.info(host);
            }
            for (const key in dockerConfig.proxies[host]) {
              core.info(`${prefix}${key}: ${dockerConfig.proxies[host][key]}`);
            }
          }
        } else if (!dockerConfigMalformed) {
          core.info('No proxy configuration found');
        }
      });

      stateHelper.setTmpDir(Context.tmpDir());

      const args: string[] = await context.getArgs(inputs, toolkit);
      args.push('--debug');
      core.debug(`context.getArgs: ${JSON.stringify(args)}`);

      const buildCmd = await toolkit.buildx.getCommand(args);

      core.debug(`buildCmd.command: ${buildCmd.command}`);
      core.debug(`buildCmd.args: ${JSON.stringify(buildCmd.args)}`);

      const buildStartTime = Date.now();
      await Exec.getExecOutput(buildCmd.command, buildCmd.args, {
        ignoreReturnCode: true,
        env: Object.assign({}, process.env, {
          BUILDX_METADATA_WARNINGS: 'true'
        }) as {
          [key: string]: string;
        }
      }).then(res => {
        buildDurationSeconds = Math.round((Date.now() - buildStartTime) / 1000).toString();
        stateHelper.setDockerBuildDurationSeconds(buildDurationSeconds);
        if (res.stderr.length > 0 && res.exitCode != 0) {
          throw Error(`buildx failed with: ${res.stderr.match(/(.*)\s*$/)?.[0]?.trim() ?? 'unknown error'}`);
        }
      });

      const imageID = toolkit.buildxBuild.resolveImageID();
      const metadata = toolkit.buildxBuild.resolveMetadata();
      const digest = toolkit.buildxBuild.resolveDigest(metadata);
      if (imageID) {
        await core.group(`ImageID`, async () => {
          core.info(imageID);
          core.setOutput('imageid', imageID);
        });
      }
      if (digest) {
        await core.group(`Digest`, async () => {
          core.info(digest);
          core.setOutput('digest', digest);
        });
      }
      if (metadata) {
        await core.group(`Metadata`, async () => {
          const metadatadt = JSON.stringify(metadata, null, 2);
          core.info(metadatadt);
          core.setOutput('metadata', metadatadt);
        });
      }

      await core.group(`Reference`, async () => {
        ref = await buildRef(toolkit, startedTime, builder.name);
        if (ref) {
          core.info(ref);
          stateHelper.setBuildRef(ref);
        } else {
          core.info('No build reference found');
        }
      });

      if (buildChecksAnnotationsEnabled()) {
        const warnings = toolkit.buildxBuild.resolveWarnings(metadata);
        if (ref && warnings && warnings.length > 0) {
          const annotations = await Buildx.convertWarningsToGitHubAnnotations(warnings, [ref]);
          core.debug(`annotations: ${JSON.stringify(annotations, null, 2)}`);
          if (annotations && annotations.length > 0) {
            await core.group(`Generating GitHub annotations (${annotations.length} build checks found)`, async () => {
              for (const annotation of annotations) {
                core.warning(annotation.message, annotation);
              }
            });
          }
        }
      }

      await core.group(`Check build summary support`, async () => {
        if (!buildSummaryEnabled()) {
          core.info('Build summary disabled');
        } else if (GitHub.isGHES) {
          core.info('Build summary is not yet supported on GHES');
        } else if (!(await toolkit.buildx.versionSatisfies('>=0.13.0'))) {
          core.info('Build summary requires Buildx >= 0.13.0');
        } else if (builder && builder.driver === 'cloud') {
          core.info('Build summary is not yet supported with Docker Build Cloud');
        } else if (!ref) {
          core.info('Build summary requires a build reference');
        } else {
          core.info('Build summary supported!');
          stateHelper.setSummarySupported();
        }
      });
    } catch (error) {
      buildError = error as Error;
    }

    await core.group('Cleaning up Blacksmith builder', async () => {
      try {
        let exportRes;
        if (!buildError) {
          const buildxHistory = new BuildxHistory();
          exportRes = await buildxHistory.export({
            refs: ref ? [ref] : []
          });
        }

        try {
          const {stdout} = await execAsync('pgrep buildkitd');
          if (stdout.trim()) {
            try {
              core.info('Pruning BuildKit cache');
              await pruneBuildkitCache();
              core.info('BuildKit cache pruned');
            } catch (error) {
              // Log warning but don't fail the cleanup
              core.warning(`Error pruning BuildKit cache: ${error.message}`);
            }

            const buildkitdShutdownStartTime = Date.now();
            await shutdownBuildkitd();
            const buildkitdShutdownDurationMs = Date.now() - buildkitdShutdownStartTime;
            await reporter.reportMetric(Metric_MetricType.BPA_BUILDKITD_SHUTDOWN_DURATION_MS, buildkitdShutdownDurationMs);
            core.info('Shutdown buildkitd');
          } else {
            core.debug('No buildkitd process found running');
          }
        } catch (error) {
          if (error.code === 1) {
            // pgrep returns non-zero if no processes found, which is fine
            core.debug('No buildkitd process found running');
          } else {
            core.warning(`Error checking for buildkitd processes: ${error.message}`);
          }
        }

        await leaveTailnet();
        try {
          // Run sync to flush any pending writes before unmounting.
          await execAsync('sync');
          const {stdout: mountOutput} = await execAsync(`mount | grep ${mountPoint}`);
          if (mountOutput) {
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                await execAsync(`sudo umount ${mountPoint}`);
                core.debug(`${mountPoint} has been unmounted`);
                break;
              } catch (error) {
                if (attempt === 3) {
                  throw error;
                }
                core.warning(`Unmount failed, retrying (${attempt}/3)...`);
                await new Promise(resolve => setTimeout(resolve, 100));
              }
            }
            core.info('Unmounted device');
          }
        } catch (error) {
          // grep returns exit code 1 when no matches are found.
          if (error.code === 1) {
            core.debug('No dangling mounts found to clean up');
          } else {
            // Only warn for actual errors, not for the expected case where grep finds nothing.
            core.warning(`Error during cleanup: ${error.message}`);
          }
        }

        if (builderInfo.addr) {
          if (!buildError) {
            await reporter.reportBuildCompleted(exportRes, builderInfo.buildId, ref, buildDurationSeconds, builderInfo.exposeId);
          } else {
            await reporter.reportBuildFailed(builderInfo.buildId, buildDurationSeconds, builderInfo.exposeId);
          }
        }
      } catch (error) {
        core.warning(`Error during Blacksmith builder shutdown: ${error.message}`);
        await reporter.reportBuildPushActionFailure(error, 'shutting down blacksmith builder');
      } finally {
        if (buildError) {
          try {
            const buildkitdLog = fs.readFileSync('/tmp/buildkitd.log', 'utf8');
            core.info('buildkitd.log contents:');
            core.info(buildkitdLog);
          } catch (error) {
            // Only log warning if the file was expected to exist (builder setup completed)
            const sentinelPath = path.join('/tmp', 'builder-setup-complete');
            if (fs.existsSync(sentinelPath)) {
              core.warning(`Failed to read buildkitd.log: ${error.message}`);
            } else {
              core.debug(`buildkitd.log not found (builder setup incomplete): ${error.message}`);
            }
          }
        }
      }
    });

    // Re-throw the error after cleanup
    if (buildError) {
      throw buildError;
    }
  },
  // post
  async () => {
    await core.group('Final cleanup', async () => {
      try {
        await leaveTailnet();

        try {
          const {stdout} = await execAsync('pgrep buildkitd');
          if (stdout.trim()) {
            try {
              core.info('Pruning BuildKit cache');
              await pruneBuildkitCache();
              core.info('BuildKit cache pruned');
            } catch (error) {
              // Log warning but don't fail the cleanup
              core.warning(`Error pruning BuildKit cache: ${error.message}`);
            }

            await shutdownBuildkitd();
            core.info('Shutdown buildkitd');
          }
        } catch (error) {
          if (error.code === 1) {
            core.debug('No buildkitd process found running');
          } else {
            core.warning(`Error checking for buildkitd processes: ${error.message}`);
          }
        }

        try {
          // Run sync to flush any pending writes before unmounting.
          await execAsync('sync');
          const {stdout: mountOutput} = await execAsync(`mount | grep ${mountPoint}`);
          if (mountOutput) {
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                await execAsync(`sudo umount ${mountPoint}`);
                core.debug(`${mountPoint} has been unmounted`);
                break;
              } catch (error) {
                if (attempt === 3) {
                  throw error;
                }
                core.warning(`Unmount failed, retrying (${attempt}/3)...`);
                await new Promise(resolve => setTimeout(resolve, 100));
              }
            }
            core.info('Unmounted device');
          }
        } catch (error) {
          if (error.code === 1) {
            core.debug('No dangling mounts found to clean up');
          } else {
            core.warning(`Error during cleanup: ${error.message}`);
          }
        }

        // 4. Clean up temp directory if it exists.
        if (stateHelper.tmpDir.length > 0) {
          fs.rmSync(stateHelper.tmpDir, {recursive: true});
          core.debug(`Removed temp folder ${stateHelper.tmpDir}`);
        }

        // 5. Commit sticky disk if the builder was booted in setup-only mode.
        // If the builder was not booted in setup-only mode, the sticky disk was committed as part
        // of the main routine.
        if (stateHelper.getSetupOnly()) {
          core.info('Committing sticky disk in post cleanup as setup-only mode was enabled');
          if (stateHelper.getExposeId() !== '') {
            await reporter.commitStickyDisk(stateHelper.getExposeId());
          } else {
            core.warning('Expose ID not found in state, skipping sticky disk commit');
          }
        }
      } catch (error) {
        core.warning(`Error during final cleanup: ${error.message}`);
        await reporter.reportBuildPushActionFailure(error, 'final cleanup');
      }
    });
  }
);

async function buildRef(toolkit: Toolkit, since: Date, builder?: string): Promise<string> {
  // get ref from metadata file
  const ref = toolkit.buildxBuild.resolveRef();
  if (ref) {
    return ref;
  }
  // otherwise, look for the very first build ref since the build has started
  if (!builder) {
    const currentBuilder = await toolkit.builder.inspect();
    builder = currentBuilder.name;
  }
  const refs = Buildx.refs({
    dir: Buildx.refsDir,
    builderName: builder,
    since: since
  });
  return Object.keys(refs).length > 0 ? Object.keys(refs)[0] : '';
}

function buildChecksAnnotationsEnabled(): boolean {
  if (process.env.DOCKER_BUILD_CHECKS_ANNOTATIONS) {
    return Util.parseBool(process.env.DOCKER_BUILD_CHECKS_ANNOTATIONS);
  }
  return true;
}

function buildSummaryEnabled(): boolean {
  if (process.env.DOCKER_BUILD_NO_SUMMARY) {
    core.warning('DOCKER_BUILD_NO_SUMMARY is deprecated. Set DOCKER_BUILD_SUMMARY to false instead.');
    return !Util.parseBool(process.env.DOCKER_BUILD_NO_SUMMARY);
  } else if (process.env.DOCKER_BUILD_SUMMARY) {
    return Util.parseBool(process.env.DOCKER_BUILD_SUMMARY);
  }
  return true;
}

export async function shutdownBuildkitd(): Promise<void> {
  const startTime = Date.now();
  const timeout = 10000; // 10 seconds
  const backoff = 300; // 300ms

  try {
    await execAsync(`sudo pkill -TERM buildkitd`);

    // Wait for buildkitd to shutdown with backoff retry
    while (Date.now() - startTime < timeout) {
      try {
        const {stdout} = await execAsync('pgrep buildkitd');
        core.debug(`buildkitd process still running with PID: ${stdout.trim()}`);
        await new Promise(resolve => setTimeout(resolve, backoff));
      } catch (error) {
        if (error.code === 1) {
          // pgrep returns exit code 1 when no process is found, which means shutdown successful
          core.debug('buildkitd successfully shutdown');
          return;
        }
        // Some other error occurred
        throw error;
      }
    }

    throw new Error('Timed out waiting for buildkitd to shutdown after 10 seconds');
  } catch (error) {
    core.error('error shutting down buildkitd process:', error);
    throw error;
  }
}
