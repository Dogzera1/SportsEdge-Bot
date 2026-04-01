async function handleNotificacoes(token, chatId, sport, action) {
  const config = SPORTS[sport];
  const userPrefs = subscribedUsers.get(chatId) || new Set();
  
  if (action === 'on') {
    userPrefs.add(sport);
    subscribedUsers.set(chatId, userPrefs);
    
    await serverPost('/save-user', {
      userId: chatId,
      subscribed: true,
      sportPrefs: [...userPrefs]
    });
    
    await send(token, chatId,
      `✅ Notificações ${config.name} ativadas!\n\n` +
      `Você receberá:\n` +
      `• ${config.icon} Tips automáticas com +EV\n` +
      `• 📉 Alertas de line movement > 10%\n\n` +
      `Use /notificacoes off para desativar`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: '🔕 Desativar', callback_data: `notif_${sport}_off` }]]
        }
      }
    );
  } else if (action === 'off') {
    userPrefs.delete(sport);
    subscribedUsers.set(chatId, userPrefs);
    
    await serverPost('/save-user', {
      userId: chatId,
      subscribed: userPrefs.size > 0,
      sportPrefs: [...userPrefs]
    });
    
    await send(token, chatId,
      `🔕 Notificações ${config.name} desativadas.`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: '🔔 Ativar', callback_data: `notif_${sport}_on` }]]
        }
      }
    );
  } else {
    const isActive = userPrefs.has(sport);
    await send(token, chatId,
      `🔔 *Notificações ${config.name}*\n\n` +
      `Status: ${isActive ? '✅ Ativado' : '❌ Desativado'}\n\n` +
      `Comandos:\n` +
      `/notificacoes on — Ativar\n` +
      `/notificacoes off — Desativar`
    );
  }
}

async function handleProximas(token, chatId, sport) {
  try {
    const data = await serverGet('/upcoming-fights?days=3', sport).catch(() => []);
    if (!Array.isArray(data) || !data.length) {
      await send(token, chatId, '❌ Nenhuma partida próxima com odds detectada para as próximas 72h.\n_Fique de olho, atualizamos os escaneamentos hora a hora!_');
      return;
    }
    
    let txt = `📅 *PRÓXIMAS PARTIDAS (${data.length})*\n\n`;
    data.slice(0, 10).forEach(m => {
      const gIcon = (m.game === 'lol') ? '🎮 LoL' : (m.game === 'dota') ? '🌋 Dota' : '🎮';
      txt += `${gIcon} | ${m.team1} vs ${m.team2}\n`;
      txt += `🕐 ${new Date(m.date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n`;
      
      if (m.odds_t1 && m.odds_t2) {
        txt += `💰 ${m.team1}: ${m.odds_t1} | ${m.team2}: ${m.odds_t2}\n`;
      } else {
        txt += `_Odds ainda não publicadas_\n`;
      }
      txt += '\n';
    });
    
    if (data.length > 10) txt += `_E mais ${data.length - 10} partidas._`;
    await send(token, chatId, txt);
  } catch (e) {
    await send(token, chatId, `❌ Erro ao buscar próximas: ${e.message}`);
  }
}
