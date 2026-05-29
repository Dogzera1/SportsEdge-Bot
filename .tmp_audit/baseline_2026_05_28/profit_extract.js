const fs=require('fs');let t=fs.readFileSync('.tmp_audit/baseline_2026_05_28/cross_sig.json','utf8');if(t.charCodeAt(0)===0xFEFF)t=t.slice(1);
const d=JSON.parse(t);
function fmt(v){if(!v)return'(nil)';const roi=v.roi,n=v.n,s=v.settled;const ic=v.roi_ic95;
  return `n=${n}(s=${s}) ROI=${typeof roi==='number'?roi.toFixed(1):roi}% IC95=[${ic?ic[0].toFixed(1):'?'},${ic?ic[1].toFixed(1):'?'}] clv=${v.avg_clv!=null?v.avg_clv.toFixed(1):'?'}`;}
function verdict(v){if(!v||!v.roi_ic95)return'';const[lo,hi]=v.roi_ic95;if(lo>0)return'EDGE✅';if(hi<0)return'LEAK❌';return'inconcl';}
console.log('=== REAL (is_shadow=0) por sport — agg + melhores sub-buckets ===');
for(const sp of Object.keys(d.by_sport)){
  const mk=d.by_sport[sp];
  // agg por market
  for(const mkt of Object.keys(mk)){
    const m=mk[mkt];
    if(m.agg&&m.agg.real&&m.agg.real.n>=10){
      console.log(`${sp}.${mkt}.agg  REAL ${fmt(m.agg.real)} ${verdict(m.agg.real)}`);
    }
  }
}
console.log('\n=== CS detalhe (reativacao?) ===');
const cs=d.by_sport.cs||{};
for(const mkt of Object.keys(cs)){
  const m=cs[mkt];
  if(m.agg&&m.agg.real&&m.agg.real.n>=5) console.log(`cs.${mkt}.agg REAL ${fmt(m.agg.real)} ${verdict(m.agg.real)} | shadow ${fmt(m.agg.shadow)}`);
  for(const grp of ['by_side','by_tier']) if(m[grp]) for(const k of Object.keys(m[grp])){const r=m[grp][k].real;if(r&&r.n>=5)console.log(`  cs.${mkt}.${grp}.${k} REAL ${fmt(r)} ${verdict(r)}`);}
}
console.log('\n=== TENNIS edges p/ boost (real IC95) ===');
const tn=d.by_sport.tennis.HANDICAPGAMES;
for(const grp of ['by_dir_side','by_tier']) for(const k of Object.keys(tn[grp]||{})){const r=tn[grp][k].real;if(r&&r.n>=15)console.log(`  HG.${grp}.${k} REAL ${fmt(r)} ${verdict(r)}`);}
