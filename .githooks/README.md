# Git hooks SportsEdge-Bot

Hooks versionados (vs `.git/hooks/` que é local-only).

## Ativação (1× por máquina)

```bash
git config core.hooksPath .githooks
```

No Windows o Git Bash já entende `#!/usr/bin/env bash` e respeita o flag executable. Se hook não disparar, force permissão:

```bash
chmod +x .githooks/pre-commit
```

Validar ativação:

```bash
git config --get core.hooksPath
# deve retornar: .githooks
```

## O que o pre-commit faz

**Hard gates (bloqueiam commit, exit 1):**
1. **Syntax check** `node -c` em todo `.js` staged. Erro = commit blocked.
2. **`DELETE FROM tips`** detectado em diff. CLAUDE.md: soft-delete only.
3. **Limite SAGRADO** alterado em código: `MAX_KELLY_FRAC`, `KELLY_AUTO_TUNE_CEILING`, `MT_MIN_ODD`, `MT_EV_CAP_PCT`, `DAILY_TIP_LIMIT`.

**Soft warnings (printa, exit 0):**
- `catch (_) {}` ou `catch (e) {}` silencioso adicionado
- `console.log/error/warn` adicionado (deveria usar helper `log()`)
- `var` em código novo (CLAUDE.md: const/let only)
- `// TODO` / `// FIXME` adicionados (CLAUDE.md: resolve agora)
- `process.env.X` nova sem entry em `.env.example`

## Performance

Roda em ~1-2s típico (só inspeciona arquivos staged). Diff parsing via `git diff --cached -U0` — não toca files outside diff.

## Escape hatch

```bash
git commit --no-verify
```

CLAUDE.md desencoraja sem motivo justificado. Quando usar legitimamente:
- Cherry-pick com conflict marker resolvido manualmente onde hook trava em syntax falso-positivo
- Commit de docs/markdown puro (mas hook não bloqueia esses paths)
- Emergência financeira que exige bypass + justificativa no commit message

## Auditoria profunda

Pre-commit é fast-gate. Pra revisão profunda, use slash commands:

- `/audit-dinheiro` — Kelly/EV/stake bugs em diff
- `/audit-shadow-real` — P2 compliance
- `/audit-granularidade` — P1 dimensões
- `/audit-externos` — Pinnacle/Sofa/PandaScore timeouts
- `/audit-banco` — SQLite OLAP/OLTP/migrations
- `/audit-adversarial` — pentest mindset

Estes invocam AI no diff staged + repo context. Levam 10-30s vs 1-2s do hook.

## Adicionar novo gate

Edita `.githooks/pre-commit`, segue o padrão:

```bash
PATTERN=$(git diff --cached -U0 -- $STAGED_JS 2>/dev/null | grep -E '^\+.*BADTHING' | head -5 || true)
if [ -n "$PATTERN" ]; then
  echo "❌ [pre-commit] descrição"
  echo "$PATTERN"
  exit 1  # ou WARNINGS+= pra soft
fi
```

Mantém `set -e`, `head -5` pra limitar output, `2>/dev/null` em greps que podem retornar empty.
