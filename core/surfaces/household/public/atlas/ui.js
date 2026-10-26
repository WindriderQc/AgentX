export const DAY=86400000;
export const YEAR=365.2425*DAY;
export const categories={
 home:{label:'Lieux & maison',short:'Maison',icon:'home',color:'var(--home)'},
 people:{label:'Liens & famille',short:'Liens',icon:'heart',color:'var(--people)'},
 work:{label:'Travail & études',short:'Parcours',icon:'briefcase',color:'var(--work)'},
 travel:{label:'Voyages & sorties',short:'Évasion',icon:'mountain',color:'var(--travel)'},
 health:{label:'Santé & équilibre',short:'Équilibre',icon:'leaf',color:'var(--health)'},
 daily:{label:'Petits & grands jours',short:'Quotidien',icon:'sun',color:'var(--daily)'}
};
const paths={
 home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-8H9v8H4a1 1 0 0 1-1-1Z"/>',
 heart:'<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
 briefcase:'<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V4h8v3M3 12c5 4 13 4 18 0M12 12v4"/>',
 mountain:'<path d="m2 20 7-16 5 10 3-6 5 12ZM6 11l3 2 2-2"/>',
 leaf:'<path d="M20 3c-9 0-16 3-16 10a7 7 0 0 0 7 7c7 0 9-8 9-17ZM4 21 16 9"/>',
 sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',
 search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
 mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
 calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>',
 moon:'<path d="M20 14A9 9 0 0 1 10 4a9 9 0 1 0 10 10Z"/>',
 link:'<path d="m10 13 4-4M8 15l-2 2a4 4 0 0 1-5-5l5-5a4 4 0 0 1 6 1m0 8a4 4 0 0 0 6 1l5-5a4 4 0 0 0-5-5l-2 2" transform="translate(1 1) scale(.9)"/>',
 pin:'<path d="m9 3 6 0-1 6 4 4H6l4-4ZM12 13v9"/>',
 close:'<path d="m6 6 12 12M6 18 18 6"/>',
 arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
 external:'<path d="M14 3h7v7m0-7L10 14M10 3H4v17h17v-6"/>',
 star:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',
 file:'<path d="M14 2H5v20h14V7ZM14 2v6h5M8 13h8m-8 4h6"/>',
 user:'<circle cx="12" cy="8" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>',
 location:'<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>'
};
export const icon=name=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]||paths.sun}</svg>`;
export const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const number=value=>new Intl.NumberFormat('fr-CA').format(value);
export const fold=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export function ownerText(value,owner){
 if(typeof value!=='string'||!owner?.preferredGivenName)return value;
 const aliases=(owner.givenNameAliases||[]).filter(a=>a!==owner.preferredGivenName).map(a=>a.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
 return aliases.length?value.replace(new RegExp(`\\b(?:${aliases.join('|')})\\b(?!@)`,'g'),owner.preferredGivenName):value;
}
export function ownerDisplay(event,owner){
 const display={...event};
 for(const key of ['title','description','rationale','notes'])if(typeof event[key]==='string')display[key]=ownerText(event[key],owner);
 if(event.reviewQuestions)display.reviewQuestions=event.reviewQuestions.map(q=>ownerText(q,owner));
 return display;
}
export function dateLabel(event,short=false){
 if(!short&&event.ownerTimeLabel&&typeof event.eventTime!=='string'&&typeof event.endTime!=='string')return event.ownerTimeLabel;
 if(!event.date)return event.originalDate&&event.originalDate!=='unknown'?String(event.originalDate):'Date à préciser';
 if(!short&&event.ongoing)return `${singleDateLabel(event)} — aujourd’hui`;
 if(!short&&event.endDate&&/^\d{4}-\d{2}-\d{2}$/.test(event.endDate)&&event.endDate!==event.date)return `${singleDateLabel(event)} — ${singleDateLabel({date:event.endDate,precision:event.endPrecision||event.precision})}`;
 return singleDateLabel(event,short);
}
function singleDateLabel(event,short=false){
 const date=new Date(event.date+'T12:00:00Z');
 if(event.precision==='year')return event.date.slice(0,4);
 return new Intl.DateTimeFormat('fr-CA',{timeZone:'UTC',...(event.precision==='month'?{month:short?'short':'long',year:'numeric'}:{day:'numeric',month:short?'short':'long',...(!short&&{year:'numeric'})})}).format(date);
}
export function toast(text){const el=document.getElementById('toast');el.textContent=text;el.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>{el.hidden=true;},2600);}
