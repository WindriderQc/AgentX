'use strict';
const sharp = require('sharp');
const Cards = require('../../../models/PhotoProcessingCard');
const Index = require('../../../models/PhotoLibrarySimilarity');
const { fail } = require('./importFiles');
const ALGORITHM = 'preview-phash-dhash-colour/v1';
const MAX_ITEMS = 10000;
const cosine = Array.from({ length: 8 }, (_, u) => Array.from({ length: 32 }, (_, x) => Math.cos((2*x+1)*u*Math.PI/64)));
const hex = bits => bits.toString(16).padStart(16, '0');
function bits(values, threshold) { return values.reduce((v, x) => (v << 1n) | BigInt(x > threshold), 0n); }
async function fingerprint(bytes) {
  const source = sharp(bytes, { limitInputPixels: 40000000, failOn: 'error' }).rotate();
  const meta = await source.metadata();
  const rotated = [5,6,7,8].includes(meta.orientation);
  const width = rotated ? meta.height : meta.width, height = rotated ? meta.width : meta.height;
  const gray = await source.clone().resize(32,32,{fit:'fill'}).greyscale().raw().toBuffer();
  const coefficients = [];
  for (let v=0; v<8; v++) for (let u=0; u<8; u++) {
    let sum = 0;
    for (let y=0; y<32; y++) for (let x=0; x<32; x++) sum += gray[y*32+x]*cosine[u][x]*cosine[v][y];
    coefficients.push(sum);
  }
  const ac = coefficients.slice(1), median = [...ac].sort((a,b)=>a-b)[31];
  const small = await source.clone().resize(9,8,{fit:'fill'}).greyscale().raw().toBuffer();
  let difference = 0n;
  for (let y=0; y<8; y++) for (let x=0; x<8; x++) difference = (difference << 1n) | BigInt(small[y*9+x]>small[y*9+x+1]);
  const colour = await source.clone().resize(4,4,{fit:'fill'}).removeAlpha().toColourspace('srgb').raw().toBuffer();
  const mean = gray.reduce((s,x)=>s+x,0)/gray.length;
  const variance = gray.reduce((s,x)=>s+(x-mean)**2,0)/gray.length;
  return { aspect: width/height, phash: hex(bits(ac,median)), dhash: hex(difference), colour: [...colour], variance };
}
function distanceWithin(a,b,max) {
  let xor=BigInt('0x'+a)^BigInt('0x'+b), count=0;
  while (xor) { if (++count>max) return false; xor &= xor-1n; }
  return true;
}
function near(a,b) {
  if (a.variance<100 || b.variance<100 || Math.abs(Math.log(a.aspect/b.aspect))>0.025) return false;
  let difference=0;
  for (let i=0; i<48; i++) difference+=Math.abs(a.colour[i]-b.colour[i]);
  return difference/48<=10 && distanceWithin(a.dhash,b.dhash,6) && distanceWithin(a.phash,b.phash,6);
}
function group(rows) {
  const groups=[];
  for (const row of [...rows].sort((a,b)=>a.sha256.localeCompare(b.sha256))) {
    // Complete-link avoids declaring A and C close only because each resembles B.
    const match=groups.find(g=>g.every(other=>near(row.fingerprint,other.fingerprint)));
    if (match) match.push(row); else groups.push([row]);
  }
  return groups.flatMap(g=>g.map(row=>({ sha256:row.sha256,assetId:row.assetId,groupId:g[0].sha256 })));
}
function createSimilarityIndex({ config, client, cards=Cards, indexes=Index } = {}) {
  return async function build({ operationId, assertAdmitted, progress=()=>{} }) {
    if (typeof assertAdmitted!=='function') throw fail('PHOTO_SIMILARITY_ADMISSION_REQUIRED','Explicit operator admission is required');
    const fixed=config();
    if (!fixed) throw fail('PHOTO_PROCESSING_NOT_CONFIGURED','Configure photo processing');
    await assertAdmitted();
    const previous=await indexes.findById(fixed.libraryId).lean();
    if (previous?.operationId===operationId) return previous;
    const sources=await cards.find({libraryId:fixed.libraryId,'metadata.type':'IMAGE','analysis.state':'completed',
      'analysis.card.proposal.description':{$type:'string'}}).select({_id:1,assetId:1}).sort({_id:1}).limit(MAX_ITEMS+1).lean();
    if (sources.length>MAX_ITEMS) throw fail('PHOTO_SIMILARITY_LIMIT','Split the operator index before exceeding its bound');
    const rows=[];let failedCount=0;
    for (const source of sources) {
      await assertAdmitted();
      try {
        const preview=await client.image('/assets/'+source.assetId+'/thumbnail?size=preview');
        rows.push({sha256:source._id,assetId:source.assetId,fingerprint:await fingerprint(preview.bytes)});
      } catch { failedCount++; }
      if ((rows.length+failedCount)%50===0) await progress({processed:rows.length+failedCount,total:sources.length,failedCount});
    }
    const entries=group(rows);
    await assertAdmitted();
    if (config()?.libraryId!==fixed.libraryId) throw fail('PHOTO_PROCESSING_CONFIG_CHANGED','Library changed during similarity indexing');
    const value={version:1,operationId,observedAt:new Date(),algorithm:ALGORITHM,sourceCount:sources.length,failedCount,entries};
    const options={writeConcern:{w:1,j:true}};
    if (previous) {
      const result=await indexes.updateOne({_id:fixed.libraryId,operationId:previous.operationId},{$set:value},options);
      if (result.matchedCount!==1) throw fail('PHOTO_SIMILARITY_CHANGED','Observe the newer index without replacing it');
    } else await indexes.create([{_id:fixed.libraryId,...value}],options);
    return value;
  };
}
module.exports={fingerprint,near,group,createSimilarityIndex,ALGORITHM};
