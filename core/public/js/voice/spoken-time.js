/* French audio projection only. Never changes stored replies or calendar values. */
(function(root){
 'use strict';
 const MONTHS=['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
 const SMALL=['zéro','un','deux','trois','quatre','cinq','six','sept','huit','neuf','dix','onze','douze','treize','quatorze','quinze','seize'];
 function number(n){
  if(n<17)return SMALL[n];if(n<20)return 'dix-'+SMALL[n-10];
  if(n<70){const tens=['','','vingt','trente','quarante','cinquante','soixante'][Math.floor(n/10)],rest=n%10;return tens+(rest===1?' et un':rest?'-'+number(rest):'');}
  if(n<80)return 'soixante'+(n===71?' et onze':'-'+number(n-60));
  if(n<100)return 'quatre-vingt'+(n===80?'s':'-'+number(n-80));
  if(n<1000){const hundreds=Math.floor(n/100),rest=n%100;return (hundreds===1?'cent':number(hundreds)+' cent')+(!rest&&hundreds>1?'s':rest?' '+number(rest):'');}
  const thousands=Math.floor(n/1000),rest=n%1000;return (thousands===1?'mille':number(thousands)+' mille')+(rest?' '+number(rest):'');
 }
 function validDate(y,m,d){const date=new Date(Date.UTC(y,m-1,d));return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d;}
 function day(n){return n===1?'premier':number(n);}
 function date(y,m,d){return day(d)+' '+MONTHS[m-1]+' '+number(y);}
 function time(h,m,s){
  if(m===0&&s===undefined&&h===0)return 'minuit';if(m===0&&s===undefined&&h===12)return 'midi';
  let text=number(h).replace(/\bun$/, 'une')+' heure'+(h===1?'':'s');
  if(m)text+=' '+(m===1?'une minute':number(m).replace(/\bun$/, 'une'));
  if(s!==undefined)text+=' '+(s===1?'une seconde':number(s)+' secondes');
  return text;
 }
 function clockText(part) {
  const clock = /(?<![\p{L}\p{N}_:/-])(?<!\d[.,])(\d{1,2})(?:[ \u00a0\u202f]*h(?:[ \u00a0\u202f]*(\d{1,2}))?|:(\d{2}))(?::(\d{2}))?(?![\p{L}\p{N}_:/-]|\.[\p{L}\p{N}_])/giu;
  return part.replace(clock, (raw, hour, hMinutes, colonMinutes, seconds, offset) => {
   const minutes = hMinutes ?? colonMinutes;
   if (!minutes && (seconds || /^[ \u00a0\u202f]*[\d:]/.test(part.slice(offset + raw.length)))) return raw;
   const h = Number(hour), m = Number(minutes ?? 0), s = seconds === undefined ? undefined : Number(seconds);
   if (h > 24 || m > 59 || s > 59 || (h === 24 && (m || s))) return raw;
   if (/(?:score|ratio|rapport|version|code|identifiant|fichier)[ :]*$/i.test(part.slice(Math.max(0, offset - 16), offset))) return raw;
   return time(h, m, s);
  });
 }
 function projection(value, includeDates) {
  return String(value||'').split(/(https?:\/\/[^\s<>]+|(?:[A-Za-z]:)?\/[^\s<>]+|\b[\w-]*\d{4}-\d{2}-\d{2}\.[A-Za-z0-9]+\b)/g).map((part,index)=>{
   if(index%2)return part;
   if (!includeDates) return clockText(part);
   part=part.replace(/(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?![\w-])/g,(raw,y,m,d)=>validDate(+y,+m,+d)?date(+y,+m,+d):raw);
   part=part.replace(new RegExp('\\b(\\d{1,2})(?:er)? ('+MONTHS.join('|')+')(?: (\\d{4}))?\\b','gi'),(raw,d,month,y)=>{
    const m=MONTHS.findIndex(v=>v.toLowerCase()===month.toLowerCase())+1;
    if(!validDate(y?+y:2000,m,+d))return raw;return day(+d)+' '+month+(y?' '+number(+y):'');
   });
   return clockText(part);
  }).join('');
 }
 const api = { frenchClockText: value => projection(value, false), frenchDateTimeText: value => projection(value, true) };
 if(typeof module==='object'&&module.exports)module.exports=api;else root.AgentXSpokenTime=api;
})(typeof globalThis==='undefined'?this:globalThis);
