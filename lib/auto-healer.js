// ── Auto-Healer ──
// Aplica fixes automáticos pra anomalias detectadas pelo Health Sentinel.
// Cada fix é registrado por anomaly_id e tem precondition (verifica), action (aplica),
// validate (confirma post-fix). Restrito a operacional — nunca toca lógica de negócio.
//
// Uso: const result = await runAutoHealer({ anomalies, ctx })
//   ctx: { autoAnalysisMutex, pollFns, log, vlrModule, env }

const FIXES = {
  // Mutex de runAutoAnalysis travado >5min — força liberação antes do stale_threshold (15min).
  mutex_stale: {
    severity: 'critical',
    description: 'runAutoAnalysis mutex travado',
    precondition: ({ ctx }) => {
      const m = ctx.autoAnalysisMutex;
      if (!m?.locked) return { ok: false, reason: 'mutex não está locked' };
      const ageMs = Date.now() - (m.since || 0);
      return ageMs > 5 * 60 * 1000
        ? { ok: true, ageMs }
        : { ok: false, reason: `mutex idade ${Math.round(ageMs / 1000)}s < 300s threshold` };
    },
    action: ({ ctx }) => {
      // 2026-05-06 FIX: bumpar generation antes de zerar locked. Sem isso,
      // o ciclo "antigo" (que era stale e foi liberado) ainda roda em
      // background — quando termina, executa `if (autoAnalysisMutex.generation
      // === myGen)` no finally, vê generation IGUAL, e libera o lock que
      // pertence a um NOVO ciclo (que pegou o lock pós-healer). Resultado:
      // 3 ciclos rodam em paralelo (ciclo antigo + novo + outro depois).
      // Bumpar generation invalida o stale ciclo, finally vira no-op.
      const m = ctx.autoAnalysisMutex;
      m.generation = (m.generation || 0) + 1;
      m.locked = false;
      m.since = 0;
      return { applied: `mutex.locked = false; generation bumped → ${m.generation}` };
    },
    validate: ({ ctx }) => ({ ok: !ctx.autoAnalysisMutex.locked }),
  },

  // Poll silent: re-invoca pollX manualmente.
  poll_silent_lol: { ...pollSilentFix('lol') },
  poll_silent_dota: { ...pollSilentFix('dota') },
  poll_silent_cs: { ...pollSilentFix('cs') },
  poll_silent_valorant: { ...pollSilentFix('valorant') },
  poll_silent_tennis: { ...pollSilentFix('tennis') },
  poll_silent_mma: { ...pollSilentFix('mma') },
  poll_silent_darts: { ...pollSilentFix('darts') },
  poll_silent_snooker: { ...pollSilentFix('snooker') },
  poll_silent_tt: { ...pollSilentFix('tt') },
  poll_silent_football: { ...pollSilentFix('football') },

  // AI backoff travou (timestamp já passou mas flag ainda ativa).
  ai_backoff_long: {
    severity: 'warning',
    description: 'DeepSeek backoff stuck',
    precondition: () => {
      const until = global.__deepseekBackoffUntil || 0;
      // Backoff stale: marcador ativo mas tempo já passou (lib não resetou)
      if (until > 0 && until < Date.now() - 60 * 1000) return { ok: true, expired: until };
      return { ok: false, reason: 'backoff válido ou inativo' };
    },
    action: () => {
      global.__deepseekBackoffUntil = 0;
      return { applied: 'backoff cleared' };
    },
    validate: () => ({ ok: !global.__deepseekBackoffUntil }),
  },

  // Auto-shadow não rodou há >7h (cron 6h, deveria ter rodado).
  auto_shadow_not_running: {
    severity: 'warning',
    description: 'auto-shadow cron parado',
    precondition: ({ ctx }) => {
      if (!/^(1|true|yes)$/i.test(String(process.env.AUTO_SHADOW_NEGATIVE_CLV ?? 'false'))) {
        return { ok: false, reason: 'auto-shadow desativado por env' };
      }
      // Heurística: usa lastAutoShadowCheck do ctx (se exposto pelo bot.js)
      const last = ctx.lastAutoShadowCheck || 0;
      const ageMs = Date.now() - last;
      return ageMs > 7 * 60 * 60 * 1000
        ? { ok: true, ageMs }
        : { ok: false, reason: `last check há ${Math.round(ageMs / 60000)}min` };
    },
    action: async ({ ctx }) => {
      if (typeof ctx.checkAutoShadow === 'function') {
        await ctx.checkAutoShadow();
        return { applied: 'checkAutoShadow invocado' };
      }
      return { applied: 'no-op (checkAutoShadow não exposto)' };
    },
    validate: ({ ctx }) => ({ ok: (Date.now() - (ctx.lastAutoShadowCheck || 0)) < 60 * 1000 }),
  },

  // VLR scrape com 0 matches inesperado — limpa cache pra forçar re-fetch.
  vlr_zero_unexpected: {
    severity: 'warning',
    description: 'VLR cache vazio',
    precondition: ({ ctx }) => {
      const vlr = ctx.vlrModule;
      if (!vlr?._cacheStats) return { ok: false, reason: 'vlrModule não exposto' };
      const stats = vlr._cacheStats();
      // Se cache tem 0 hits úteis nas últimas 10min mas há live matches Valorant
      return stats?.zeroUnexpected ? { ok: true } : { ok: false };
    },
    action: ({ ctx }) => {
      if (typeof ctx.vlrModule?._clearCache === 'function') ctx.vlrModule._clearCache();
      return { applied: 'vlr cache cleared' };
    },
    validate: () => ({ ok: true }),
  },
};

function pollSilentFix(sportKey) {
  return {
    severity: 'warning',
    description: `poll ${sportKey} silent`,
    precondition: ({ ctx, anomaly }) => {
      const fn = ctx.pollFns?.[sportKey];
      if (!fn) return { ok: false, reason: `pollFn[${sportKey}] não exposto` };
      // Anomaly já confirmou silent — só verifica se fn existe e não está rodando agora
      const flag = ctx.runningFlags?.[sportKey];
      if (flag) return { ok: false, reason: `pollFn[${sportKey}] já rodando` };
      return { ok: true };
    },
    action: async ({ ctx }) => {
      const fn = ctx.pollFns[sportKey];
      const result = await fn(true).catch(e => ({ error: e.message }));
      const n = Array.isArray(result) ? result.length : (result?.error ? `error: ${result.error}` : 'ok');
      return { applied: `pollFn[${sportKey}](true) re-invocado → ${n} matches` };
    },
    validate: () => ({ ok: true }), // próximo health-sentinel cycle valida heartbeat
  };
}

/**
 * Aplica fixes pra cada anomaly actionable.
 * @param {object} args
 * @param {Array} args.anomalies — output de runHealthSentinel.anomalies
 * @param {object} args.ctx — { autoAnalysisMutex, pollFns, runningFlags, vlrModule, checkAutoShadow, lastAutoShadowCheck, log }
 * @returns {Promise<{applied: Array, skipped: Array, errors: Array}>}
 */
async function runAutoHealer({ anomalies, ctx }) {
  const result = { applied: [], skipped: [], errors: [], at: Date.now() };
  if (!Array.isArray(anomalies) || !anomalies.length) {
    result.note = 'sem anomalias pra aplicar';
    return result;
  }
  for (const anomaly of anomalies) {
    if (!anomaly.actionable) {
      result.skipped.push({ id: anomaly.id, reason: 'não actionable (precisa intervenção humana)' });
      continue;
    }
    const fix = FIXES[anomaly.id];
    if (!fix) {
      result.skipped.push({ id: anomaly.id, reason: 'fix não registrado' });
      continue;
    }
    try {
      // Precondition
      const pre = await fix.precondition({ ctx, anomaly });
      if (!pre?.ok) {
        result.skipped.push({ id: anomaly.id, reason: `precondition falhou: ${pre?.reason || '?'}` });
        continue;
      }
      // Action
      const action = await fix.action({ ctx, anomaly, pre });
      // Validate (best-effort)
      let valid = { ok: true };
      try { valid = await fix.validate({ ctx, anomaly }); } catch (_) {}
      result.applied.push({
        id: anomaly.id,
        severity: anomaly.severity,
        description: fix.description,
        action: action?.applied || 'aplicado',
        validated: !!valid?.ok,
        anomaly_detail: anomaly.detail,
      });
      if (typeof ctx.log === 'function') {
        ctx.log('INFO', 'AUTO-HEALER', `[FIX ${anomaly.id}] ${fix.description}: ${action?.applied || 'OK'}`);
      }
    } catch (e) {
      result.errors.push({ id: anomaly.id, error: e.message });
      if (typeof ctx.log === 'function') {
        ctx.log('ERROR', 'AUTO-HEALER', `[FIX ${anomaly.id}] erro: ${e.message}`);
      }
    }
  }
  return result;
}

module.exports = { runAutoHealer, FIXES };
