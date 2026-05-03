// shadowMode: tip é gerada e registrada no DB, mas NÃO envia DM (para auditoria de CLV)
// Ativar via <SPORT>_SHADOW=true no env. Usado em novos esportes antes de promoção.
function shadowFor(sport) {
  return process.env[`${sport.toUpperCase()}_SHADOW`] === 'true';
}

const SPORTS = {
  esports: {
    id: 'esports',
    name: 'Esports',
    icon: '🎮',
    // Ativado por default se token existir. Desativa apenas se ESPORTS_ENABLED=false explicitamente.
    enabled: process.env.ESPORTS_ENABLED !== 'false' && !!process.env.TELEGRAM_TOKEN_ESPORTS,
    token: process.env.TELEGRAM_TOKEN_ESPORTS,
    games: ['lol'],
    shadowMode: shadowFor('esports')
  },
  mma: {
    id: 'mma',
    name: 'MMA',
    icon: '🥊',
    enabled: process.env.MMA_ENABLED === 'true' && !!process.env.TELEGRAM_TOKEN_MMA,
    token: process.env.TELEGRAM_TOKEN_MMA,
    games: ['mma'],
    shadowMode: shadowFor('mma')
  },
  tennis: {
    id: 'tennis',
    name: 'Tênis',
    icon: '🎾',
    enabled: process.env.TENNIS_ENABLED === 'true' && !!process.env.TELEGRAM_TOKEN_TENNIS,
    token: process.env.TELEGRAM_TOKEN_TENNIS,
    games: ['tennis'],
    shadowMode: shadowFor('tennis')
  },
  football: {
    id: 'football',
    name: 'Futebol',
    icon: '⚽',
    enabled: process.env.FOOTBALL_ENABLED === 'true' && !!process.env.TELEGRAM_TOKEN_FOOTBALL,
    token: process.env.TELEGRAM_TOKEN_FOOTBALL,
    games: ['football'],
    shadowMode: shadowFor('football')
  },
  darts: {
    id: 'darts',
    name: 'Darts',
    icon: '🎯',
    enabled: process.env.DARTS_ENABLED === 'true' && !!process.env.TELEGRAM_TOKEN_DARTS,
    token: process.env.TELEGRAM_TOKEN_DARTS,
    games: ['darts'],
    // Default FORA de shadow (graduado). Para voltar: DARTS_SHADOW=true
    shadowMode: process.env.DARTS_SHADOW === 'true'
  },
  snooker: {
    id: 'snooker',
    name: 'Snooker',
    icon: '🎱',
    // Fonte de odds: Pinnacle guest API (funciona do BR, sem auth).
    // Betfair Exchange bloqueia IPs brasileiros, por isso não é usado.
    enabled: process.env.SNOOKER_ENABLED === 'true' && !!process.env.TELEGRAM_TOKEN_SNOOKER,
    token: process.env.TELEGRAM_TOKEN_SNOOKER,
    games: ['snooker'],
    // GRADUADO: enrichment CueTracker (win rate temporada atual) fornece 2º fator do ML.
    // Combinado com implied odds Pinnacle, gera edge calculável.
    // Voltar pra shadow: SNOOKER_SHADOW=true
    shadowMode: process.env.SNOOKER_SHADOW === 'true'
  },
  cs: {
    id: 'cs',
    name: 'Counter-Strike 2',
    icon: '🔫',
    // Graduado (abr/2026). Pra voltar pra shadow: CS_SHADOW=true
    enabled: process.env.CS_ENABLED === 'true' && !!process.env.TELEGRAM_TOKEN_CS,
    token: process.env.TELEGRAM_TOKEN_CS,
    games: ['cs'],
    shadowMode: process.env.CS_SHADOW === 'true'
  },
  valorant: {
    id: 'valorant',
    name: 'Valorant',
    icon: '🎯',
    // Graduado (abr/2026). Compartilha o bot Telegram do CS (TELEGRAM_TOKEN_CS)
    // por padrão. Pra voltar pra shadow: VALORANT_SHADOW=true
    enabled: process.env.VALORANT_ENABLED === 'true' && !!(process.env.TELEGRAM_TOKEN_VALORANT || process.env.TELEGRAM_TOKEN_CS),
    token: process.env.TELEGRAM_TOKEN_VALORANT || process.env.TELEGRAM_TOKEN_CS,
    games: ['valorant'],
    shadowMode: process.env.VALORANT_SHADOW === 'true'
  },
  tabletennis: {
    id: 'tabletennis',
    name: 'Tênis de Mesa',
    icon: '🏓',
    // Novo esporte (abr/2026). Começa em shadow para validar calibração antes de enviar DMs.
    // Graduação: setar TABLETENNIS_SHADOW=false quando CLV médio positivo por ~30 tips.
    enabled: process.env.TABLETENNIS_ENABLED === 'true' && !!process.env.TELEGRAM_TOKEN_TABLETENNIS,
    token: process.env.TELEGRAM_TOKEN_TABLETENNIS,
    games: ['tabletennis'],
    // Default EM shadow até validar. Sem DM, só registra no DB.
    shadowMode: process.env.TABLETENNIS_SHADOW !== 'false'
  },
  basket: {
    id: 'basket',
    name: 'Basquete (NBA)',
    icon: '🏀',
    // Novo esporte (mai/2026). Sources: ESPN scoreboard (NBA primário, futuro: Euroleague)
    // + The Odds API basketball_nba. Modelo: Elo + Pinnacle implied. ML markets only fase 1.
    // Sempre em shadow até CLV médio positivo + n≥30 settled. Sem DM (registra DB).
    // Token opcional — se não setado, usa TELEGRAM_TOKEN_FOOTBALL como fallback (admin DM).
    enabled: process.env.BASKET_ENABLED === 'true' && !!(process.env.TELEGRAM_TOKEN_BASKET || process.env.TELEGRAM_TOKEN_FOOTBALL || process.env.TIPS_UNIFIED_TOKEN),
    token: process.env.TELEGRAM_TOKEN_BASKET || process.env.TELEGRAM_TOKEN_FOOTBALL || process.env.TIPS_UNIFIED_TOKEN,
    games: ['basket'],
    // Default EM shadow. Para promover quando validado: BASKET_SHADOW=false
    shadowMode: process.env.BASKET_SHADOW !== 'false'
  }
};

module.exports = {
  SPORTS,
  getSportById: (id) => SPORTS[id] || null,
  getSportByToken: (token) => Object.values(SPORTS).find(s => s.token === token) || null,
  getEnabledSports: () => Object.values(SPORTS).filter(s => s.enabled),
  getTokenToSportMap: () => {
    const map = {};
    for (const sport of Object.values(SPORTS)) {
      if (sport.enabled && sport.token) map[sport.token] = sport.id;
    }
    return map;
  }
};