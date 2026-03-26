import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import * as actionsToolkit from '@docker/actions-toolkit';

import {Buildx} from '@docker/actions-toolkit/lib/buildx/buildx.js';
import {History as BuildxHistory} from '@docker/actions-toolkit/lib/buildx/history.js';
import {Context} from '@docker/actions-toolkit/lib/context.js';
import {Docker} from '@docker/actions-toolkit/lib/docker/docker.js';
import {Exec} from '@docker/actions-toolkit/lib/exec.js';
import {GitHub} from '@docker/actions-toolkit/lib/github/github.js';
import {GitHubArtifact} from '@docker/actions-toolkit/lib/github/artifact.js';
import {GitHubSummary} from '@docker/actions-toolkit/lib/github/summary.js';
import {Toolkit} from '@docker/actions-toolkit/lib/toolkit.js';
import {Util} from '@docker/actions-toolkit/lib/util.js';

import {BuilderInfo} from '@docker/actions-toolkit/lib/types/buildx/builder.js';
import {ConfigFile} from '@docker/actions-toolkit/lib/types/docker/docker.js';
import {UploadResponse as UploadArtifactResponse} from '@docker/actions-toolkit/lib/types/github/artifact.js';

import * as context from './context.js';
import * as reporter from './reporter.js';
import * as stateHelper from './state-helper.js';

async function assertBuildxAvailable(toolkit: Toolkit): Promise<void> {
  if (!(await toolkit.buildx.isAvailable())) {
    core.setFailed(`Docker buildx is required. Please use setup-docker-builder action to configure buildx.`);
    throw new Error('Docker buildx is not available');
  }

  await core.group(`Buildx version`, async () => {
    await toolkit.buildx.printVersion();
  });
}

/**
 * Reports the build start to the backend and gets a build ID for tracking.
 *
 * @param inputs - Configuration inputs
 * @returns {string|null} buildId - ID used to track build progress and report metrics
 */
export async function reportBuildStart(inputs: context.Inputs): Promise<string | null> {
  try {
    // Get the dockerfile path to report the build to our control plane.
    const dockerfilePath = context.getDockerfilePath(inputs);
    if (!dockerfilePath) {
      throw new Error('Failed to resolve dockerfile path');
    }

    // Report build start to get a build ID for tracking
    try {
      const buildInfo = await reporter.reportBuild(dockerfilePath);
      return buildInfo?.docker_build_id || null;
    } catch (error) {
      core.warning(`Error reporting build start: ${(error as Error).message}`);
      return null;
    }
  } catch (error) {
    core.warning(`Error when reporting build metrics: ${error.message}`);
    return null;
  }
}

actionsToolkit.run(
  // main
  async () => {
    const startedTime = new Date();
    const inputs: context.Inputs = await context.getInputs();
    stateHelper.setSummaryInputs(inputs);
    core.debug(`inputs: ${JSON.stringify(inputs)}`);

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

    // Assert that buildx is available (should be installed by setup-docker-builder)
    await core.group(`Check buildx availability`, async () => {
      await assertBuildxAvailable(toolkit);
    });

    stateHelper.setTmpDir(Context.tmpDir());

    let buildId: string | null = null;
    let buildError: Error | undefined;
    let buildDurationSeconds: string | undefined;
    let ref: string | undefined;
    let isBlacksmithBuilder = false;
    let builder: BuilderInfo;

    try {
      // Check that a builder is available (either from setup-docker-builder or existing)
      await core.group(`Builder info`, async () => {
        try {
          builder = await toolkit.builder.inspect(inputs.builder);
          stateHelper.setBuilderDriver(builder.driver ?? '');
          stateHelper.setBuilderEndpoint(builder.nodes?.[0]?.endpoint ?? '');
          if (builder) {
            core.info(JSON.stringify(builder, null, 2));
            // Check if this is a Blacksmith builder
            isBlacksmithBuilder = builder.name ? builder.name.toLowerCase().includes('blacksmith') : false;
            if (!isBlacksmithBuilder) {
              core.warning(`Not using a Blacksmith builder (current builder: ${builder.name || 'unknown'}). Build metrics will not be reported.`);
            }
          } else {
            core.setFailed(`No Docker builder found. Please use setup-docker-builder action or configure a builder before using build-push-action.`);
          }
        } catch (error) {
          core.setFailed(`Error checking for builder: ${error.message}`);
        }
      });

      // Only report build start if using a Blacksmith builder
      if (isBlacksmithBuilder) {
        await core.group(`Setting up build metrics tracking`, async () => {
          buildId = await reportBuildStart(inputs);
        });
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

      const args: string[] = await context.getArgs(inputs, toolkit);
      args.push('--debug');
      core.debug(`context.getArgs: ${JSON.stringify(args)}`);

      const buildCmd = await toolkit.buildx.getCommand(args);
      core.debug(`buildCmd.command: ${buildCmd.command}`);
      core.debug(`buildCmd.args: ${JSON.stringify(buildCmd.args)}`);

      let err: Error | undefined;
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
        if (res.exitCode != 0) {
          if (inputs.call && inputs.call === 'check' && res.stdout.length > 0) {
            // checks warnings are printed to stdout: https://github.com/docker/buildx/pull/2647
            // take the first line with the message summarizing the warnings
            err = new Error(res.stdout.split('\n')[0]?.trim());
          } else if (res.stderr.length > 0) {
            err = new Error(`buildx failed with: ${res.stderr.match(/(.*)\s*$/)?.[0]?.trim() ?? 'unknown error'}`);
          }
        }
      });

      if (err) {
        throw err;
      }

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
        ref = await buildRef(toolkit, startedTime, inputs.builder);
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
        } else if (inputs.call && inputs.call !== 'build') {
          core.info(`Build summary skipped for ${inputs.call} subrequest`);
        } else if (GitHub.isGHES) {
          core.info('Build summary is not yet supported on GHES');
        } else if (!(await toolkit.buildx.versionSatisfies('>=0.23.0'))) {
          core.info('Build summary requires Buildx >= 0.23.0');
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

    await core.group('Reporting build completion', async () => {
      try {
        let exportRes;
        if (!buildError) {
          const buildxHistory = new BuildxHistory();

          // Create a timeout promise that rejects after 30 seconds
          let timeoutId: NodeJS.Timeout | undefined;
          const exportTimeout = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Export operation timed out after 30 seconds')), 30000);
          });

          try {
            // Race between the export operation and the timeout
            exportRes = await Promise.race([
              buildxHistory.export({
                refs: ref ? [ref] : []
              }),
              exportTimeout
            ]);
            // Clear the timeout if export completes successfully
            if (timeoutId) clearTimeout(timeoutId);
          } catch (exportError) {
            // Clear the timeout on error as well
            if (timeoutId) clearTimeout(timeoutId);
            // Log the error but continue with reporting
            core.warning(`Build export failed: ${(exportError as Error).message}`);
            core.info('Continuing with build reporting without export data');
          }
        }

        if (buildId && isBlacksmithBuilder) {
          if (!buildError) {
            await reporter.reportBuildCompleted(exportRes, buildId, ref, buildDurationSeconds);
          } else {
            await reporter.reportBuildFailed(buildId, buildDurationSeconds);
          }
        }
      } catch (error) {
        core.warning(`Error when reporting build completion: ${error.message}`);
      }
    });

    // Re-throw the error after cleanup
    if (buildError) {
      throw buildError;
    }
  },
  // post
  async () => {
    if (stateHelper.isSummarySupported) {
      await core.group(`Generating build summary`, async () => {
        try {
          const recordUploadEnabled = buildRecordUploadEnabled();
          let recordRetentionDays: number | undefined;
          if (recordUploadEnabled) {
            recordRetentionDays = buildRecordRetentionDays();
          }

          const buildxHistory = new BuildxHistory();
          const exportRes = await buildxHistory.export({
            refs: stateHelper.buildRef ? [stateHelper.buildRef] : []
          });
          core.info(`Build record written to ${exportRes.dockerbuildFilename} (${Util.formatFileSize(exportRes.dockerbuildSize)})`);

          let uploadRes: UploadArtifactResponse | undefined;
          if (recordUploadEnabled) {
            uploadRes = await GitHubArtifact.upload({
              filename: exportRes.dockerbuildFilename,
              retentionDays: recordRetentionDays
            });
          }

          await GitHubSummary.writeBuildSummary({
            exportRes: exportRes,
            uploadRes: uploadRes,
            inputs: stateHelper.summaryInputs,
            driver: stateHelper.builderDriver,
            endpoint: stateHelper.builderEndpoint
          });
        } catch (e) {
          core.warning(e.message);
        }
      });
    }
    if (stateHelper.tmpDir.length > 0) {
      await core.group(`Removing temp folder ${stateHelper.tmpDir}`, async () => {
        try {
          fs.rmSync(stateHelper.tmpDir, {recursive: true});
        } catch {
          core.warning(`Failed to remove temp folder ${stateHelper.tmpDir}`);
        }
      });
    }
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
  if (process.env.DOCKER_BUILD_SUMMARY) {
    return Util.parseBool(process.env.DOCKER_BUILD_SUMMARY);
  }
  return true;
}

function buildRecordUploadEnabled(): boolean {
  if (process.env.DOCKER_BUILD_RECORD_UPLOAD) {
    return Util.parseBool(process.env.DOCKER_BUILD_RECORD_UPLOAD);
  }
  return true;
}

function buildRecordRetentionDays(): number | undefined {
  const val = process.env.DOCKER_BUILD_RECORD_RETENTION_DAYS;
  if (val) {
    const res = parseInt(val);
    if (isNaN(res)) {
      throw new Error(`Invalid build record retention days: ${val}`);
    }
    return res;
  }
}
