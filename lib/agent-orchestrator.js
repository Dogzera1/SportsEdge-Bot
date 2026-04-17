// ── Agent Orchestrator ──
// Coordena agents em chains: detecta sintoma com agent A → invoca agent B pra investigar
// → tenta fix com agent C → valida com agent D. Substitui execução isolada por workflows.
//
// Filosofia: cada agent é stateless. Orchestrator mantém o estado da execução.

/**
 * Workflow registry: cada workflow é uma chain de steps.
 * Cada step recebe context acumulado e decide se continua/aborta.
 */
const WORKFLOWS = {
  // Workflow principal: full diagnostic + auto-fix loop.
  // Roda Health Sentinel → se anomalias actionable → Auto-Healer → re-roda Sentinel pra validar.
  full_diagnostic: {
    description: 'Diagnóstico completo + auto-fix + validação',
    steps: [
      { name: 'health_sentinel', agent: 'health-sentinel', critical: true },
      {
        name: 'check_actionable',
        custom: (ctx) => {
          const actionable = ctx.health_sentinel?.anomalies?.filter(a => a.actionable) || [];
          if (actionable.length === 0) {
            ctx.shortcircuit = { reason: 'no_actionable_anomalies', healthy: true };
            return { ok: true, skip_remaining: true };
          }
          return { ok: true, actionable_count: actionable.length };
        },
      },
      { name: 'auto_healer', agent: 'auto-healer', critical: false },
      {
        name: 'health_sentinel_post',
        agent: 'health-sentinel',
        critical: false,
        compare: (post, pre) => {
          const preIds = new Set((pre?.anomalies || []).map(a => a.id));
          const postIds = new Set((post?.anomalies || []).map(a => a.id));
          const resolved = [...preIds].filter(id => !postIds.has(id));
          const new_anomalies = [...postIds].filter(id => !preIds.has(id));
          return { resolved, new_anomalies, persistent: [...preIds].filter(id => postIds.has(id)) };
        },
      },
    ],
  },

  // Workflow: investigação de coverage gap.
  // Live Scout detecta gap → Feed Medic verifica fonte externa → relatório consolidado.
  coverage_investigation: {
    description: 'Live Scout + Feed Medic pra investigar gaps de cobertura',
    steps: [
      { name: 'live_scout', agent: 'live-scout', critical: true },
      {
        name: 'check_gaps',
        custom: (ctx) => {
          const gaps = ctx.live_scout?.gaps || [];
          if (!gaps.length) {
            ctx.shortcircuit = { reason: 'no_gaps' };
            return { ok: true, skip_remaining: true };
          }
          return { ok: true, gaps_count: gaps.length };
        },
      },
      { name: 'feed_medic', agent: 'feed-medic', critical: false },
    ],
  },

  // Workflow: review semanal completo.
  // Weekly Review (portfolio) + ROI Analyst (deep stats) + Health Sentinel (problemas).
  weekly_full: {
    description: 'Review completo: portfolio + ROI + saúde do sistema',
    steps: [
      { name: 'weekly_review', agent: 'weekly-review', critical: true },
      { name: 'roi_analyst', agent: 'roi-analyst', critical: false, args: { days: 30 } },
      { name: 'health_sentinel', agent: 'health-sentinel', critical: false },
    ],
  },

  // Workflow: tip emergency — line moveu adverso, news quebraram contexto.
  tip_emergency: {
    description: 'Detecta tips em risco (odds mexeram, news adversas, match cancelado)',
    steps: [
      { name: 'pre_match_check', agent: 'pre-match-check', critical: true, args: { windowMin: 60 } },
      {
        name: 'check_alerts',
        custom: (ctx) => {
          const alerts = ctx.pre_match_check?.alerts || [];
          if (alerts.length === 0) {
            ctx.shortcircuit = { reason: 'no_tip_emergencies' };
            return { ok: true, skip_remaining: true };
          }
          return { ok: true, alerts_count: alerts.length };
        },
      },
      { name: 'feed_medic', agent: 'feed-medic', critical: false },
    ],
  },

  // Workflow: daily health — roda 1x/dia 8h BRT, gera relatório consolidado.
  daily_health: {
    description: 'Relatório diário: portfolio + ROI + saúde + bankroll',
    steps: [
      { name: 'weekly_review', agent: 'weekly-review', critical: false },
      { name: 'bankroll_guardian', agent: 'bankroll-guardian', critical: true },
      { name: 'health_sentinel', agent: 'health-sentinel', critical: false },
      { name: 'ia_health', agent: 'ia-health', critical: false },
      { name: 'cut_advisor', agent: 'cut-advisor', critical: false },
    ],
  },

  // Workflow: incident response — quando critical anomaly aparece, roda full diag agressivo.
  incident_response: {
    description: 'Resposta a incidente crítico: diagnóstico paralelo + healer',
    steps: [
      { name: 'health_sentinel', agent: 'health-sentinel', critical: true },
      { name: 'live_scout', agent: 'live-scout', critical: false },
      { name: 'feed_medic', agent: 'feed-medic', critical: false },
      { name: 'auto_healer', agent: 'auto-healer', critical: false },
      { name: 'health_sentinel_post', agent: 'health-sentinel', critical: false,
        compare: (post, pre) => {
          const preIds = new Set((pre?.anomalies || []).map(a => a.id));
          const postIds = new Set((post?.anomalies || []).map(a => a.id));
          return {
            resolved: [...preIds].filter(id => !postIds.has(id)),
            persistent: [...preIds].filter(id => postIds.has(id)),
            new_anomalies: [...postIds].filter(id => !preIds.has(id)),
          };
        },
      },
    ],
  },

  // Workflow: model health check — calibração + IA + bankroll por sport.
  model_check: {
    description: 'Saúde dos modelos: calibração + IA quality + bankroll',
    steps: [
      { name: 'model_calibration', agent: 'model-calibration', critical: true },
      { name: 'ia_health', agent: 'ia-health', critical: false },
      { name: 'bankroll_guardian', agent: 'bankroll-guardian', critical: false },
    ],
  },
};

/**
 * Executa um workflow. Cada step pode ser:
 *  - { agent: 'name' } → invoca agent registrado em ctx.agents[name]
 *  - { custom: fn(ctx) } → executa função arbitrária
 * @param {string} workflowName — nome do workflow registrado em WORKFLOWS
 * @param {object} ctx — { agents, log, ... }
 * @returns {Promise<{workflow, steps, summary}>}
 */
async function runWorkflow(workflowName, ctx) {
  const wf = WORKFLOWS[workflowName];
  if (!wf) return { ok: false, error: `workflow ${workflowName} não registrado` };
  const result = {
    workflow: workflowName,
    description: wf.description,
    started_at: Date.now(),
    steps: [],
    context: {},
  };
  for (const step of wf.steps) {
    const stepStart = Date.now();
    let stepResult = { name: step.name, ok: false };
    try {
      if (step.custom) {
        const customRes = await step.custom(result.context);
        stepResult = { name: step.name, type: 'custom', ...customRes, duration_ms: Date.now() - stepStart };
        if (customRes?.skip_remaining) {
          result.steps.push(stepResult);
          break;
        }
      } else if (step.agent) {
        const agentFn = ctx.agents?.[step.agent];
        if (!agentFn) {
          stepResult = { name: step.name, type: 'agent', agent: step.agent, ok: false, error: 'agent não registrado em ctx.agents' };
          if (step.critical) { result.steps.push(stepResult); break; }
          result.steps.push(stepResult);
          continue;
        }
        const data = await agentFn(step.args);
        result.context[step.name] = data;
        stepResult = { name: step.name, type: 'agent', agent: step.agent, ok: !!data?.ok, duration_ms: Date.now() - stepStart, data_summary: summarize(data) };
        if (step.compare && result.context[step.name.replace('_post', '')]) {
          stepResult.comparison = step.compare(data, result.context[step.name.replace('_post', '')]);
        }
        if (step.critical && !stepResult.ok) {
          result.steps.push(stepResult);
          break;
        }
      }
    } catch (e) {
      stepResult = { name: step.name, ok: false, error: e.message, duration_ms: Date.now() - stepStart };
      if (typeof ctx.log === 'function') ctx.log('ERROR', 'ORCHESTRATOR', `step ${step.name}: ${e.message}`);
      if (step.critical) { result.steps.push(stepResult); break; }
    }
    result.steps.push(stepResult);
  }
  result.completed_at = Date.now();
  result.duration_ms = result.completed_at - result.started_at;
  result.shortcircuit = result.context.shortcircuit || null;
  result.summary = buildSummary(result);
  result.ok = true;
  return result;
}

function summarize(data) {
  if (!data) return null;
  const out = {};
  if (data.summary) out.summary = data.summary;
  if (typeof data.anomalies?.length === 'number') out.anomalies_count = data.anomalies.length;
  if (typeof data.gaps?.length === 'number') out.gaps_count = data.gaps.length;
  if (typeof data.actions?.length === 'number') out.actions_count = data.actions.length;
  if (typeof data.applied?.length === 'number') out.applied_count = data.applied.length;
  if (typeof data.matrix?.length === 'number') out.buckets_count = data.matrix.length;
  if (typeof data.totalLive === 'number') out.totalLive = data.totalLive;
  return Object.keys(out).length ? out : null;
}

function buildSummary(result) {
  const ok = result.steps.filter(s => s.ok).length;
  const fail = result.steps.filter(s => !s.ok).length;
  return {
    steps_ok: ok,
    steps_failed: fail,
    duration_ms: result.duration_ms,
    shortcircuit: result.shortcircuit,
  };
}

function listWorkflows() {
  return Object.entries(WORKFLOWS).map(([name, wf]) => ({
    name, description: wf.description, steps: wf.steps.map(s => s.name),
  }));
}

module.exports = { runWorkflow, listWorkflows, WORKFLOWS };
