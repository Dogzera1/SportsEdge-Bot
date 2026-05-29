function L(p){let t=require('fs').readFileSync(p,'utf8');if(t.charCodeAt(0)===0xFEFF)t=t.slice(1);return JSON.parse(t)}
const d=L('.tmp_audit/baseline_2026_05_28/tennis_calib_raw_prod.json');
console.log('path:',d.path,'| bytes:',d.bytes,'| mtime:',d.mtime);
const head=String(d.raw_preview_head||d.raw_preview||'');
const m=head.match(/fittedAt["':\s]+([0-9T:.\-Z]+)/);
const n=head.match(/nSamples["':\s]+([0-9]+)/);
console.log('PROD fittedAt interno:', m?m[1]:'(nao no head)', '| nSamples:', n?n[1]:'?');
console.log('head[0..240]:', head.slice(0,240));
