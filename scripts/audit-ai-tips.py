#!/usr/bin/env python3
"""
Audit recurring AI tips (shadow + real) — qualquer sport.

Usage:
  python3 ai_audit.py                  # audit todos sports 90d
  python3 ai_audit.py mma 30           # mma 30d
  python3 ai_audit.py tennis 60        # tennis 60d
  python3 ai_audit.py mma 30 verbose   # mma 30d + lista cada tip settled
"""
import json, subprocess, sys, math
from collections import Counter, defaultdict

BASE = "https://sportsedge-bot-production.up.railway.app"
KEY = "14725836"
SPORTS_ALL = ["lol", "dota2", "cs", "valorant", "tennis", "football", "mma", "basket"]

args = sys.argv[1:]
sports_filter = [args[0]] if args and args[0] in SPORTS_ALL else SPORTS_ALL
days = int(args[1]) if len(args) > 1 and args[1].isdigit() else 90
verbose = "verbose" in args

def wilson(s, n, z=1.96):
    if n == 0: return (0, 0)
    p = s / n
    den = 1 + z * z / n
    cen = p + z * z / (2 * n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((cen - half) / den, (cen + half) / den)

all_tips = []
for sp in sports_filter:
    url = f"{BASE}/tips-history?sport={sp}&days={days}&include_markets=1&include_shadow=1&include_pending=1&limit=5000&key={KEY}"
    try:
        r = subprocess.run(["curl", "-sS", "-k", "--ssl-no-revoke", "-m", "60", url],
                           capture_output=True, text=True, timeout=70)
        d = json.loads(r.stdout)
        if isinstance(d, list):
            for t in d: t["_sport_q"] = sp
            all_tips += d
    except Exception as e:
        print(f"  {sp}: err {e}", file=sys.stderr)

ai_tips = []
for t in all_tips:
    reason = str(t.get('tip_reason') or '')
    em = str(t.get('emission_source') or '')
    # 2026-05-22: filter ampliado — CS/Dota/Val usam format inline "| IA:" em vez de
    # "AI shadow POC (...)". Audit anterior subestimou CS AI volume (2 → 37 em 90d).
    is_ai = (
        'AI shadow POC' in reason
        or reason.startswith('AI ML ')
        or 'DeepSeek' in reason
        or '| IA' in reason            # "Elo: ... | IA: model-override"
        or 'IA shadow' in reason.lower()
        or '_ai_' in em.lower()
    )
    if not is_ai: continue
    if '_ai_real' in em.lower(): kind = 'real'
    elif '_ai_shadow' in em.lower(): kind = 'shadow'
    elif reason.startswith('AI ML '): kind = 'real'
    elif t.get('is_shadow') == 0: kind = 'real'
    else: kind = 'shadow'
    t['_ai_kind'] = kind
    ai_tips.append(t)

print(f"\n=== AI tips audit — sports={','.join(sports_filter)} window={days}d ===")
print(f"AI tips total: {len(ai_tips)}\n")

grp = defaultdict(lambda: {'n': 0, 'win': 0, 'loss': 0, 'void': 0, 'pending': 0,
                            'stake': 0.0, 'profit': 0.0, 'ev_sum': 0.0, 'odds_sum': 0.0})
for t in ai_tips:
    sp = t.get('sport', '?')
    key = f"{sp}|{t['_ai_kind']}"
    g = grp[key]
    g['n'] += 1
    res = t.get('result')
    if res == 'win': g['win'] += 1
    elif res == 'loss': g['loss'] += 1
    elif res == 'void': g['void'] += 1
    else: g['pending'] += 1
    try:
        g['stake'] += float(t.get('stake_reais') or 0)
        g['profit'] += float(t.get('profit_reais') or 0)
        g['ev_sum'] += float(t.get('ev') or 0)
        g['odds_sum'] += float(t.get('odds') or 0)
    except: pass

print(f"{'sport|kind':<18} | {'n':>4} {'W':>3} {'L':>3} {'V':>3} {'P':>3} | {'sett':>4} {'hit%':>5} {'wilson95%':>14} | {'stake':>7} {'profit':>7} {'ROI%':>7} | {'avgEV':>6} {'avgO':>5}")
print("-" * 138)
for k in sorted(grp.keys(), key=lambda x: -grp[x]['n']):
    g = grp[k]
    sett = g['win'] + g['loss']
    hit = (g['win'] / sett * 100) if sett else 0
    wl, wh = wilson(g['win'], sett) if sett else (0, 0)
    roi = (g['profit'] / g['stake'] * 100) if g['stake'] > 0 else 0
    avg_ev = g['ev_sum'] / g['n'] if g['n'] else 0
    avg_odds = g['odds_sum'] / g['n'] if g['n'] else 0
    w_str = f"[{wl*100:5.1f},{wh*100:5.1f}]" if sett else "    -        "
    print(f"{k:<18} | {g['n']:>4} {g['win']:>3} {g['loss']:>3} {g['void']:>3} {g['pending']:>3} | {sett:>4} {hit:>5.1f} {w_str:>14} | {g['stake']:>7.2f} {g['profit']:>7.2f} {roi:>7.2f} | {avg_ev:>6.1f} {avg_odds:>5.2f}")

if verbose:
    print("\n=== Settled tips per sport ===")
    by_sport = defaultdict(list)
    for t in ai_tips:
        if t.get('result') in ('win', 'loss', 'void'):
            by_sport[t.get('sport', '?')].append(t)
    for sp, tips in sorted(by_sport.items()):
        tips.sort(key=lambda x: x.get('sent_at') or '', reverse=True)
        print(f"\n--- {sp} ({len(tips)} settled) ---")
        for t in tips[:30]:
            sa = str(t.get('sent_at', ''))[:16]
            rs = t.get('result')
            sym = 'WIN ' if rs == 'win' else 'LOSS' if rs == 'loss' else 'VOID'
            ev = t.get('ev', '?'); od = t.get('odds', '?')
            tp = (t.get('tip_participant') or '?')[:24]
            ev_name = (t.get('event_name') or t.get('league') or '?')[:30]
            p1 = (t.get('participant1') or '?')[:16]
            p2 = (t.get('participant2') or '?')[:16]
            pf = t.get('profit_reais', 0)
            is_sh = t.get('is_shadow', 0)
            print(f"  {sym} {sa} sh={is_sh} {ev_name:<30} {p1}/{p2:<16} -> {tp:<24} @ {od} EV={ev}% pf={pf}")

# Pending
print(f"\n=== Pending AI tips ({sum(1 for t in ai_tips if t.get('result') is None)} total) ===")
pending = [t for t in ai_tips if t.get('result') is None]
pending.sort(key=lambda x: x.get('sent_at') or '')
for t in pending[:30]:
    sa = str(t.get('sent_at', ''))[:16]
    sp = t.get('sport', '?')
    ev = t.get('ev', '?'); od = t.get('odds', '?')
    tp = (t.get('tip_participant') or '?')[:24]
    ev_name = (t.get('event_name') or t.get('league') or '?')[:30]
    p1 = (t.get('participant1') or '?')[:18]
    p2 = (t.get('participant2') or '?')[:18]
    print(f"  {sp:<8} {sa} {ev_name:<30} {p1}/{p2:<18} -> {tp:<24} @ {od} EV={ev}%")
