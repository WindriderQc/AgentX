'use strict';
const path=require('node:path');
function registerKidsTasksPage(app){
 app.get('/kids',(req,res,next)=>{
  if(req.query.view===undefined)return next();
  if(req.query.view!=='screen')return res.status(400).type('text').send('Vue indisponible.');
  res.setHeader('Cache-Control','private, no-store');
  res.sendFile(path.join(__dirname,'public/kids-tasks-screen.html'));
 });
}
module.exports={registerKidsTasksPage};
