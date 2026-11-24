'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sleep = require('node:timers/promises').setTimeout;
const route = 'core/src/services/routing/';
const srvc = 'core/src/services/';
const house = 'core/surfaces/household/';
const holder = { host:'http://fixture-primary.invalid', admissionId:'fixture-owner-private-a', generation:'fixture-owner-private-g',
  principal:'fixture-owner-private-p', requestId:'fixture-owner-private-r', state:'ACTIVE', kind:'inference-interactive-stream',
  acquiredAt:new Date(Date.now()-50), expiresAt:new Date(Date.now()+30000), mode:'shared', model:'fixture-owner-other-model' };
const ISSUE = 'agentx.runtime-inference-completion/v1';
const receipt = () => ({ ...holder, contract:ISSUE, coordinationKind:'inference', released:true, releasedAt:new Date() });

function journey({ root, weather, create, drawing, ordinary, ordinaryReply, whenOrdinary, refusal = "active", recovery = "primary", releaseAfter = 0, busy = true } = {}) {
  const calls = [];
  const requests = [], dispatches = [], states = [], speech = [], notices = [], findings = [], db = [];
  let count = 0;
  let preparingRelease = null;
  const mocks = {
    [srvc+'runtimePhysicalResources']:{ overlaps:(row,host)=>row.host===host },
    [srvc+'runtimeDeployGate']:{ fencesHost:()=>false },
    [srvc+'hostControlFence']:{ pausedControl:()=>false },
    [route+'principalAlias']:{ PRINCIPAL_MODEL_ALIAS:'agentx-primary', resolvePrincipalAlias:()=>null },
    [srvc+'images/config']:{ localUrl: url=>String(url) },
    'shared/ollamaHostConfig':{ hostUrlKey:x=>x },
    'shared/failureDiagnostics':{ describeFailure:x=>x },
    [house+'family-clock']:{ familyIdentity:()=>'', familyClockContext:()=>'' },
    [house+'persona-prompt']:{ systemPromptFor:()=>'' },
    [house+'reply-channels']:{ contract:()=>'' },
    [house+'personas.json']:[],
    [house+'public/persona-presentation']:{speechFor:()=>''},
    [srvc+'conversations/turnAccounting']:{ sumUsage:()=>null },
    [srvc+'conversations/relayContext']:{ fingerprint:x=>createHash('sha256').update(x).digest('hex') },
    'core/models/RuntimeCoordination':{ collection: { async findOne(filter, options) {
      db.push({filter,options});
      return preparingRelease?.releasedAt ? {releaseReceipts:[preparingRelease]} : null;
    } } }
  };
  const cache = new Map();
  const load = key => {
    if (Object.hasOwn(mocks,key)) return mocks[key];
    if (key.startsWith('node:')) return require(key);
    if (cache.has(key)) return cache.get(key).exports;
    const filename = path.join(root,key.endsWith('.json') ? key : key+'.js'), m={exports:{}};
    cache.set(key,m);
    vm.runInThisContext('(function(require,module,exports){'+fs.readFileSync(filename,'utf8')+'\n})',{filename})(
      name=>load(name.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(key),name)) : name),m,m.exports);
    return m.exports;
  };
  const {inferenceConflict} = load(srvc+'runtimeInferenceConflict');
  const {createConversationContinuity} = load(route+'conversationContinuity');

  const signal = new AbortController().signal;
  const target = { hostUrl:holder.host, hostKey:'fixtureMain', name:'fixture family', model:'qwen-fixture', contextSize:4096, pinAligned:true };
  const makeRefusal = () => {
    const failure = inferenceConflict({inferences:[refusal === 'quarantine' ? {...holder,state:'UNKNOWN'} : holder]}, {
      host:holder.host, mode:'exclusive', resourceIds:[]
    }, new Date());
    const nested = Object.assign(Error('native fake refusal'), { failure });
    return Object.assign(Error('trusted wrapper fixture'), {
      cause:nested, code: failure.cause==='inference_recovery_required' ? 'RUNTIME_INFERENCE_RECOVERY_REQUIRED' : 'RUNTIME_INFERENCE_ADMISSION_DENIED',
      failure:Object.freeze(structuredClone(failure))
    });
  };
  function localResult(text, model, metadata, tools) {
    return {ok:true, stream:(async function*(){yield JSON.stringify({message:{content:text,...(tools && {tool_calls:tools})}})+'\n'; yield '{"done":true}\n';})(),
      completion:Promise.resolve({completed:true,terminalComplete:true}),metadata:{model,...metadata}};
  }
  const execute = async (request, options) => {
    const text=request.messages.at(-1).content;
    const role=options.hostUrl===holder.host ? 'primary' : 'backup';
    requests.push({text,system:request.messages[0]?.content,role,retry:options.retry});
    if (role==='primary' && text.endsWith(create)) {
      count++;
      if(busy && count===1) {
        if (releaseAfter>=0) setTimeout(()=>{preparingRelease=receipt();},releaseAfter).unref();
        throw makeRefusal();
      }
      if(recovery==='ambiguous') throw Object.assign(Error('provider acknowledgement lost'),{code:'NO_ACK'});
      if(recovery==='unproven-release') throw Object.assign(Error('release acknowledgement unavailable'),{code:'RUNTIME_INFERENCE_ADMISSION_DENIED'});
    }
    dispatches.push({text,role});
    if (text.endsWith(ordinary)) await whenOrdinary?.();
    return localResult(role==='backup' ? 'L’image a été créée. '+drawing : text.endsWith(create) ? drawing : text.endsWith(weather) ? 'Il fait quatre degrés, une mesure fictive.' : text.endsWith(ordinary) ? ordinaryReply : 'Réponse fictive.',request.model,options.conversationContinuity ? {
      routing:options.degraded, conversationContinuity:options.conversationContinuity
    } : {}, null);
  };
  const runContinuity = createConversationContinuity({
    execute, log:{warn(){}},
    observeFamilyOccupation:async()=>false,
    readPolicy:()=>JSON.stringify({hosts:['fixtureGuardian'],models:['agentx-primary']}),
    readSnapshot:async()=>({tasks:{voice_persona_chat:target},hosts:{fixtureGuardian:'http://fixture-backup.invalid'}}),
    deps:{ hostPreferenceService:{getByHost:async()=>({pinnedModels:[{model:'gemma-fixture',contextSize:4096}]})},
      assertHostAvailableForConsumer:async()=>true,
      fetch:async()=>({ok:true,json:async()=>({models:[{name:'gemma-fixture',context_length:4096}]})}),
      modelsMatch:(a,b)=>a===b }
  });
  return {runContinuity, requests, dispatches, db};
}
module.exports={journey};
