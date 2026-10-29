import { CloudFormationClient, DescribeStacksCommand, CreateStackCommand, UpdateStackCommand, waitUntilStackCreateComplete, waitUntilStackUpdateComplete } from '@aws-sdk/client-cloudformation';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import webpush from 'web-push';
import { mkdir, readFile, writeFile, copyFile, chmod, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { template as baseTemplate, artifactTemplate } from './cloudformation.mjs';
import {addCommunityInfrastructure} from './community-infrastructure.mjs';
const template=addCommunityInfrastructure(baseTemplate);
const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const privateDir = process.env.SAME_END_DEPLOY_STATE_DIR ? path.resolve(process.env.SAME_END_DEPLOY_STATE_DIR) : path.resolve(here, '../../work/same-end-social');
const stackName = process.env.SAME_END_STACK || 'same-end-social-v1';
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'eu-west-1';
if (!/^same-end-social-[a-z0-9-]{1,60}$/.test(stackName)) throw new Error('Use a dedicated same-end-social stack name');

export function updateParameters(body, previousStack, parameters = []) {
  const existing = new Set((previousStack.Parameters || []).map(p => p.ParameterKey));
  const defined = new Set(Object.keys(body.Parameters || {}));
  const supplied = new Map(parameters.filter(p => defined.has(p.ParameterKey)).map(p => [p.ParameterKey, p]));
  // An update is never an implicit VAPID rotation. The service's current values
  // also remain usable if local private deployment state was lost.
  for (const key of ['VapidPublicKey', 'VapidPrivateKey']) if (existing.has(key) && defined.has(key)) supplied.delete(key);
  for (const key of existing) if (defined.has(key) && !supplied.has(key)) supplied.set(key, {ParameterKey: key, UsePreviousValue: true});
  return [...supplied.values()];
}
async function findStack(cf, name) {
  try { return (await cf.send(new DescribeStacksCommand({StackName: name}))).Stacks[0]; }
  catch (e) { if (e.name === 'ValidationError' && /does not exist/i.test(e.message || '')) return null; throw e; }
}
async function applyStack(cf, name, body, parameters = []) {
  const previous = await findStack(cf, name);
  const input = {StackName: name, TemplateBody: JSON.stringify(body), Parameters: previous ? updateParameters(body, previous, parameters) : parameters, Capabilities: ['CAPABILITY_IAM'], Tags: [{Key: 'Project', Value: 'same-end-social'}]};
  if (previous) {
    try { await cf.send(new UpdateStackCommand(input)); }
    catch (e) { if (e.name === 'ValidationError' && e.message?.includes('No updates are to be performed')) return (await cf.send(new DescribeStacksCommand({StackName: name}))).Stacks[0]; throw e; }
    await waitUntilStackUpdateComplete({client: cf, maxWaitTime: 900, minDelay: 5, maxDelay: 15}, {StackName: name});
  } else {
    await cf.send(new CreateStackCommand({...input, OnFailure: 'ROLLBACK'}));
    await waitUntilStackCreateComplete({client: cf, maxWaitTime: 900, minDelay: 5, maxDelay: 15}, {StackName: name});
  }
  return (await cf.send(new DescribeStacksCommand({StackName: name}))).Stacks[0];
}
async function main() {
  await mkdir(privateDir, {recursive: true, mode: 0o700}); await chmod(privateDir, 0o700);
  const stateFile = path.join(privateDir, 'deployment.json');
  let state;
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; state = {v: 1, stackName, region}; }
  if (state.stackName !== stackName || state.region !== region) throw new Error('Private deployment state belongs to a different stack or region');
  await writeFile(stateFile, JSON.stringify(state, null, 2), {mode: 0o600}); await chmod(stateFile, 0o600);
  const staging = path.join(privateDir, 'package'); await rm(staging, {recursive: true, force: true}); await mkdir(staging, {mode: 0o700});
  for (const name of ['index.mjs', 'api.mjs', 'coordinator.mjs', 'edge-turn.mjs', 'community-api.mjs', 'analytics.mjs', 'store.mjs', 'push.mjs', 'reminders.mjs', 'package.json', 'package-lock.json']) await copyFile(path.join(here, name), path.join(staging, name));
  await exec('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {cwd: staging, maxBuffer: 1024 * 1024});
  const zip = path.join(privateDir, 'control.zip'); await rm(zip, {force: true});
  await exec('/usr/bin/zip', ['-qr', zip, '.'], {cwd: staging, maxBuffer: 1024 * 1024});
  await chmod(zip, 0o600);
  await writeFile(path.join(privateDir, 'cloudformation-review.json'), JSON.stringify(template, null, 2), {mode: 0o600});
  if (process.argv.includes('--prepare-only')) { console.log(JSON.stringify({stackStatus: 'PREPARED'})); return; }
  const cf = new CloudFormationClient({region});
  const previousMain = await findStack(cf, stackName);
  if (!previousMain && !state.vapid) { state.vapid = webpush.generateVAPIDKeys(); await writeFile(stateFile, JSON.stringify(state, null, 2), {mode: 0o600}); await chmod(stateFile, 0o600); }
  const artifactStack = await applyStack(cf, `${stackName}-artifacts`, artifactTemplate);
  const bucket = artifactStack.Outputs.find(o => o.OutputKey === 'Bucket').OutputValue;
  const body = await readFile(zip), key = `control/${createHash('sha256').update(body).digest('hex')}.zip`;
  await new S3Client({region}).send(new PutObjectCommand({Bucket: bucket, Key: key, Body: body, ServerSideEncryption: 'AES256', ContentType: 'application/zip'}));
  const parameters = Object.entries({ArtifactBucket: bucket, ArtifactKey: key, ...(state.vapid && {VapidPublicKey: state.vapid.publicKey, VapidPrivateKey: state.vapid.privateKey})}).map(([ParameterKey, ParameterValue]) => ({ParameterKey, ParameterValue}));
  const deployed = await applyStack(cf, stackName, template, parameters);
  state.apiBase = deployed.Outputs.find(o => o.OutputKey === 'ApiBase').OutputValue;
  state.staff=Object.fromEntries(deployed.Outputs.filter(o=>o.OutputKey.startsWith('Staff')).map(o=>[o.OutputKey,o.OutputValue]));
  state.fan=Object.fromEntries(deployed.Outputs.filter(o=>o.OutputKey.startsWith('Fan')).map(o=>[o.OutputKey,o.OutputValue]));
  state.deployedAt = new Date().toISOString(); await writeFile(stateFile, JSON.stringify(state, null, 2), {mode: 0o600});
  await writeFile(path.join(privateDir, 'public-config.json'), JSON.stringify({apiBase: state.apiBase}, null, 2), {mode: 0o600});
  console.log(JSON.stringify({apiBase: state.apiBase, stackStatus: deployed.StackStatus}));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({stackStatus: 'FAILED', errorCode: /^[A-Za-z0-9]+$/.test(error.name || '') ? error.name : 'DeploymentError'})); process.exitCode = 1; });
