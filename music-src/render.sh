#!/usr/bin/env bash
# Render the stems from compose.py into seamlessly looping OGGs for the game.
#   ./render.sh            -> public/music/*.ogg (+ preview-full.ogg, a full mix to listen to)
set -euo pipefail
cd "$(dirname "$0")"
SF=soundfonts/UprightPianoKW-SF2-20220221/UprightPianoKW-20220221.sf2
OUT=../public/music
mkdir -p build "$OUT"

python3 compose.py
LOOP=$(python3 -c "import compose as c; print(c.BARS * c.BAR * 60 / c.BPM)")
STEMS="bed flow melody lonely arp"

for s in $STEMS; do
  # dry piano, no built-in reverb/chorus: we add our own
  fluidsynth -ni -q -o synth.reverb.active=0 -o synth.chorus.active=0 -g 0.6 -r 48000 \
    -F "build/$s-raw.wav" "$SF" "build/$s.mid" >/dev/null
  # felt-piano softness (roll off the top), a big warm room, then cut the second pass:
  # it begins with the first pass's reverb tail, so the loop point is seamless
  # each stem gets its own colour so they stay distinct: the rolling chords are dark and soft,
  # the melody clear on top
  case $s in
    bed) TONE="lowpass 1250 bass +2 120" ;;       # Eli's chords were a lowpassed (~1.15k) piano
    flow) TONE="lowpass 1900 treble -6 3000" ;;
    melody) TONE="lowpass 5000 treble +1 3000" ;;
    arp) TONE="lowpass 7500 treble -2 6000 gain -6" ;;  # high sparkle above the melody: keep the shine, tame the ping
    *) TONE="lowpass 2800 treble -3 3500" ;;
  esac
  sox "build/$s-raw.wav" "build/$s-wet.wav" \
    $TONE \
    reverb 78 55 100 100 30 -1 \
    trim "$LOOP" "$LOOP"
done

# One gain for every stem, set from the everyday mix (everything but the epic arp) so it peaks
# at -1.5 dB and their balance is kept. The epic moment plays bed+flow+melody+arp together, so if
# that would clip, the gain comes down just enough for it too.
peak() { sox "$@" -n stat 2>&1 | awk '/Maximum amplitude/{a=$3} /Minimum amplitude/{b=-$3} END{print (a>b?a:b)}'; }
sox -m $(for s in bed flow melody lonely; do echo "-v 1 build/$s-wet.wav"; done) build/mix.wav  # -v 1: true sum, like the game playing them at once
sox -m $(for s in bed flow melody arp; do echo "-v 1 build/$s-wet.wav"; done) build/epic.wav
PEAK=$(python3 -c "print(max($(peak build/mix.wav), $(peak build/epic.wav) * 0.84 / 0.95))")
GAIN=$(python3 -c "import math; print(round(20*math.log10(0.84/$PEAK), 2))")
echo "mix peak $(peak build/mix.wav), epic peak $(peak build/epic.wav) -> gain ${GAIN} dB"

for s in $STEMS; do
  sox "build/$s-wet.wav" -C 6 "$OUT/$s.ogg" gain "$GAIN"
done
sox build/mix.wav -C 6 "$OUT/preview-full.ogg" gain "$GAIN"
sox build/epic.wav -C 6 "$OUT/preview-epic.ogg" gain "$GAIN"   # what an epic moment sounds like
ls -la "$OUT"
