#!/usr/bin/env bash
# Rauchtest im Android-Emulator: installieren, starten, Marktanalyse antippen, Anmelde-Rücksprung, Einstellungen, Absturzprüfung.
set -u
PKG=de.achmo.kiautopilot
fail() { echo "SMOKE FEHLER: $*"; adb logcat -d | grep -E "AndroidRuntime|FATAL|$PKG|KIAP" | tail -80; exit 1; }

ui() {
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  adb shell cat /sdcard/ui.xml > ui.xml
  python3 - "$@" <<'PY'
import re, sys
x = open('ui.xml', encoding='utf-8', errors='replace').read()
want = sys.argv[1] if len(sys.argv) > 1 else None
best = None
for n in re.findall(r'<node [^>]*>', x):
    t = re.search(r' text="([^"]*)"', n); d = re.search(r'content-desc="([^"]*)"', n)
    b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
    label = (t.group(1) if t else '') or (d.group(1) if d else '')
    if not label or not b: continue
    x1, y1, x2, y2 = map(int, b.groups())
    if want is None: print('  UI:', label[:100], f'[{x1},{y1},{x2},{y2}]')
    elif want in label and x2 > x1 and y2 > y1:
        area = (x2 - x1) * (y2 - y1)
        if best is None or area < best[0]: best = (area, (x1 + x2) // 2, (y1 + y2) // 2)
if want is not None and best: print(best[1], best[2])
PY
}
tap() {
  local xy=""
  for i in 1 2 3 4 5 6 7 8; do
    xy=$(ui "$1")
    [ -n "$xy" ] && break
    adb shell input swipe 500 1500 500 700 300; sleep 1
  done
  [ -n "$xy" ] || { ui; fail "Knopf „$1“ nicht gefunden"; }
  adb shell input tap $xy; echo "getippt: $1 ($xy)"
}
alive() { adb shell pidof $PKG >/dev/null || fail "App läuft nicht mehr ($1)"; }
wait_for() { for i in $(seq 1 "$2"); do ui | grep -q "$1" && return 0; adb shell input swipe 500 1500 500 900 200; sleep 3; done; return 1; }

adb install -r KI-Autopilot.apk || fail "Installation"
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS || true
adb logcat -c
adb shell am start -W -n $PKG/.MainActivity
wait_for "Ein Knopf" 15 || { ui; fail "Startseite nicht sichtbar"; }
echo "== Startseite"; ui
alive "Start"

echo "== Marktanalyse antippen"
tap "Neu analysieren"
wait_for "Daraus ein Video machen" 40 || { ui; fail "Keine Themen nach Marktanalyse"; }
echo "== Themen da"; ui | head -40
alive "Marktanalyse"

echo "== Anmelde-Rücksprung (ungültig, muss sauber abgefangen werden)"
adb shell am start -a android.intent.action.VIEW -d "'kiautopilot://oauth?state=falsch&code=x'" $PKG
sleep 4
alive "OAuth"

echo "== Einstellungen"
tap "Mehr"
wait_for "Schlüssel" 10 || { ui; fail "Einstellungen nicht sichtbar"; }
ui | head -30
alive "Mehr"

adb exec-out screencap -p > smoke.png
echo "== Protokoll"
adb logcat -d | grep -E "AndroidRuntime|FATAL" && fail "Absturz im Protokoll"
echo "SMOKE OK"
