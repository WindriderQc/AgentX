/* Bounded text-only repair collection. No device, transport or permission ownership. */
(function(root){
  'use strict';
  const QUIET_MS=700,MAX_WAIT_MS=5000,CARRY_MS=30000,MAX_FRAGMENTS=4,MAX_CHARS=800;
  const normalize=text=>String(text||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[’']/g,' ').replace(/[^a-z0-9\s-]/g,' ').replace(/\s+/g,' ').trim();
  const affirmative=text=>/^(oui|non|ouais|yes|no|ok|d accord|c est ca)$/.test(normalize(text));
  const repairCue=text=>/^(non(?:\s+non)+\b|no(?:\s+no)+\b|(?:non|no)\s+(?:je|c est|pas|i|not)\b|je voulais\b|je veux dire\b|i meant\b|plutot\b|(?:stop|arrete|attends|wait)\s+\S)/.test(normalize(text));
  class VoiceRepair {
    constructor(conversation,isEcho){this.c=conversation;this.isEcho=isEcho;this.pending=null;this.carry=null;}
    reset(){const p=this.pending;this.pending=null;clearTimeout(p?.quiet);clearTimeout(p?.deadline);p?.resolve(null);clearTimeout(this.carryTimer);this.carry=null;}
    speech(epoch){const p=this.pending;if(p&&p.epoch===epoch){p.hearing=true;clearTimeout(p.quiet);}}
    valid(p){return this.pending===p&&this.c.current(p.epoch)&&this.c.audio===p.audio;}
    listen(p){if(!this.valid(p))return;this.c.activeTurn=null;this.c.turnPending=false;this.c.listen(p.epoch,this.c.selection?.language==='en'?'I’m listening to your correction.':'Je t’écoute pour la correction.');}
    evidence(p,turn){
      const id=turn.timeline?.recognition?.recognitionId;if(id&&!p.ids.includes(id))p.ids.push(id);
      if(p.owner.timeline){p.owner.timeline.repairFragments=p.parts.length;p.owner.timeline.repairRecognitionIds=p.ids.slice(0,MAX_FRAGMENTS);}
    }
    arm(p){clearTimeout(p.quiet);p.hearing=false;p.quiet=setTimeout(()=>this.flush(p),QUIET_MS);}
    flush(p){
      if(!this.valid(p)||p.hearing)return;
      this.pending=null;clearTimeout(p.quiet);clearTimeout(p.deadline);this.c.audio.quiet();p.resolve(p.parts.join(' '));
    }
    expire(p){
      if(!this.valid(p))return;
      if(!p.hearing){this.flush(p);return;}
      this.pending=null;clearTimeout(p.quiet);clearTimeout(p.deadline);
      this.carry={parts:p.parts,ids:p.ids,epoch:p.epoch,echo:p.echo};p.resolve(null);
      this.carryTimer=setTimeout(()=>{this.carry=null;},CARRY_MS);
    }
    collect(text,turn,epoch,echo=''){
      let p=this.pending;
      if(p&&!this.valid(p)){this.reset();p=null;}
      if(this.carry&&this.carry.epoch!==epoch)this.reset();
      if(!p&&this.carry){
        const carry=this.carry;
        if(this.isEcho?.(text,carry.echo)){this.c.listen(epoch);return null;}
        clearTimeout(this.carryTimer);this.carry=null;
        const parts=[...carry.parts,text],joined=parts.join(' ');
        if(parts.length<=MAX_FRAGMENTS&&joined.length<=MAX_CHARS){const joinedTurn={parts,ids:carry.ids,owner:turn};this.evidence(joinedTurn,turn);return joined;}
        return text; // preserve the whole newest phrase; never silently truncate it.
      }
      if(p){
        if(this.isEcho?.(text,p.echo)){this.listen(p);this.arm(p);return null;}
        const joined=[...p.parts,text];
        if(joined.length>MAX_FRAGMENTS||joined.join(' ').length>MAX_CHARS){this.reset();return text;}
        p.parts=joined;this.evidence(p,turn);this.listen(p);this.arm(p);
        if(affirmative(text)||p.parts.length===MAX_FRAGMENTS)this.flush(p);
        return null;
      }
      if(!repairCue(text)||text.length>MAX_CHARS)return text;
      return new Promise(resolve=>{
        p={parts:[text],ids:[],owner:turn,epoch,audio:this.c.audio,echo:String(echo||'').slice(-800),resolve,hearing:false};this.pending=p;
        this.evidence(p,turn);this.listen(p);this.arm(p);p.deadline=setTimeout(()=>this.expire(p),MAX_WAIT_MS);
      });
    }
  }
  const api={VoiceRepair,repairCue,affirmative,normalize,QUIET_MS,MAX_WAIT_MS,CARRY_MS,MAX_FRAGMENTS,MAX_CHARS};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.AgentXVoiceRepair=api;
})(typeof window==='undefined'?globalThis:window);
