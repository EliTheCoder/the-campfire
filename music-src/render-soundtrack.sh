#!/usr/bin/env bash
# Render soundtrack.py into one finished track to publish:
#   ./render-soundtrack.sh   -> soundtrack/the-campfire.{wav,flac,mp3}
# Same piano, tone and room as the game stems (render.sh), but played straight through with a
# real ending instead of cut into loops.
set -euo pipefail
cd "$(dirname "$0")"
SF=soundfonts/UprightPianoKW-SF2-20220221/UprightPianoKW-20220221.sf2
OUT=soundtrack
mkdir -p build "$OUT"

python3 soundtrack.py
STEMS="bed flow melody lonely arp"

for s in $STEMS; do
  fluidsynth -ni -q -o synth.reverb.active=0 -o synth.chorus.active=0 -g 0.6 -r 48000 \
    -F "build/ost-$s-raw.wav" "$SF" "build/ost-$s.mid" >/dev/null
  case $s in   # keep in step with render.sh
    bed) TONE="lowpass 1250 bass +2 120" ;;
    flow) TONE="lowpass 1900 treble -6 3000" ;;
    melody) TONE="lowpass 5000 treble +1 3000" ;;
    arp) TONE="lowpass 7500 treble -2 6000 gain -3" ;;
    *) TONE="lowpass 2800 treble -3 3500" ;;
  esac
  sox "build/ost-$s-raw.wav" "build/ost-$s-wet.wav" $TONE pad 0 8 reverb 78 55 100 100 30 -1
done

# Mix at the game's levels (the lonely voice plays at 1.6 there), trim the silence after the
# final chord has rung out, ease the very end, and bring it up to -1 dB.
sox -m -v 1 build/ost-bed-wet.wav -v 1 build/ost-flow-wet.wav -v 1 build/ost-melody-wet.wav \
  -v 1.6 build/ost-lonely-wet.wav -v 1 build/ost-arp-wet.wav build/ost-mix.wav
sox build/ost-mix.wav build/ost-trim.wav reverse silence 1 0.05 -60d reverse
sox build/ost-trim.wav build/ost-master.wav fade t 0 -0 3 gain -n -1

sox build/ost-master.wav "$OUT/the-campfire.wav"
sox build/ost-master.wav -C 8 "$OUT/the-campfire.flac"
sox build/ost-master.wav -C 320 "$OUT/the-campfire.mp3"
soxi -d "$OUT/the-campfire.wav"
ls -la "$OUT"
