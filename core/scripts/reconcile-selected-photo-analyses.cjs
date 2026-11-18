#!/usr/bin/env node
'use strict';
const mongoose=require('mongoose');
const {createSelectedAnalysis}=require('../src/services/photos/photoSelectedAnalysis');
(async()=>{
  try {
    let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>16384)throw Error('Selected plan exceeds its bound');}
    const input=JSON.parse(raw);
    await mongoose.connect(process.env.MONGODB_URI);
    console.log(JSON.stringify(await createSelectedAnalysis()(input)));
  }finally{await mongoose.disconnect();}
})().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
