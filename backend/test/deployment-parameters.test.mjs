import test from 'node:test';
import assert from 'node:assert/strict';
import {updateParameters} from '../deploy.mjs';
import {template as base} from '../cloudformation.mjs';
import {addCommunityInfrastructure} from '../community-infrastructure.mjs';
const body=addCommunityInfrastructure(base);
const params=keys=>({Parameters:keys.map(ParameterKey=>({ParameterKey,ParameterValue:'masked'}))});
test('update retains previous credentials and existing optional configuration without reading secret values',()=>{
 const prior=['ArtifactBucket','ArtifactKey','VapidPublicKey','VapidPrivateKey','EdgeTurnSecret','EdgeTurnHealthSecret','EdgeTurnUrls','EdgeTurnUplinkMbps','EdgeTurnAllocationLimit'];
 const supplied=[{ParameterKey:'ArtifactBucket',ParameterValue:'new-bucket'},{ParameterKey:'ArtifactKey',ParameterValue:'new-key'},{ParameterKey:'VapidPublicKey',ParameterValue:'wrong-local-key'},{ParameterKey:'VapidPrivateKey',ParameterValue:'wrong-local-secret'}];
 const result=updateParameters(body,params(prior),supplied), byKey=Object.fromEntries(result.map(p=>[p.ParameterKey,p]));
 assert.deepEqual(byKey.ArtifactKey,{ParameterKey:'ArtifactKey',ParameterValue:'new-key'});
 for(const key of prior.filter(k=>!['ArtifactBucket','ArtifactKey'].includes(k))) assert.deepEqual(byKey[key],{ParameterKey:key,UsePreviousValue:true});
 assert.ok(!JSON.stringify(result).includes('wrong-local'));
});
test('new parameters use defaults rather than nonexistent previous values',()=>{
 const result=updateParameters(body,params(['ArtifactBucket','ArtifactKey','VapidPublicKey','VapidPrivateKey']),[{ParameterKey:'ArtifactKey',ParameterValue:'new-key'}]);
 assert.ok(!result.some(p=>p.ParameterKey.startsWith('EdgeTurn')));
 assert.deepEqual(result.find(p=>p.ParameterKey==='VapidPrivateKey'),{ParameterKey:'VapidPrivateKey',UsePreviousValue:true});
});
