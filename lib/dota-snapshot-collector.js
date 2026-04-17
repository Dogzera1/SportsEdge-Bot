// ── Dota Live Snapshot Collector ──
// Coleta snapshots pareados (Steam RT state + Pinnacle live odds) a cada N segundos.
// Objetivo Vetor 7: detectar lag entre Steam RT (atualiza ~15s) e Pinnacle (atualiza ?).
// Se Pinnacle tiver delay >30s consistente vs Steam RT, há janela de edge informacional.

const http = require('http');

function _httpGetJson(serverBase, path, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const u = new URL(serverBase + path);
    const req = http.request({
      method: 'GET', hostname: u.hostname, port: u.port,
      path: u.pathname + u.search, timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Captura 1 snapshot por match live e insere no DB.
async function collectSnapshot(serverBase, db) {
  if (!db) return { ok: false, error: 'db indisponível' };
  // 1. Lista matches Dota live com Pinnacle odds
  const matches = await _httpGetJson(serverBase, '/dota-matches');
  if (!Array.isArray(matches)) return { ok: false, error: 'no dota-matches' };
  const live = matches.filter(m => m.status === 'live' && m.odds?.bookmaker === 'Pinnacle' && m.odds.t1 && m.odds.t2);
  if (!live.length) return { ok: true, captured: 0, reason: 'no_live_pinnacle' };

  const insert = db.prepare(`
    INSERT INTO dota_live_snapshots
    (captured_at, match_id, team1, team2, game_time, gold_diff, kills_diff, radiant_kills, dire_kills,
     model_p1, pinnacle_odds_t1, pinnacle_odds_t2, implied_p1_dejuiced, divergence_pp, source)
    VALUES (datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let captured = 0;
  for (const m of live) {
    // 2. Fetch Steam RT pra esse match
    const stats = await _httpGetJson(serverBase, `/opendota-live?team1=${encodeURIComponent(m.team1)}&team2=${encodeURIComponent(m.team2)}`, 8000);
    if (!stats?.hasLiveStats) continue;

    const blue = stats.blueTeam || {}, red = stats.redTeam || {};
    const goldDiff = (blue.totalGold || 0) - (red.totalGold || 0);
    const killsDiff = (blue.totalKills || 0) - (red.totalKills || 0);
    const radiantKills = blue.totalKills || 0;
    const direKills = red.totalKills || 0;
    const gameTime = stats.gameTime || null;

    // 3. Implied dejuiced de Pinnacle
    const o1 = parseFloat(m.odds.t1), o2 = parseFloat(m.odds.t2);
    let impliedP1 = null;
    if (o1 > 1 && o2 > 1) {
      const r1 = 1 / o1, r2 = 1 / o2;
      impliedP1 = r1 / (r1 + r2);
    }

    // 4. Modelo simples de P1 ao vivo: blend de odds + gold_diff (proxy heurístico)
    // (Substituir por modelo real depois — pra smoke a ideia é ter base pra comparar)
    let modelP1 = impliedP1;
    if (modelP1 != null && Number.isFinite(goldDiff) && gameTime != null) {
      // Curva: cada 1k gold lead em min 25 = +5pp, escalado pelo tempo
      const minutes = gameTime / 60;
      const goldLeadPp = Math.tanh(goldDiff / 5000) * Math.min(0.20, minutes / 60);
      modelP1 = Math.max(0.01, Math.min(0.99, modelP1 + goldLeadPp));
    }
    const divergencePp = modelP1 != null && impliedP1 != null
      ? Math.abs(modelP1 - impliedP1) * 100
      : null;

    insert.run(
      m.id, m.team1, m.team2, gameTime, goldDiff, killsDiff,
      radiantKills, direKills,
      modelP1, o1, o2, impliedP1, divergencePp, stats._source || 'opendota'
    );
    captured++;
  }
  return { ok: true, captured, total_live: live.length };
}

// Análise: pra cada par de snapshots consecutivos do mesmo match,
// mede correlação entre mudança de gold (Steam RT) e mudança de odds (Pinnacle).
// Lag detectado: gold muda → odds só muda N seconds depois.
function analyzeLatency(db, opts = {}) {
  if (!db) return { ok: false, error: 'db indisponível' };
  const days = parseInt(opts.days || 7, 10);

  let snapshots;
  try {
    snapshots = db.prepare(`
      SELECT id, captured_at, match_id, gold_diff, pinnacle_odds_t1, pinnacle_odds_t2, implied_p1_dejuiced
      FROM dota_live_snapshots
      WHERE captured_at >= datetime('now', ?)
      ORDER BY match_id, captured_at ASC
    `).all(`-${days} days`);
  } catch (e) { return { ok: false, error: e.message }; }

  if (!snapshots.length) return { ok: true, total_snapshots: 0, note: 'Sem snapshots — coletor precisa rodar antes (cron 60s).' };

  // Group by match_id
  const byMatch = new Map();
  for (const s of snapshots) {
    if (!byMatch.has(s.match_id)) byMatch.set(s.match_id, []);
    byMatch.get(s.match_id).push(s);
  }

  // Para cada match, mede:
  // - Quantas vezes gold mudou >1k mas odds não acompanhou no próximo snapshot
  // - Tempo médio entre mudança de gold e mudança correspondente de odds
  let totalGoldChanges = 0, oddsLagged = 0, oddsImmediate = 0;
  const lagSamples = [];

  for (const [matchId, snaps] of byMatch.entries()) {
    if (snaps.length < 3) continue;
    for (let i = 1; i < snaps.length; i++) {
      const prev = snaps[i - 1], curr = snaps[i];
      const goldChange = (curr.gold_diff || 0) - (prev.gold_diff || 0);
      if (Math.abs(goldChange) < 1500) continue; // Mudança significativa: >1.5k gold lead shift
      totalGoldChanges++;
      // Implied P1 mudou na mesma direção?
      const impliedDelta = (curr.implied_p1_dejuiced || 0) - (prev.implied_p1_dejuiced || 0);
      if (Math.abs(impliedDelta) < 0.005) {
        // Odds não mudou — possível lag
        oddsLagged++;
        // Procura próximo snapshot onde implied mudou
        for (let j = i + 1; j < snaps.length; j++) {
          const next = snaps[j];
          const nextDelta = (next.implied_p1_dejuiced || 0) - (prev.implied_p1_dejuiced || 0);
          if (Math.abs(nextDelta) >= 0.005 && Math.sign(nextDelta) === Math.sign(goldChange)) {
            const tPrev = new Date(prev.captured_at + 'Z').getTime();
            const tNext = new Date(next.captured_at + 'Z').getTime();
            const lagSec = (tNext - tPrev) / 1000;
            lagSamples.push(lagSec);
            break;
          }
        }
      } else {
        oddsImmediate++;
      }
    }
  }

  const avgLag = lagSamples.length > 0 ? lagSamples.reduce((a, b) => a + b, 0) / lagSamples.length : null;
  const medianLag = lagSamples.length > 0 ? lagSamples.slice().sort((a, b) => a - b)[Math.floor(lagSamples.length / 2)] : null;

  let verdict;
  if (totalGoldChanges < 10) verdict = { code: 'insufficient', label: '⚪ Sample insuficiente (gold changes <10) — aguardar mais coleta' };
  else if (avgLag != null && avgLag > 30) verdict = { code: 'lag_detected', label: `🟢 LAG DETECTADO — Pinnacle demora ~${avgLag.toFixed(0)}s pra ajustar após gold change. Edge informacional possível.` };
  else if (oddsImmediate / totalGoldChanges > 0.7) verdict = { code: 'no_lag', label: `🔴 SEM LAG — Pinnacle ajusta praticamente em tempo real (${(oddsImmediate / totalGoldChanges * 100).toFixed(0)}% imediato). Vetor 7 KILL.` };
  else verdict = { code: 'partial_lag', label: `🟡 LAG PARCIAL — ${oddsLagged}/${totalGoldChanges} gold changes sem ajuste imediato. Investigar.` };

  return {
    ok: true,
    total_snapshots: snapshots.length,
    matches_with_snapshots: byMatch.size,
    gold_changes_observed: totalGoldChanges,
    odds_immediate: oddsImmediate,
    odds_lagged: oddsLagged,
    lag_samples_n: lagSamples.length,
    avg_lag_seconds: avgLag != null ? parseFloat(avgLag.toFixed(1)) : null,
    median_lag_seconds: medianLag != null ? parseFloat(medianLag.toFixed(1)) : null,
    verdict,
  };
}

module.exports = { collectSnapshot, analyzeLatency };
