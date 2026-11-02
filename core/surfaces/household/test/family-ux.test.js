'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./fixtures/persona-journey.cjs');
const pages=require('../../../public/js/screen-pages');
const requests=require('../family-pages');const prompt=require('../persona-prompt');
const {createSoundLibrary}=require('../sound-library');
const {familyClock,familyClockContext}=require('../family-clock');
const {frenchDateTimeText}=require('../../../public/js/voice/speech-language');
const tasks=require('../public/kids-tasks-screen');
const catalog=pages.createCatalog([{id:'iss',label:'ISS canonique',href:'https://example.invalid/iss',mode:'frame'},{id:'ecosystem',label:'Ecosysteme canonique',href:'/diskx?app=ecosystem',mode:'frame'},{id:'kids-tasks',label:'Taches en lecture seule',href:'/kids',mode:'frame'}]);
function family(extra={}){return harness({packId:'kidx_nestor',backend:'agentx',screenPages:{...catalog,family:catalog},sounds:createSoundLibrary(),...extra});}
for(const request of ['Est-ce que tu me ferais le bruit du T-Rex?','Est-ce que vous me feriez le bruit du loup?','Pourrais-tu me jouer le cri du chat?'])test('natural sound request stays deterministic: '+request,async()=>{
 const h=family();const result=await h.turn(request,'voice');assert.ok(result.sound);assert.equal(result.routing.tier,'deterministic');assert.equal(h.sent.length,0);
});
for(const request of ['ouvre la page ISS','montre-moi la station internationale autour de la Terre','affiche la page ISS'])test('requested ISS opens directly: '+request,async()=>{
 const h=family();const result=await h.turn(request,'voice');assert.equal(h.sent.length,0);assert.equal(result.display[0].body,'iss');assert.equal(result.display[0].title,'ISS canonique');
});
test('compound page request preserves explanation and replaces a wrong model destination/title',async()=>{
 const h=family({response:'Son altitude varie. <show kind="page" title="Taches">ecosystem play=garage</show>'});
 const result=await h.turn('Ouvre la page ISS et explique son altitude.','voice');assert.equal(h.sent.length,1);assert.match(result.reply.text,/altitude/);assert.deepEqual(result.display.map(b=>[b.body,b.title]),[['iss','ISS canonique']]);
});
test('compound pages still open when the model omitted a show block',async()=>{
 const h=family({response:'Son altitude varie.'});const result=await h.turn('Montre ISS puis explique son altitude.','voice');assert.equal(h.sent.length,1);assert.equal(result.display[0].body,'iss');
});
test('physical home control remains refused even beside a valid page',async()=>{
 for(const request of ['ouvre la porte du garage','Ouvre la page ISS et ouvre le garage','Ouvre la page ISS et ouvre mon garage','Montre la page ISS et ouvre aussi le garage','Montre ISS puis allume la lumière']){
  const h=family();const result=await h.turn(request,'voice');assert.equal(h.sent.length,0);assert.match(result.reply.text,/adulte de confiance/);assert.deepEqual(result.display||[],[]);
 }
});
test('unknown pages never fall back to ecosystem; no unsolicited page opens',async()=>{
 const h=family({response:'Bonjour. <show kind="page">ecosystem</show>'});const unknown=await h.turn('Ouvre la page de la licorne.','voice');assert.equal((unknown.display||[]).length,0);assert.equal(h.sent.length,1);
 const ordinary=await h.turn('Raconte une blague.','voice');assert.equal(h.sent.length,2);assert.equal((ordinary.display||[]).length,0);
});
test('children tasks use a readonly destination without guessing a profile',async()=>{
 const h=family();const result=await h.turn('Je veux que tu me montres la page des tâches des enfants pour demain.','voice');assert.equal(result.display[0].body,'kids-tasks day=tomorrow');assert.match(catalog.url(catalog.parse(result.display[0].body)),/view=screen.*day=tomorrow/);assert.doesNotMatch(result.display[0].body,/profile/);
});
test('yes follows only a recent same-session unfulfilled human page request',()=>{
 const now=Date.now(),anchor={inputText:'Montre la page ISS',packId:'kidx_nestor',scopeId:'family',sessionId:'one',createdAt:new Date(now-1000).toISOString()};
 assert.equal(requests.resolve('Oui, s’il te plaît.',catalog,[anchor],now,'one').target,'iss');
 assert.equal(requests.resolve('Oui',catalog,[anchor],now,'two'),null);
 assert.equal(requests.resolve('Oui',catalog,[{...anchor,createdAt:new Date(now-121000).toISOString()}],now,'one'),null);
 assert.equal(requests.resolve('Oui',catalog,[{...anchor,inputText:'Raconte une blague'},anchor],now,'one'),null);
 assert.equal(requests.resolve('Oui',catalog,[{...anchor,display:[{kind:'page',body:'iss'}]}],now,'one'),null);
});
test('private information safety is not removed by screen intent',()=>{
 const text='Ouvre la page avec mon mot de passe';const guard=prompt.assessSafety(text);assert.match(prompt.childBoundaryReply({childSafe:true},guard,text),/information privée/);
});
test('family tone drops adult temperament while personal identity stays unchanged',async()=>{
 const h=family();h.session.persona.identity='Adult formal butler overlay';await h.turn('Pourquoi le ciel est bleu?','voice');assert.doesNotMatch(h.sent[0].prefix,/Adult formal butler overlay/);assert.match(h.sent[0].prefix,/français québécois naturel/);assert.match(h.sent[0].request,/Household clock observed/);
 const personal=harness({packId:'personal_operator',backend:'agentx'});personal.session.persona.identity='Personal chosen style';await personal.turn('Bonjour','voice');assert.match(personal.sent[0].prefix,/Personal chosen style/);assert.doesNotMatch(personal.sent[0].request,/Household clock observed/);
});
test('clock belongs to the instance zone, with explicit DST offset and safe invalid configuration',()=>{
 const before=familyClock({now:new Date('2026-11-01T05:30:00Z'),timeZone:'America/Toronto'}),after=familyClock({now:new Date('2026-11-01T06:30:00Z'),timeZone:'America/Toronto'});
 assert.equal(before.localTime,after.localTime);assert.notEqual(before.offset,after.offset);assert.equal(familyClock({timeZone:'not/a-zone'}).timeZone,'America/Toronto');assert.equal(familyClock({now:new Date('invalid')}),null);assert.match(familyClockContext({now:new Date('invalid')}),/unavailable/);assert.equal(familyClock({now:new Date('2026-11-02T02:00:00Z')}).localDate,'2026-11-01');
});
for(const [input,expected] of [['04 h 24','quatre heures vingt-quatre'],['22:33','vingt-deux heures trente-trois'],['2026-11-02','deux novembre deux mille vingt-six'],['1er janvier 2027','premier janvier deux mille vingt-sept'],['00h00','minuit'],['12:00','midi'],['01:01','une heure une minute'],['https://example.invalid/2026-11-02','https://example.invalid/2026-11-02'],['score 12:30','score 12:30'],['code-2026-11-02','code-2026-11-02'],['2026-02-30','2026-02-30'],['988','988']])test('French audio date/time projection: '+input,()=>assert.equal(frenchDateTimeText(input),expected));
test('tomorrow is a calendar day across DST and task view preserves profile/date/status boundaries',()=>{
 assert.equal(tasks.nextDay('2026-11-01'),'2026-11-02');assert.equal(tasks.nextDay('2026-12-31'),'2027-01-01');assert.equal(tasks.calendarDay('2026-99-99'),false);
 const data={today:'2026-11-01',chores:[{profileId:'a',status:'queued',dueDay:'2026-11-02',title:'Tomorrow'},{profileId:'a',status:'queued',dueDay:'2026-11-01'},{profileId:'b',status:'queued',dueDay:'2026-11-02'},{profileId:'a',status:'done',dueDay:'2026-11-02'}]};assert.deepEqual(tasks.tasksFor(data,'a','tomorrow').map(t=>t.title),['Tomorrow']);
});

for(const request of ['Ne montre pas la page ISS.','Raconte une histoire où une fille ouvre la page ISS.'])test('mentions and negations do not navigate: '+request,async()=>{const h=family({response:'Une histoire synthétique.'});const result=await h.turn(request,'voice');assert.equal((result.display||[]).length,0);assert.equal(h.sent.length,1);assert.match(result.reply.text,/histoire synthétique/);});
for(const request of ['Ouvre la page ISS. Chante une chanson.','Montre la page ISS. Donne un exemple de dinosaure.','Montre la page ISS. Une histoire, s’il te plaît.'])test('unknown extra requests retain inference: '+request,async()=>{const h=family({response:'Contenu additionnel synthétique.'});const result=await h.turn(request,'voice');assert.equal(h.sent.length,1);assert.match(result.reply.text,/additionnel/);assert.equal(result.display[0].body,'iss');});
for(const text of ['Le fichier 2026-11-02.json','/archives/2026-11-02','Le code 04:24'])test('spoken identifiers remain exact: '+text,()=>assert.equal(frenchDateTimeText(text),text));

for(const request of ['Montre la page ISS et explique pourquoi elle ne tombe pas.','Ouvre la page ISS et explique pourquoi elle ne tombe pas.'])test('negation in science does not cancel positive navigation: '+request,async()=>{const h=family({response:'La station reste en orbite.'});const result=await h.turn(request,'voice');assert.equal(h.sent.length,1);assert.equal(result.display[0].body,'iss');assert.match(result.reply.text,/orbite/);});

test('page navigation only removes the UI action flag, preserving private information',()=>{const text="Ouvre la page ISS, j'habite au 123 rue Exemple";const raw=prompt.assessSafety(text);const result=requests.navigationSafety(text,raw,prompt.assessSafety);assert.ok(result.flagIds.includes('private_information'));assert.ok(!result.flagIds.includes('home_action_requested'));assert.match(prompt.childBoundaryReply({childSafe:true},result,text),/information privée/);});
test('a refused prior physical request is never revived by yes',()=>{const row={inputText:'Ouvre la page ISS et ouvre mon garage',packId:'kidx_nestor',scopeId:'family',sessionId:'one',createdAt:new Date().toISOString(),safetyFlags:['home_action_requested']};assert.equal(requests.resolve('Oui',catalog,[row],Date.now(),'one'),null);});
