const SPORTS = {
  esports: {
    id: 'esports',
    name: 'Esports',
    icon: '🎮',
    // Ativado por default se token existir. Desativa apenas se ESPORTS_ENABLED=false explicitamente.
    enabled: process.env.ESPORTS_ENABLED !== 'false' && !!process.env.TELEGRAM_TOKEN_ESPORTS,
    token: process.env.TELEGRAM_TOKEN_ESPORTS,
    games: ['lol']
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