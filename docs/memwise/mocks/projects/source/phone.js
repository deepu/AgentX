const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:390,height:844}});
const fs=require('fs');const s=fs.readFileSync('project/Upload.dc.html','utf8');const inner=s.match(/<x-dc>([\s\S]*)<\/x-dc>/)[1].replace(/<\/?helmet>/g,'');
await p.setContent('<!doctype html><html><body style="margin:0">'+inner+'</body></html>');await p.screenshot({path:'render/Upload.png'});await b.close()})();
