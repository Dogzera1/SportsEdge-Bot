// Audita EV/P/odds das tips pendentes. Varre arquivos pend_*.json e sinaliza
// discrepâncias entre EV reportado e EV recalculado via model_p_pick × odds.

const fs = require('fs');
const path = require('path');

const SPORTS = ['esports', 'tennis', 'mma', 'darts', 'snooker', 'cs', 'valorant', 'tabletennis', 'football'];

// Thresholds de suspeita por sport (sharp markets = tolerância menor)
const MAX_EV_SUSPECT = {
  esports: 25, tennis: 20, mma: 20, darts: 20, snooker: 20,
  cs: 25, valorant: 25, tabletennis: 30, football: 15,
};

const cwd = process.cwd();
const rows = [];
for (const sp of SPORTS) {
  const p = path.join(cwd, `pend_${sp}.json`);
  if (!fs.existsSync(p)) continue;
  try {
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(arr)) for (const t of arr) rows.push(t);
  } catch (_) {}
}

const fmtPct = x => (x == null ? 'null' : (x * 100).toFixed(1) + '%');

console.log(`=== AUDIT ${rows.length} tips pendentes ===\n`);

const flagged = [];
for (const t of rows) {
  const odd = Number(t.odds) || 0;
  const evReported = Number(t.ev); // EV em %
  const p = Number(t.model_p_pick);
  const flags = [];

  // 1) Sanity de campos
  if (!odd || odd <= 1) flags.push(`odds_invalid(${odd})`);
  if (!Number.isFinite(evReported)) flags.push('ev_missing');
  if (!Number.isFinite(p) || p <= 0 || p >= 1) flags.push(`p_invalid(${t.model_p_pick})`);

  // 2) Consistência EV = (p × odd − 1) × 100
  if (Number.isFinite(odd) && odd > 1 && Number.isFinite(p) && p > 0 && p < 1) {
    const evCalc = (p * odd - 1) * 100;
    const diff = Math.abs(evCalc - evReported);
    if (diff >= 3) flags.push(`ev_mismatch(rep=${evReported}% calc=${evCalc.toFixed(1)}% Δ${diff.toFixed(1)}pp)`);
  }

  // 3) EV absurdamente alto pra sport
  const thr = MAX_EV_SUSPECT[t.sport] || 25;
  if (evReported > thr) flags.push(`ev_too_high(${evReported}% > ${thr}% sharp cap)`);

  // 4) Conf BAIXA com EV alto (suspeito)
  const conf = String(t.confidence || '').toUpperCase();
  if ((conf === 'BAIXA') && evReported > 15) flags.push('baixa_conf_ev_alto');

  if (flags.length) {
    flagged.push({ id: t.id, sport: t.sport, sent: t.sent_at, match: `${t.participant1} vs ${t.participant2}`, pick: t.tip_participant, odd, ev: evReported, p: fmtPct(p), market: t.market_type, conf, live: t.is_live, flags });
  }
}

console.log(`Flagged: ${flagged.length}/${rows.length}\n`);
for (const f of flagged) {
  console.log(`#${f.id} [${f.sport}${f.market && f.market !== 'ML' ? '/'+f.market : ''}] ${f.sent}`);
  console.log(`  ${f.match} | pick: ${f.pick} @ ${f.odd} | EV: ${f.ev}% | P: ${f.p} | ${f.conf}${f.live ? ' LIVE' : ''}`);
  for (const fl of f.flags) console.log(`  ⚠ ${fl}`);
  console.log();
}

// Sumário por sport
console.log('\n=== Sumário ===');
const bySport = {};
for (const t of rows) (bySport[t.sport] = bySport[t.sport] || { total: 0, flagged: 0 }).total++;
for (const f of flagged) if (bySport[f.sport]) bySport[f.sport].flagged++;
for (const [sp, v] of Object.entries(bySport)) {
  console.log(`${sp.padEnd(12)} ${String(v.total).padStart(3)} tips | ${String(v.flagged).padStart(3)} flagged`);
}
