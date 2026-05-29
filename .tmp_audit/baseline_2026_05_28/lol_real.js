const fs=require('fs');let t=fs.readFileSync('.tmp_audit/baseline_2026_05_28/cross_sig.json','utf8');if(t.charCodeAt(0)===0xFEFF)t=t.slice(1);
const d=JSON.parse(t);
const lol=d.by_sport.lol;
console.log('LoL markets:',Object.keys(lol).join(','));
// dump campos de um nó pra achar IC95
const sample=lol.TOTAL&&lol.TOTAL.agg&&lol.TOTAL.agg.real;
console.log('CAMPOS de um nó real:',sample?JSON.stringify(sample):'(no TOTAL.agg.real)');
console.log('---');
function fmt(v){if(!v)return null;const roi=v.roi_pct??v.roi;const n=v.n??v.count;
  const lo=v.ic95_lo??v.roi_ic95_lo??v.ci_lo??v.lo??(Array.isArray(v.ic95)?v.ic95[0]:undefined);
  const hi=v.ic95_hi??v.roi_ic95_hi??v.ci_hi??v.hi??(Array.isArray(v.ic95)?v.ic95[1]:undefined);
  return `n=${n} roi=${typeof roi==='number'?roi.toFixed(1):roi}% IC95=[${lo!=null?(+lo).toFixed(1):'?'},${hi!=null?(+hi).toFixed(1):'?'}] ${v.classification||v.verdict||''}`;}
for(const mkt of Object.keys(lol)){
  const m=lol[mkt];
  console.log(`\n## lol.${mkt}`);
  if(m.agg){console.log(`  agg     real: ${fmt(m.agg.real)}  | shadow: ${fmt(m.agg.shadow)}`);}
  for(const grp of ['by_side','by_dir_side','by_tier']){
    if(!m[grp])continue;
    for(const k of Object.keys(m[grp])){
      const r=fmt(m[grp][k].real), s=fmt(m[grp][k].shadow);
      if((m[grp][k].real&&(m[grp][k].real.n||m[grp][k].real.count))||(m[grp][k].shadow&&(m[grp][k].shadow.n)))
        console.log(`  ${grp}.${k}  real: ${r}  | shadow: ${s}`);
    }
  }
}
