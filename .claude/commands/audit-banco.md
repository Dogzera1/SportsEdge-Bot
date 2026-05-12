---
description: Audita SQLite better-sqlite3 — queries, índices, migrations, OLAP em hot path
---

Stack: SQLite via better-sqlite3 + WAL + Railway 512MB cap. OLAP em hot path = OOM. Migration ausente = schema drift.

Auditar `$1` (default = diff atual) procurando problemas DB.

## O que procurar

**Queries lentas (sem índice):**
1. `WHERE sport=? AND market=? AND side=? AND result=?` sem índice composto adequado
2. `JOIN tips t ON` com REPLACE recursivo + julianday() — KNOWN benigno (`lib/market-tips-shadow.js:1397-1403`), só flag se aparecer em path quente novo
3. `SELECT *` em `tips` (~30k rows) ou `market_tips_shadow` (~30k rows) ou `match_results` (large) sem LIMIT/index
4. Subquery `IN (SELECT MAX(id) ...)` sem `GROUP BY` indexed col

**OLTP vs OLAP (Railway 512MB):**
5. OLAP query (agregação grande, GROUP BY multi-col) sendo executada em path quente (per-request, per-tip-emit, per-poll)
6. `isMemCritical()` check ausente em cron de relatório
7. Cron sem guard `_wrapCron` (commit 63636cc adicionou em 8 crons)

**Migrations:**
8. `ALTER TABLE`/`CREATE TABLE` em código fora de `migrations/index.js`
9. Migration nova sem `IF NOT EXISTS` em CREATE/INDEX
10. `addColumnIfMissing` ausente quando coluna pode já existir
11. Migration sem rollback documentado OR não-reversível (`DROP COLUMN` SQLite quebra <3.35)
12. Migration que faz UPDATE massivo sem `WITHIN TRANSACTION`

**Tips integrity (CLAUDE.md):**
13. `DELETE FROM tips` em vez de `UPDATE tips SET archived=1` — soft delete only
14. Query real-only sem `WHERE archived=0 AND is_shadow=0`
15. UPDATE em `result`/`profit_reais`/`stake_units` sem audit em `tip_settlement_audit` (mig 073)

**Pragmas Railway-specific:**
16. `PRAGMA cache_size` sobrescrito acima de -8000 (8MB cap pós-OOM fix)
17. `PRAGMA mmap_size` sobrescrito acima de 0
18. `PRAGMA journal_mode` mexido em runtime (deve ser WAL set at boot)

**Concorrência:**
19. Read+write em mesma row sem `BEGIN TRANSACTION`
20. `INSERT OR IGNORE` em UNIQUE constraint sem ON CONFLICT explícito
21. Race condition em counter (`UPDATE x SET n = n + 1` é OK; `SELECT n; UPDATE x SET n = ?` não é)

## Status conhecido

- ✅ DB_PATH usa `sportsedge.db` (~155MB) + WAL mode
- ✅ Cache cap 8MB + mmap=0 (commit 8401ffe pós-OOM)
- ✅ Migrations sequencialmente numeradas em `migrations/index.js` (última: 099 ml_auto_promote)
- ⚠️ MT-GUARD slow queries 350-481ms = KNOWN benign (lib/market-tips-shadow.js:1397) — não flag

## Output

```
migrations/index.js:N — mig 100 sem rollback documentado
server.js:1234 — query OLAP em /admin/x sem isMemCritical guard
lib/x.js:88 — DELETE FROM tips em vez de UPDATE archived=1 (viola CLAUDE.md "Soft delete only")
```

Severity: data loss >> OOM risk >> performance >> compliance.
