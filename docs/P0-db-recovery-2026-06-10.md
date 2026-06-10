# P0 — DB prod "database disk image is malformed" (2026-06-10)

## Estado (12:40Z)
- `PRAGMA integrity_check` falhando desde o boot 11:44Z (deploy `8647c9e`); persiste em re-checks do cron 15min.
- **Corrupção DELIMITADA**: `DELETE FROM match_result_sources` lança `database disk image is malformed`; `VACUUM` idem (varre tudo). **Todas** as leituras/writes de tabelas de dinheiro passam (tips, market_tips_shadow, settles fluindo, bankroll ok).
- `match_result_sources` = trilha de auditoria de payloads de settle (mig 109, observability). **Não guarda dinheiro.** Perda aceitável (re-popula com settles novos).
- Coincidiu com deploy 11:44Z — primeiro check pós-boot já falhou. Conteúdo dos commits não toca schema (cs-ml WHERE + pinnacle body cap). Suspeita: kill/replace do container durante write + volume.
- DM Telegram do bot (cron `db_integrity_check`) tem as linhas exatas do erro.

## Variante A — cirurgia via `railway ssh` (PREFERIDA, sem deploy)
Pré-requisito: `railway login` (token expirou) + link no project `believable-imagination` / service `SportsEdge-Bot` / env `production`.

### A1. Diagnóstico (escopo exato)
```bash
railway ssh -- node -e "const db=require('/app/node_modules/better-sqlite3')('/data/sportsedge.db',{readonly:true}); const r=db.pragma('integrity_check',{simple:false}); console.log(JSON.stringify(r.slice(0,20),null,1));"
```
Esperado: linhas mencionando `match_result_sources` / `idx_mrs_*`. Se mencionar OUTRAS tabelas → pular para Variante B.

### A2. Cirurgia (drop + recreate, schema da mig 109)
```bash
railway ssh -- node -e "const db=require('/app/node_modules/better-sqlite3')('/data/sportsedge.db'); db.exec('DROP TABLE IF EXISTS match_result_sources'); db.exec('CREATE TABLE match_result_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL, game TEXT NOT NULL, source TEXT NOT NULL, team1 TEXT, team2 TEXT, winner TEXT NOT NULL, final_score TEXT, recorded_at TEXT NOT NULL DEFAULT (datetime(\'now\')))'); db.exec('CREATE INDEX idx_mrs_match ON match_result_sources(match_id, game)'); db.exec('CREATE INDEX idx_mrs_recent ON match_result_sources(recorded_at DESC)'); db.exec('CREATE INDEX idx_mrs_game_recorded ON match_result_sources(game, recorded_at DESC)'); console.log('recreated ok');"
```
Se o DROP lançar malformed → Variante B.

### A3. Verificação + reclaim
1. `railway ssh -- node -e "...integrity_check..."` (mesmo de A1) → esperar `[{"integrity_check":"ok"}]`.
2. VACUUM via endpoint (Claude faz): `POST /admin/match-result-sources-cleanup?apply=1&vacuum=1&retention_days=1` → esperar `vacuumed:true`.
3. Gauge: `/metrics` → `bot:db_integrity_ok` flipa pra 1 no próximo cron (≤15min).

## Variante B — rebuild copy (.recover-style, se A falhar)
```bash
railway ssh
# dentro do container:
node -e "
const Better=require('/app/node_modules/better-sqlite3');
const src=new Better('/data/sportsedge.db',{readonly:true});
const dst=new Better('/data/sportsedge_new.db');
dst.pragma('journal_mode=WAL');
const objs=src.prepare(\"SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END\").all();
for (const o of objs.filter(o=>o.type==='table')) { try { dst.exec(o.sql); } catch(e){ console.log('skip schema',o.name,e.message); } }
for (const o of objs.filter(o=>o.type==='table')) {
  if (o.name==='match_result_sources') { console.log('skip data mrs (corrupta, descartável)'); continue; }
  try {
    const cols=src.prepare('PRAGMA table_info('+o.name+')').all().map(c=>c.name);
    const ins=dst.prepare('INSERT OR IGNORE INTO '+o.name+' ('+cols.join(',')+') VALUES ('+cols.map(()=>'?').join(',')+')');
    let n=0; const tx=dst.transaction(rows=>{ for(const r of rows){ ins.run(cols.map(c=>r[c])); n++; } });
    const all=src.prepare('SELECT * FROM '+o.name).iterate();
    let batch=[];
    for (const row of all){ batch.push(row); if(batch.length>=5000){ tx(batch); batch=[]; } }
    if (batch.length) tx(batch);
    console.log(o.name, n);
  } catch(e){ console.log('TABLE FAIL', o.name, e.message); }
}
for (const o of objs.filter(o=>o.type!=='table')) { try { dst.exec(o.sql); } catch(e){ console.log('skip idx',o.name,e.message); } }
console.log('integrity new:', JSON.stringify(dst.pragma('integrity_check',{simple:false}).slice(0,3)));
"
# se integrity ok: parar serviço (railway down/restart), trocar arquivos:
mv /data/sportsedge.db /data/sportsedge_corrupt_2026_06_10.db && mv /data/sportsedge_new.db /data/sportsedge.db
# restart service no dashboard
```

## Pós-recovery (Claude faz)
- `/health` status=ok, alert some; `/metrics` db_integrity_ok=1.
- `/admin/forensics` (usa match_result_sources) responde vazio mas sem erro.
- Monitorar integrity por 24h (cron 15min já alerta).
- Root-cause: investigar política de replace do Railway (overlap de container + volume compartilhado durante deploy). Considerar `BOOT_INTEGRITY_SYNC=true` temporário.

## Não fazer
- ❌ Deploy/push até recovery completo (deploy foi o gatilho aparente; migration de drop à boot pode boot-loopar se DROP falhar).
- ❌ `.recover`/sqlite3 CLI não existe no container slim — só better-sqlite3 via node.
