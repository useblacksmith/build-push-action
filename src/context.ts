import * as core from '@actions/core';
import * as handlebars from 'handlebars';
import * as os from 'os';

import {Build} from '@docker/actions-toolkit/lib/buildx/build';
import {Context} from '@docker/actions-toolkit/lib/context';
import {GitHub} from '@docker/actions-toolkit/lib/github';
import {Toolkit} from '@docker/actions-toolkit/lib/toolkit';
import {Util} from '@docker/actions-toolkit/lib/util';
import * as path from 'path';

// Helper function to join paths while avoiding duplication of context path
function joinNonOverlapping(context: string, filePath: string): string {
  // Normalize both paths to handle any '..' or '.' segments
  const normalizedContext = path.normalize(context);
  const normalizedFilePath = path.normalize(filePath);

  // If the file path starts with the context, use it as is to avoid duplication
  if (normalizedFilePath.startsWith(normalizedContext)) {
    return normalizedFilePath;
  }

  // Otherwise join them normally
  return path.join(normalizedContext, normalizedFilePath);
}

export interface Inputs {
  'add-hosts': string[];
  allow: string[];
  annotations: string[];
  attests: string[];
  'build-args': string[];
  'build-contexts': string[];
  builder: string;
  'cache-from': string[];
  'cache-to': string[];
  'cgroup-parent': string;
  context: string;
  file: string;
  labels: string[];
  load: boolean;
  network: string;
  'no-cache': boolean;
  'no-cache-filters': string[];
  outputs: string[];
  platforms: string[];
  provenance: string;
  pull: boolean;
  push: boolean;
  sbom: string;
  secrets: string[];
  'secret-envs': string[];
  'secret-files': string[];
  'shm-size': string;
  ssh: string[];
  tags: string[];
  target: string;
  ulimit: string[];
  'github-token': string;
  nofallback: boolean;
  setupOnly: boolean;
  'buildx-version': string;
}

export async function getInputs(): Promise<Inputs> {
  return {
    'add-hosts': Util.getInputList('add-hosts'),
    allow: Util.getInputList('allow'),
    annotations: Util.getInputList('annotations', {ignoreComma: true}),
    attests: Util.getInputList('attests', {ignoreComma: true}),
    'build-args': Util.getInputList('build-args', {ignoreComma: true}),
    'build-contexts': Util.getInputList('build-contexts', {ignoreComma: true}),
    // We accept the builder input from the user, but we don't respect it.
    builder: core.getInput('builder'),
    'cache-from': Util.getInputList('cache-from', {ignoreComma: true}),
    'cache-to': Util.getInputList('cache-to', {ignoreComma: true}),
    'cgroup-parent': core.getInput('cgroup-parent'),
    context: core.getInput('context') || Context.gitContext(),
    file: core.getInput('file'),
    labels: Util.getInputList('labels', {ignoreComma: true}),
    load: core.getBooleanInput('load'),
    network: core.getInput('network'),
    'no-cache': core.getBooleanInput('no-cache'),
    'no-cache-filters': Util.getInputList('no-cache-filters'),
    outputs: Util.getInputList('outputs', {ignoreComma: true, quote: false}),
    platforms: Util.getInputList('platforms'),
    provenance: Build.getProvenanceInput('provenance'),
    pull: core.getBooleanInput('pull'),
    push: core.getBooleanInput('push'),
    sbom: core.getInput('sbom'),
    secrets: Util.getInputList('secrets', {ignoreComma: true}),
    'secret-envs': Util.getInputList('secret-envs'),
    'secret-files': Util.getInputList('secret-files', {ignoreComma: true}),
    'shm-size': core.getInput('shm-size'),
    ssh: Util.getInputList('ssh'),
    tags: Util.getInputList('tags'),
    target: core.getInput('target'),
    ulimit: Util.getInputList('ulimit', {ignoreComma: true}),
    'github-token': core.getInput('github-token'),
    nofallback: core.getBooleanInput('nofallback'),
    setupOnly: core.getBooleanInput('setup-only'),
    'buildx-version': core.getInput('buildx-version')
  };
}

// getDockerfilePath resolves the path to the build entity. This is basically
// {context}/{file} or {context}/{dockerfile} depending on the inputs.
export function getDockerfilePath(inputs: Inputs): string | null {
  try {
    const context = inputs.context || Context.gitContext();
    let dockerfilePath: string;

    if (inputs.file) {
      // If context is git context, just use the file path directly
      dockerfilePath = context === Context.gitContext() ? path.normalize(inputs.file) : joinNonOverlapping(context, inputs.file);
    } else if (inputs['dockerfile']) {
      // If context is git context, just use the dockerfile path directly
      dockerfilePath = context === Context.gitContext() ? path.normalize(inputs['dockerfile']) : joinNonOverlapping(context, inputs['dockerfile']);
    } else {
      // If context is git context, just use 'Dockerfile'
      dockerfilePath = context === Context.gitContext() ? 'Dockerfile' : joinNonOverlapping(context, 'Dockerfile');
    }
    return dockerfilePath;
  } catch (error) {
    core.warning(`Error getting dockerfile path: ${(error as Error).message}`);
    return null;
  }
}

export function sanitizeInputs(inputs: Inputs) {
  const res = {};
  for (const key of Object.keys(inputs)) {
    if (key === 'github-token') {
      continue;
    }
    const value: string | string[] | boolean = inputs[key];
    if (typeof value === 'boolean' && value === false) {
      continue;
    } else if (Array.isArray(value) && value.length === 0) {
      continue;
    } else if (!value) {
      continue;
    }
    res[key] = value;
  }
  return res;
}

export async function getArgs(inputs: Inputs, toolkit: Toolkit): Promise<Array<string>> {
  core.info(`Inputs.context: ${inputs.context}`);
  const context = handlebars.compile(inputs.context)({
    defaultContext: Context.gitContext()
  });
  core.info(`Final context: ${context}`);
  // prettier-ignore
  return [
    ...await getBuildArgs(inputs, context, toolkit),
    ...await getCommonArgs(inputs, toolkit),
    context
  ];
}

async function getBuildArgs(inputs: Inputs, context: string, toolkit: Toolkit): Promise<Array<string>> {
  const args: Array<string> = ['build'];
  await Util.asyncForEach(inputs['add-hosts'], async addHost => {
    args.push('--add-host', addHost);
  });
  if (inputs.allow.length > 0) {
    args.push('--allow', inputs.allow.join(','));
  }
  if (await toolkit.buildx.versionSatisfies('>=0.12.0')) {
    await Util.asyncForEach(inputs.annotations, async annotation => {
      args.push('--annotation', annotation);
    });
  } else if (inputs.annotations.length > 0) {
    core.warning("Annotations are only supported by buildx >= 0.12.0; the input 'annotations' is ignored.");
  }
  await Util.asyncForEach(inputs['build-args'], async buildArg => {
    args.push('--build-arg', buildArg);
  });
  if (await toolkit.buildx.versionSatisfies('>=0.8.0')) {
    await Util.asyncForEach(inputs['build-contexts'], async buildContext => {
      args.push('--build-context', buildContext);
    });
  } else if (inputs['build-contexts'].length > 0) {
    core.warning("Build contexts are only supported by buildx >= 0.8.0; the input 'build-contexts' is ignored.");
  }
  await Util.asyncForEach(inputs['cache-from'], async cacheFrom => {
    args.push('--cache-from', cacheFrom);
  });
  await Util.asyncForEach(inputs['cache-to'], async cacheTo => {
    args.push('--cache-to', cacheTo);
  });
  if (inputs['cgroup-parent']) {
    args.push('--cgroup-parent', inputs['cgroup-parent']);
  }
  await Util.asyncForEach(inputs['secret-envs'], async secretEnv => {
    try {
      args.push('--secret', Build.resolveSecretEnv(secretEnv));
    } catch (err) {
      core.warning(err.message);
    }
  });
  if (inputs.file) {
    args.push('--file', inputs.file);
  }
  if (!Build.hasLocalExporter(inputs.outputs) && !Build.hasTarExporter(inputs.outputs) && (inputs.platforms.length == 0 || (await toolkit.buildx.versionSatisfies('>=0.4.2')))) {
    args.push('--iidfile', toolkit.buildxBuild.getImageIDFilePath());
  }
  await Util.asyncForEach(inputs.labels, async label => {
    args.push('--label', label);
  });
  await Util.asyncForEach(inputs['no-cache-filters'], async noCacheFilter => {
    args.push('--no-cache-filter', noCacheFilter);
  });
  await Util.asyncForEach(inputs.outputs, async output => {
    args.push('--output', output);
  });
  if (inputs.platforms.length > 0) {
    args.push('--platform', inputs.platforms.join(','));
  }
  if (await toolkit.buildx.versionSatisfies('>=0.10.0')) {
    args.push(...(await getAttestArgs(inputs, toolkit)));
  } else {
    core.warning("Attestations are only supported by buildx >= 0.10.0; the inputs 'attests', 'provenance' and 'sbom' are ignored.");
  }
  await Util.asyncForEach(inputs.secrets, async secret => {
    try {
      args.push('--secret', Build.resolveSecretString(secret));
    } catch (err) {
      core.warning(err.message);
    }
  });
  await Util.asyncForEach(inputs['secret-files'], async secretFile => {
    try {
      args.push('--secret', Build.resolveSecretFile(secretFile));
    } catch (err) {
      core.warning(err.message);
    }
  });
  if (inputs['github-token'] && !Build.hasGitAuthTokenSecret(inputs.secrets) && context.startsWith(Context.gitContext())) {
    args.push('--secret', Build.resolveSecretString(`GIT_AUTH_TOKEN=${inputs['github-token']}`));
  }
  if (inputs['shm-size']) {
    args.push('--shm-size', inputs['shm-size']);
  }
  await Util.asyncForEach(inputs.ssh, async ssh => {
    args.push('--ssh', ssh);
  });
  await Util.asyncForEach(inputs.tags, async tag => {
    args.push('--tag', tag);
  });
  if (inputs.target) {
    args.push('--target', inputs.target);
  }
  await Util.asyncForEach(inputs.ulimit, async ulimit => {
    args.push('--ulimit', ulimit);
  });
  return args;
}

async function getCommonArgs(inputs: Inputs, toolkit: Toolkit): Promise<Array<string>> {
  const args: Array<string> = [];
  if (inputs.load) {
    args.push('--load');
  }
  if (await toolkit.buildx.versionSatisfies('>=0.6.0')) {
    args.push('--metadata-file', toolkit.buildxBuild.getMetadataFilePath());
  }
  if (inputs.network) {
    args.push('--network', inputs.network);
  }
  if (inputs['no-cache']) {
    args.push('--no-cache');
  }
  if (inputs.pull) {
    args.push('--pull');
  }
  if (inputs.push) {
    args.push('--push');
  }
  return args;
}

async function getAttestArgs(inputs: Inputs, toolkit: Toolkit): Promise<Array<string>> {
  const args: Array<string> = [];
  const builder = await toolkit.builder.inspect();

  // check if provenance attestation is set in attests input
  let hasAttestProvenance = false;
  await Util.asyncForEach(inputs.attests, async (attest: string) => {
    if (Build.hasAttestationType('provenance', attest)) {
      hasAttestProvenance = true;
    }
  });

  let provenanceSet = false;
  let sbomSet = false;
  if (inputs.provenance) {
    args.push('--attest', Build.resolveAttestationAttrs(`type=provenance,${inputs.provenance}`));
    provenanceSet = true;
  } else if (!hasAttestProvenance && (await toolkit.buildkit.versionSatisfies(builder.name!, '>=0.11.0')) && !Build.hasDockerExporter(inputs.outputs, inputs.load)) {
    // if provenance not specified in provenance or attests inputs and BuildKit
    // version compatible for attestation, set default provenance. Also needs
    // to make sure user doesn't want to explicitly load the image to docker.
    if (GitHub.context.payload.repository?.private ?? false) {
      // if this is a private repository, we set the default provenance
      // attributes being set in buildx: https://github.com/docker/buildx/blob/fb27e3f919dcbf614d7126b10c2bc2d0b1927eb6/build/build.go#L603
      args.push('--attest', `type=provenance,${Build.resolveProvenanceAttrs(`mode=min,inline-only=true`)}`);
    } else {
      // for a public repository, we set max provenance mode.
      args.push('--attest', `type=provenance,${Build.resolveProvenanceAttrs(`mode=max`)}`);
    }
  }
  if (inputs.sbom) {
    args.push('--attest', Build.resolveAttestationAttrs(`type=sbom,${inputs.sbom}`));
    sbomSet = true;
  }

  // set attests but check if provenance or sbom types already set as
  // provenance and sbom inputs take precedence over attests input.
  await Util.asyncForEach(inputs.attests, async (attest: string) => {
    if (!Build.hasAttestationType('provenance', attest) && !Build.hasAttestationType('sbom', attest)) {
      args.push('--attest', Build.resolveAttestationAttrs(attest));
    } else if (!provenanceSet && Build.hasAttestationType('provenance', attest)) {
      args.push('--attest', Build.resolveProvenanceAttrs(attest));
    } else if (!sbomSet && Build.hasAttestationType('sbom', attest)) {
      args.push('--attest', attest);
    }
  });

  return args;
}

export const tlsClientKeyPath = '/tmp/blacksmith_client_key.pem';
export const tlsClientCaCertificatePath = '/tmp/blacksmith_client_ca_certificate.pem';
export const tlsRootCaCertificatePath = '/tmp/blacksmith_root_ca_certificate.pem';

/**
 * Resolve the platform list that should be passed to `docker buildx create`.
 *
 * Priority:
 *   1. Use the user-supplied platforms list (comma-joined) if provided.
 *   2. Fallback to the architecture of the host runner.
 *
 * The function is exported to allow isolated unit testing.
 */
export function resolveRemoteBuilderPlatforms(platforms?: string[]): string {
  // If user explicitly provided platforms, honour them verbatim.
  if (platforms && platforms.length > 0) {
    return platforms.join(',');
  }

  // Otherwise derive from host architecture.
  const nodeArch = os.arch(); // e.g. 'x64', 'arm64', 'arm'
  const archMap: {[key: string]: string} = {
    x64: 'amd64',
    arm64: 'arm64',
    arm: 'arm'
  };
  const mappedArch = archMap[nodeArch] || nodeArch;
  return `linux/${mappedArch}`;
}

export async function getRemoteBuilderArgs(name: string, builderUrl: string, platforms?: string[]): Promise<Array<string>> {
  const args: Array<string> = ['create', '--name', name, '--driver', 'remote'];

  const platformFlag = resolveRemoteBuilderPlatforms(platforms);
  core.info(`Determined remote builder platform(s): ${platformFlag}`);
  args.push('--platform', platformFlag);

  // Always use the remote builder, overriding whatever has been configured so far.
  args.push('--use');
  // Use the provided builder URL
  args.push(builderUrl);
  return args;
}

export async function getUseBuilderArgs(name: string): Promise<Array<string>> {
  return ['use', name, '--global'];
}
