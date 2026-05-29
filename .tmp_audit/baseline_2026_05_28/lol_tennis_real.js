// Extrai LoL (TOTAL/ML por side, real vs shadow) + tennis HG (dir/side/tier real) do cross_sig.json
const fs=require('fs');const p='.tmp_audit/baseline_2026_05_28/cross_sig.json';
let t=fs.readFileSync(p,'utf8');if(t.charCodeAt(0)===0xFEFF)t=t.slice(1);
const d=JSON.parse(t);
// descobrir estrutura
function walk(obj,depth,path){
  if(depth>6||obj==null||typeof obj!=='object')return;
  for(const k of Object.keys(obj)){
    const v=obj[k];
    if(v&&typeof v==='object'){
      // heuristica: nó com roi/n/ic
      const hasStat = ('roi_pct'in v||'roi'in v)&&('n'in v||'count'in v);
      if(hasStat){
        const np=(path+'.'+k);
        const lc=np.toLowerCase();
        if(lc.includes('lol')||lc.includes('handicapgames')||lc.includes('handicap_games')||lc.includes('tennis')){
          const roi=v.roi_pct??v.roi;const n=v.n??v.count;
          const lo=v.ic95_lo??v.ic_lo??v.roi_ic95_lo??(v.ic95&&v.ic95[0]);
          const hi=v.ic95_hi??v.ic_hi??v.roi_ic95_hi??(v.ic95&&v.ic95[1]);
          const cls=v.classification||v.verdict||v.class||'';
          console.log(`${np} | n=${n} roi=${typeof roi==='number'?roi.toFixed(1):roi}% IC95=[${lo??'?'},${hi??'?'}] ${cls}`);
        }
      }
      walk(v,depth+1,path+'.'+k);
    }
  }
}
console.log('TOP-LEVEL KEYS:',Object.keys(d).join(','));
walk(d,0,'');
