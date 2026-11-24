'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const base = path.join(__dirname,'../public');
const source = fs.readFileSync(path.join(base,'avatar-dock.js'),'utf8');
const css = fs.readFileSync(path.join(base,'avatar-dock.css'),'utf8');

class FixtureEvent extends Event {
  constructor(type, options) {super(type,{cancelable:true});this.detail=options?.detail;}
}
function rig(width, space='family') {
  const intervals = new Map();
  const now = { time: 0 }, root = new EventTarget(), doc = new EventTarget();
  let handle = 0, transparent = false;
  class El extends EventTarget {
    constructor(tag) {super();this.tagName=tag.toUpperCase();}
    dataset = {}; style = {setProperty() {}}; attrs = {}; children = []; parentElement = null; value = ''; hidden = false;
    classList = {toggle(){},remove(){}};
    get isConnected(){return this===doc.body || !!this.parentElement?.isConnected;}
    focus(){doc.activeElement=this;}
    blur(){doc.activeElement=doc.body;}
    setAttribute(k,v){this.attrs[k]=v;}
    getAttribute(k){return this.attrs[k]??null;}
    append(...items){for(const v of items){v.remove(); v.parentElement=this; this.children.push(v);}}
    remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(v=>v!==this); this.parentElement=null;}}
    click(){this.dispatchEvent(new Event('click'));}
    querySelector(k){return this.sub?.get(k) || null;}
    querySelectorAll(k){return k==='[data-mode]' ? [...this.sub.values()].filter(n=>n.dataset.mode) : [];}
    closest(k){return /input|textarea/.test(k) && ['INPUT','TEXTAREA','SELECT'].includes(this.tagName) ? this : null;}
    set innerHTML(v){
      this.sub=new Map();
      const add=(selector,tag)=>{const e=new El(tag);this.sub.set(selector,e);this.append(e);return e;};
      if(v.includes('avatar-dock-stage')) {
        add('.avatar-dock-stage','div'); add('.avatar-dock-orb','div'); add('.avatar-dock-bar','div');
        for(const m of v.matchAll(/data-mode="([^"]+)"/g)){const e=add('[data-mode='+m[1]+']','button');e.dataset.mode=m[1];}
      } else if(v.includes('avatar-scene-status')) {
        add('.avatar-scene-status','p'); add('.avatar-scene-reply','p'); add('[data-scene=close]','button');
        add('#avatarSceneMessage','input'); add('.avatar-scene-actions','div'); add('.avatar-scene-input','form');
      } else {
        add('.avatar-scene-time','time'); add('.avatar-scene-date','span');
      }
    }
  }
  doc.body=new El('body'); doc.activeElement=doc.body;
  doc.hasFocus=()=>!transparent;
  doc.createElement=tag=>new El(tag);
  const composer=new El('textarea'), frame=new El('iframe'), heading=new El('header');
  doc.body.append(composer,heading,frame);
  doc.getElementById=k=>k==='conversationMessage' ? composer : null;
  const flags={ photos:false, hover:false, busy:false, page:false };
  doc.querySelector=k=> ({
    '.conversation-heading':heading,'.page-presentation.is-active':flags.page?frame:null,
    '.nestor-idle-photos:not([hidden])':flags.photos?frame:null,
    'iframe:hover, .nestor-ambient-visit:not([hidden])':flags.hover?frame:null,
    '[data-conversation-busy="true"]':flags.busy?frame:null
  })[k] || null;
  doc.querySelectorAll=()=>[];
  root.document=doc;
  root.customElements={get:()=>true};
  root.matchMedia=query=>({matches:query==='(max-width: 700px)' && width<=700});
  root.performance={now:()=>now.time};
  root.localStorage={getItem:()=>null,setItem(){}};
  const track=(fn,ms)=>{const id=++handle;intervals.set(id,{fn,ms});return id;};
  vm.runInNewContext(source,{window:root, Event, Intl, Date, AbortController, CustomEvent:FixtureEvent,
    setInterval:track, clearInterval:id=>intervals.delete(id), setTimeout:()=>++handle, clearTimeout:()=>{}},{filename:'avatar-dock.js'});
  let sends=0;
  const app=root.AvatarDock.mount({space,idleReturnMs:2000,nowMs:()=>now.time,onTap:()=>false,onSend:()=>{sends++;}});
  const button=doc.body.children.find(n=>n.className==='avatar-return-full');
  const dock=doc.body.children.find(n=>n.className==='avatar-dock'), stage=dock.querySelector('.avatar-dock-stage');
  const tick=ms=>{now.time+=ms; for(const {fn,ms:period} of intervals.values()) if(period===1000) fn();};
  const activity=kind=>root.dispatchEvent(new FixtureEvent('persona-activity',{detail:{kind,space}}));
  const presence=(state,sample)=>root.dispatchEvent(new FixtureEvent('persona-presence',{detail:{state,space,sample}}));
  const motionTick=()=>{for(const {fn,ms} of intervals.values()) if(ms===50) fn();};
  const key=(target,props={})=>{
    const event=new Event('keydown',{cancelable:true});
    for(const [k,v] of Object.entries({key:'n',ctrlKey:true,altKey:true,...props})) Object.defineProperty(event,k,{value:v});
    Object.defineProperty(event,'target',{value:target});
    doc.dispatchEvent(event);return event.defaultPrevented;
  };
  return {app,flags,button,stage,dock,frame,composer,heading,tick,motionTick,activity,presence,key,doc,get sends(){return sends;}, blur(){transparent=true;}, focus(){transparent=false;}};
}

for (const width of [390,1280]) test('actual mounted module via synthetic document, width '+width,()=>{
  const r=rig(width);
  assert.equal(r.app.view,'plein');
  r.stage.click(); assert.equal(r.app.view,'menu');
  if(width<700) assert.equal(r.dock.parentElement,r.heading); else assert.equal(r.dock.parentElement,r.doc.body);
  assert.equal(r.button.textContent,'Avatar plein écran');
  assert.equal(r.button.getAttribute('aria-keyshortcuts'),'Control+Alt+N');
  assert.equal(r.button.hidden,false);
  r.button.click(); assert.equal(r.app.view,'plein'); assert.equal(r.doc.activeElement,r.stage);
  r.activity('show'); assert.equal(r.app.view,'montre');
  r.button.click(); assert.equal(r.app.view,'plein'); assert.equal(r.frame.isConnected,true);
  r.stage.click();r.stage.click();assert.equal(r.app.view,'montre','same content remains available by tap');
  assert.equal(r.key(r.doc.body,{key:'Escape'}),false);
  assert.equal(r.key(r.doc.body),true); assert.equal(r.app.view,'plein');
  r.stage.click();
  r.composer.value='draft'; r.composer.focus();
  assert.equal(r.key(r.composer),false); r.tick(3000); assert.equal(r.app.view,'menu'); assert.equal(r.composer.value,'draft');
  r.composer.value='';r.composer.blur(); r.doc.dispatchEvent(new Event('input')); r.tick(2100); assert.equal(r.app.view,'plein');
  for(const [protect,release] of [
    [()=>r.presence('speaking'),()=>r.presence('listening')],
    [()=>r.frame.focus(),()=>r.frame.blur()],
    [()=>{r.flags.hover=true;},()=>{r.flags.hover=false;}],
    [()=>{r.flags.photos=true;},()=>{r.flags.photos=false;}],
    [()=>r.doc.dispatchEvent(new Event('compositionstart')),()=>r.doc.dispatchEvent(new Event('compositionend'))],
    [()=>{r.flags.busy=true;},()=>{r.flags.busy=false;}],
    [()=>r.blur(),()=>r.focus()]
  ]) {
    r.stage.click(); protect(); r.tick(3000); assert.equal(r.app.view,'menu');
    release(); r.tick(2100); assert.equal(r.app.view,'plein');
  }
  r.stage.click();r.app.setMode('quart');r.tick(5000); assert.equal(r.app.mode,'quart');
  r.button.click(); assert.equal(r.app.view,'plein');
  r.app.setMode('cache'); assert.equal(r.button.hidden,false);
  r.button.click(); assert.equal(r.app.view,'plein');
  assert.equal(r.sends,0);
  r.app.dispose();assert.equal(r.button.isConnected,false);
});
test('same control and app viewport contract on Perso; renderer CSS, not measured pixels',()=>{
  const r=rig(1280,'personal'); r.stage.click();assert.equal(r.button.textContent,'Avatar plein écran');
  r.button.click();assert.equal(r.app.view,'plein');r.app.dispose();
  assert.match(css,/avatar-dock\[data-view=plein\][^}]*width: 100vw; height: 100dvh/);
  assert.match(css,/\.avatar-return-full \{[^}]*min-height: 44px/);
  assert.ok(css.includes('body:has(.nestor-idle-photos:not([hidden])) .avatar-return-full'));
});

for (const width of [390,1280]) test('late wake sleep retains content, preserves sleeping face, and only app idle returns, '+width,()=>{
  const r=rig(width);
  let asleep=false;
  r.presence('listening',{asleep:()=>asleep});
  r.activity('show');
  r.motionTick();
  r.tick(100);
  r.doc.dispatchEvent(new Event('pointermove'));
  asleep=true;
  r.motionTick();
  assert.equal(r.app.view,'montre','voice inactivity cannot interrupt recent visual activity');
  assert.equal(r.dock.querySelector('.avatar-dock-orb').dataset.phase,'sleeping','voice face keeps its sleeping phase');
  r.tick(1900);
  assert.equal(r.app.view,'montre');
  r.tick(200);
  assert.equal(r.app.view,'plein','only elapsed app-idle timer causes the automatic return');
  r.stage.click(); r.stage.click();
  assert.equal(r.app.view,'montre','the displayed content was not cleared by auto-return');
  r.flags.photos=true; r.tick(2100);
  assert.equal(r.app.view,'montre'); assert.equal(r.button.hidden,true);
  assert.equal(r.key(r.doc.body),false,'avatar shortcut does not compete with the photo frame’s own controls');
  r.flags.photos=false; r.tick(1);
  assert.equal(r.key(r.doc.body,{repeat:true}),false);
  assert.equal(r.key(r.doc.body,{isComposing:true}),false);
  assert.equal(r.key(r.doc.body),true);
  assert.equal(r.app.view,'plein');
  assert.equal(r.key(r.doc.body),false,'repeating after return cannot toggle the app back out of fullscreen');
  r.app.dispose();
});
