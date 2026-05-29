#!/bin/bash
# Validate shadow flip — run AFTER Railway redeploy completes (~2min)
# Expected: 8 sports show set=true truthy=true for *_SHADOW; tennis unset.
KEY="14725836"
BASE="https://sportsedge-bot-production.up.railway.app"

echo "=== /admin/sport-shadow-envs ==="
curl -s --ssl-no-revoke -H "x-admin-key: $KEY" "$BASE/admin/sport-shadow-envs" | python -c "
import json, sys
d = json.load(sys.stdin)
out = d.get('result') or d.get('out') or d
sports = ['tennis','lol','dota2','cs','valorant','mma','football','darts','snooker','basket','tabletennis']
print(f\"{'SPORT':<14} {'<S>_SHADOW':<22} {'effective':<12}\")
print('─' * 50)
for s in sports:
  sport_data = (out.get(s) if isinstance(out, dict) else {}) or {}
  key = s.upper() + '_SHADOW'
  v = sport_data.get(key, {})
  set_val = v.get('set')
  truthy = v.get('truthy')
  raw = v.get('value', '<unset>')
  effective = '🌑 SHADOW' if truthy else ('🎯 REAL' if set_val else '🎯 REAL (default)')
  if s in ('tabletennis','basket') and not set_val: effective = '🌑 SHADOW (default)'
  print(f'{s:<14} {raw:<22} {effective:<12}')
"

echo ""
echo "=== Recent log lines showing [SHADOW] tag ==="
echo "Run on Railway dashboard Logs filter (last 5min):"
echo '  grep -E "AUTO-(LOL|CS|VAL|DOTA|MMA|FOOTBALL|DARTS|SNOOKER).*\\[SHADOW\\]"'
