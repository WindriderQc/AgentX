'use strict';
// Human page intent is authoritative. Model titles/history never choose a destination.
const fold=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[’'_-]/g,' ').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
const NAV=/\b(?:ouvr(?:e|es|ir|ez)|montr(?:e|es|er|ez)|affich(?:e|es|er|ez)|visite|visiter|open|show|display)\b/;
const PHYSICAL=/\b(?:allume|allumer|eteins|eteindre|deverrouille|deverrouiller|unlock|porte|door|turn on|turn off)\b/;
const CONTEXTUAL=/^(?:oui(?: s il te plait)?|yes(?: please)?|ok(?: vas y)?|d accord|vas y|pourquoi pas(?: tu peux me montrer ca)?|(?:montre|affiche|ouvre)(?: moi)? (?:ca|la|le)|show (?:it|that))(?: merci)?$/;
function direct(text){
 const value=fold(text).replace(/^(?:(?:non|stop)\s+)+/,'');const command=value.match(NAV);if(!command||/^(?:(?:moi|nous|me|it|that)\s+)?(?:pas|jamais|not|never)\b/.test(value.slice(command.index+command[0].length).trim()))return null;
 const prefix=new Set('est ce que tu vous peux pouvez pourrais pourriez pourrait veux veut je j aimerais aimeriez voudrais voudriez me nous te s il plait svp stp hey nestor please can could would you i want to'.split(' '));
 if(value.slice(0,command.index).trim().split(' ').filter(Boolean).some(word=>!prefix.has(word)))return null;
 let id=/\b(?:iss|station (?:spatiale )?internationale|station spatiale)\b/.test(value)?'iss':null;
 const kids=/\b(?:taches?|routines?|missions?|corvees?)\b/.test(value)&&/\b(?:enfants?|kids)\b/.test(value)||/\b(?:salle des enfants|kids room)\b/.test(value);
 const eco=/\b(?:ecosysteme|ecosystem|visite de la maison connectee)\b/.test(value);
 const earth=!id&&/\b(?:terre|earth)\b/.test(value);
 const ids=[id,kids?'kids-tasks':null,eco?'ecosystem':null,earth?'earth':null].filter(Boolean);
 const pageWords=/\b(?:page|site|vue|ecran)\b/.test(value);
 if(!ids.length&&!pageWords)return null;
 const physical=PHYSICAL.test(value)||/\b(?:ouvre|ouvrir)\s+(?:(?:le|la|les|notre|un|une)\s+)?(?:garage|camera|portail|verrou)\b/.test(value);
 // Only a positive navigation grammar can bypass inference. Unknown content
 // stays with the model, including unrecognised second requests.
 const targetWords=ids[0]==='iss'?/\b(?:iss|station|spatiale|internationale|international|space|autour|table|terre)\b/g:ids[0]==='kids-tasks'?/\b(?:taches?|routines?|missions?|corvees?|enfants?|kids|room|salle)\b/g:ids[0]==='ecosystem'?/\b(?:ecosysteme|ecosystem)\b/g:/\b(?:terre|earth)\b/g;
 const allowed=new Set('est ce que tu vous peux pouvez pourrais pourriez pourrait veux veut je j aimerais aimeriez voudrais voudriez me moi nous te s il plait svp stp hey nestor please can could would you i want to ouvre ouvres ouvrir ouvrez montre montres montrer montrez affiche affiches afficher affichez visite visiter open show display la le les l un une du de des d au a pour page pages site vue ecran aujourd hui demain today tomorrow'.split(' '));
 const remaining=value.replace(targetWords,' ');
 const standalone=ids.length===1&&!physical&&String(text).split(/[.!?;\n]/).filter(part=>part.trim()).length<=1&&remaining.trim().split(/\s+/).filter(Boolean).every(word=>allowed.has(word));
 return {id:ids.length===1?ids[0]:null,day:/\b(?:demain|tomorrow)\b/.test(value)?'tomorrow':'today',standalone,ambiguous:ids.length>1};
}
function resolve(text,catalog,rows=[],now=Date.now(),sessionId=null){
 let intent=direct(text),contextual=false;
 if(!intent&&CONTEXTUAL.test(fold(text))){
  for(const row of rows.slice(0,2)){
   if(row.packId!=='kidx_nestor'||row.scopeId!=='family'||sessionId&&row.sessionId!==sessionId)break;
   if((row.safetyFlags||[]).some(flag=>['home_action_requested','private_information','self_harm','abuse_or_threat','immediate_danger'].includes(flag)))break;
   const age=now-Date.parse(row.createdAt);if(!Number.isFinite(age)||age<0||age>120000)break;
   intent=direct(row.inputText);if(intent){if((row.display||[]).some(block=>block.kind==='page'&&catalog.parse(block.body)?.page===intent.id))return null;contextual=true;break;}
   if(!CONTEXTUAL.test(fold(row.inputText)))break;
  }
 }
 if(!intent)return null;
 const body=intent.id+(intent.id==='kids-tasks'?' day='+intent.day:'');
 const target=intent.id&&catalog.parse(body);
 return {...intent,contextual,target:target?catalog.canonical(target):null,title:target?catalog.label(target):'',unavailable:!target};
}
// Remove only an opening verb whose own object is a screen/page. All other
// words still pass through the existing home-action safety classifier.
function safetyText(text){
 return fold(text).replace(/\bouvre\s+(?:(?:moi|nous|aussi|le|la|les|l|un|une|cette|ce)\s+)*(?:page|site|vue|ecran|iss|station spatiale|station internationale)\b/g,match=>match.replace(/^ouvre\b/,''));
}
async function forTurn(text,catalog,conversations,session){
 const rows=!direct(text)&&CONTEXTUAL.test(fold(text))?await conversations.listTurns({sessionId:session.sessionId,packId:session.packId,scopeId:session.scopeId},{sort:{createdAt:-1},limit:2}):[];
 return resolve(text,catalog,rows,Date.now(),session.sessionId);
}
function directive(intent){
 if(!intent)return 'No family page was requested on this turn. Do not open an unsolicited page.';
 return intent.target?'The requested family destination is '+JSON.stringify(intent.target)+'. Its catalogue label is '+JSON.stringify(intent.title)+'. Present that destination only. Do not substitute an ecosystem tour, ask for another confirmation or describe a physical action. Answer any additional requested question normally. A page proposal is not proof of loading.':'No configured family destination matches this request. Say it is unavailable and open no other page. Never substitute the ecosystem tour.';
}
async function ensure(intent,display,visuals,event,language='fr'){
 if(!intent?.target||display.some(row=>row.kind==='page'))return display;
 const shown=await visuals.present({id:'b'+(display.length+1),kind:'page',title:intent.title,body:intent.target},{family:true,language});
 event('show',{block:shown});return [...display,shown];
}
async function reply(intent,visuals,event,language='fr'){
 return {replyText:intent.target?(language==='en'?'Opening ':'J’ouvre ')+intent.title+'.':language==='en'?'That page is not available in this space.':'Cette page n’est pas disponible dans cet espace.',display:await ensure(intent,[],visuals,event,language)};
}
const hasScreenOpening=text=>safetyText(text)!==fold(text);
// Preserve every original safety decision except the home-action word removed
// from an explicit screen opening. No caller-controlled permission or new grant.
function navigationSafety(text,safety,assess){
 if(!hasScreenOpening(text)||assess(safetyText(text)).flagIds.includes('home_action_requested'))return safety;
 return {...safety,flags:safety.flags.filter(flag=>flag.id!=='home_action_requested'),flagIds:safety.flagIds.filter(flag=>flag!=='home_action_requested')};
}
module.exports={resolve,forTurn,directive,ensure,reply,safetyText,hasScreenOpening,navigationSafety};
