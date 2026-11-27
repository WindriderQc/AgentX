'use strict';

const assert = require('node:assert/strict');

function position(page) {
  return page.locator('#rows').evaluate(rows => {
    const box = rows.getBoundingClientRect();
    return {x:box.x, y:box.y, right:box.right, bottom:box.bottom, height:box.height,
      pane:rows.scrollTop, document:window.scrollY, gutter:rows.offsetWidth-rows.clientWidth,
      detail:document.querySelector('#detail').getBoundingClientRect().y,
      heading:document.querySelector('.sectionbar').getBoundingClientRect().y};
  });
}

async function desktop(page) {
  const rows = page.locator('#rows');
  const start = await position(page);
  assert.ok(start.gutter >= 12 && start.bottom <= page.viewportSize().height);
  await page.mouse.move(start.x+40,start.y+50);
  await page.mouse.wheel(0,360);
  await page.waitForFunction(()=>document.querySelector('#rows').scrollTop >= 300);
  const wheel = await position(page);
  assert.equal(wheel.document,start.document);
  assert.equal(wheel.detail,start.detail);
  assert.equal(wheel.heading,start.heading);

  await rows.focus();
  await page.keyboard.press('Home');
  await page.waitForFunction(()=>document.querySelector('#rows').scrollTop === 0);
  await page.mouse.move(start.right-8,start.y+10);
  await page.mouse.down();
  await page.mouse.move(start.right-8,start.y+65,{steps:12});
  await page.mouse.up();
  const drag = await position(page);
  assert.ok(drag.pane > 0);
  assert.equal(drag.document,start.document);
  await rows.focus();
  await page.keyboard.press('PageDown');
  await page.waitForFunction(previous=>document.querySelector('#rows').scrollTop > previous,drag.pane);
  await page.keyboard.press('End');
  await page.waitForFunction(()=>{
    const r=document.querySelector('#rows');
    return r.scrollHeight-r.clientHeight-r.scrollTop <= 1;
  });
  const last=rows.locator('.row').last();
  const previous=await position(page);
  await last.click();
  assert.equal((await position(page)).document,start.document);
  await page.locator('#detail .back').click();
  assert.equal(await last.evaluate(el=>el===document.activeElement),true);
  assert.equal((await position(page)).pane,previous.pane);
}

async function mobile(page) {
  const devtools=await page.context().newCDPSession(page);
  const touch=(type,touchPoints)=>devtools.send('Input.dispatchTouchEvent',{type,touchPoints});
  await touch('touchStart',[{x:70,y:780}]);
  for(let y=760;y>=520;y-=20){
    await touch('touchMove',[{x:70,y}]);
    await page.waitForTimeout(25);
  }
  await touch('touchEnd',[]);
  await page.waitForFunction(()=>window.scrollY>100);
  assert.equal((await position(page)).pane,0);
}

module.exports = async function verifyScroll(browser,url) {
  for(const [width,height] of [[1465,1346],[1366,768],[390,844]]){
    const small=width===390;
    const page=await browser.newPage({viewport:{width,height},hasTouch:small,isMobile:small});
    try{
      await page.goto(url);
      await page.locator('#rows .row').first().waitFor();
      if(small) await mobile(page); else await desktop(page);
    } finally { await page.close(); }
  }
};