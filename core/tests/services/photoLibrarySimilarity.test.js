'use strict';
const sharp=require('sharp'),crypto=require('node:crypto');
const Cards=require('../../models/PhotoProcessingCard'),Index=require('../../models/PhotoLibrarySimilarity');
const {fingerprint,near,group,createSimilarityIndex}=require('../../src/services/photos/photoLibrarySimilarity');
const uuid=()=>crypto.randomUUID(),sha=n=>String(n).padStart(64,'0');
async function fixture(colour='blue') {
  return sharp(Buffer.from(`<svg width="320" height="240"><rect width="320" height="240" fill="${colour}"/><circle cx="150" cy="100" r="60" fill="yellow"/><path d="M0 240L230 150L320 240" fill="green"/></svg>`)).png().toBuffer();
}
beforeEach(async()=>{await Promise.all([Cards.deleteMany({}),Index.deleteMany({})]);});
test('re-encoded photographs group; different colour and flat images do not',async()=>{
  const bytes=await fixture(),small=await sharp(bytes).resize(160,120).jpeg({quality:82}).toBuffer();
  const a=await fingerprint(bytes),b=await fingerprint(small),c=await fingerprint(await fixture('red'));
  expect(near(a,b)).toBe(true);expect(near(a,c)).toBe(false);
  const flat=await fingerprint(await sharp({create:{width:100,height:100,channels:3,background:'white'}}).png().toBuffer());
  expect(near(flat,flat)).toBe(false);
  const rows=[{sha256:sha(2),assetId:uuid(),fingerprint:b},{sha256:sha(1),assetId:uuid(),fingerprint:a},{sha256:sha(3),assetId:uuid(),fingerprint:c}];
  expect(group(rows).map(x=>x.groupId)).toEqual([sha(1),sha(1),sha(3)]);
});
test('similarity does not collapse a transitive chain of different photos',()=>{
  const base={aspect:1,variance:200,colour:Array(48).fill(120),phash:'0000000000000000',dhash:'0000000000000000'};
  const a={...base},b={...base,phash:'000000000000000f',dhash:'000000000000000f'},c={...base,phash:'00000000000000ff',dhash:'00000000000000ff'};
  expect(near(a,b)).toBe(true);expect(near(b,c)).toBe(true);expect(near(a,c)).toBe(false);
  expect(group([a,b,c].map((fingerprint,i)=>({sha256:sha(i+1),assetId:uuid(),fingerprint}))).map(x=>x.groupId)).toEqual([sha(1),sha(1),sha(3)]);
});
test('an index reads previews only under admission and atomically preserves cards and previous index on failure',async()=>{
  const libraryId=uuid(),operationId=uuid(),bytes=await fixture();
  const rows=[1,2].map(n=>({_id:sha(n),assetId:uuid(),libraryId,metadata:{type:'IMAGE'},analysis:{state:'completed',card:{proposal:{description:'Un paysage'}}}}));
  await Cards.create(rows);const before=await Cards.find({}).lean();
  const admitted=jest.fn(async()=>{}),client={image:jest.fn(async()=>({bytes}))};
  const build=createSimilarityIndex({config:()=>({libraryId}),client});
  await expect(build({operationId})).rejects.toMatchObject({code:'PHOTO_SIMILARITY_ADMISSION_REQUIRED'});
  const result=await build({operationId,assertAdmitted:admitted});
  expect(result.entries).toHaveLength(2);expect(new Set(result.entries.map(x=>x.groupId)).size).toBe(1);
  expect(admitted).toHaveBeenCalledTimes(4);expect(client.image).toHaveBeenCalledTimes(2);
  await build({operationId,assertAdmitted:admitted});expect(client.image).toHaveBeenCalledTimes(2);
  const saved=await Index.findById(libraryId).lean();
  const refuse=jest.fn().mockResolvedValueOnce().mockRejectedValue(Error('window ended'));
  await expect(build({operationId:uuid(),assertAdmitted:refuse})).rejects.toThrow('window ended');
  expect(await Index.findById(libraryId).lean()).toEqual(saved);
  expect(await Cards.find({}).lean()).toEqual(before);
});
