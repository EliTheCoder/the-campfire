#!/usr/bin/env python3
"""The Campfire - adaptive piano score.

Writes one MIDI file per stem. render.sh turns them into seamlessly looping OGGs with a
sampled piano (FluidSynth + the CC0 Upright Piano KW soundfont) and reverb (SoX).

Stems (all the same length, played in sync by the game):
  bed     low left-hand chords             - always
  flow    rolling broken chords            - when the fire is doing okay
  melody  the tune                         - when the fire is strong
  lonely  sparse, distant high notes       - out in the dark / when the fire is low
"""
import random, struct, os

BPM = 64
TPB = 480                      # ticks per beat
BAR = 4                        # beats per bar
rng = random.Random(7)         # fixed seed: the same "performance" every render

# MIDI note numbers
N = {}
for octave in range(0, 9):
    for i, name in enumerate(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']):
        N[f'{name}{octave}'] = 12 * (octave + 1) + i
def n(*names): return [N[x] for x in names]

# ---------------------------------------------------------------- harmony
# Each bar: (bass voicing for the left hand, upper voicing for the right hand)
A = [
    (n('D2', 'A2'),  n('F#4', 'A4', 'C#5', 'E5')),   # Dmaj9
    (n('B1', 'F#2'), n('D4', 'F#4', 'A4', 'E5')),    # Bm7(add11)
    (n('G1', 'D2'),  n('B3', 'D4', 'F#4', 'C#5')),   # Gmaj7(#11)
    (n('C#2', 'A2'), n('E4', 'A4', 'B4', 'E5')),     # A(add9)/C#
    (n('F#2', 'D3'), n('A4', 'C#5', 'E5', 'F#5')),   # Dmaj9/F#
    (n('G2', 'D3'),  n('B4', 'D5', 'F#5', 'A5')),    # Gmaj9
    (n('E2', 'B2'),  n('G4', 'B4', 'D5', 'F#5')),    # Em9
    (n('A1', 'E2'),  n('E4', 'A4', 'D5', 'E5')),     # Asus4 (resolves in the melody)
]
B = [
    (n('B1', 'F#2'), n('D4', 'F#4', 'A4', 'C#5')),   # Bm9
    (n('G1', 'D2'),  n('B3', 'D4', 'F#4', 'B4')),    # Gmaj7
    (n('F#2', 'A2'), n('A3', 'D4', 'F#4', 'C#5')),   # Dmaj7/F#
    (n('E2', 'B2'),  n('G4', 'B4', 'D5', 'E5')),     # Em7
    (n('B1', 'F#2'), n('F#4', 'A4', 'C#5', 'D5')),   # Bm9
    (n('G1', 'D2'),  n('B3', 'D4', 'F#4', 'C#5')),   # Gmaj7(#11)
    (n('A1', 'E2'),  n('E4', 'A4', 'B4', 'E5')),     # Asus2
    (n('A1', 'E2'),  n('E4', 'A4', 'C#5', 'E5')),    # A
]
SECTIONS = [('A', A), ("A'", A), ('B', B), ("A''", A)]
CHORDS = [bar for _, sec in SECTIONS for bar in sec]
BARS = len(CHORDS)

# ---------------------------------------------------------------- melody
# Simple and on the beat: only quarter, half and whole notes, built from sequences - one small
# idea repeated a step lower (or higher) each bar, so the tune walks through the scale.
# (beat within bar, note, length in beats) per bar
def up(a, b, c):     # three notes stepping up: quarter, quarter, half
    return [(0, a, 1), (1, b, 1), (2, c, 2)]
def down(a, b, c):   # the same shape upside down
    return [(0, a, 1), (1, b, 1), (2, c, 2)]
def pair(a, b):      # two half notes
    return [(0, a, 2), (2, b, 2)]
def whole(a):
    return [(0, a, 4)]

MEL = {
    'A': [
        up('D5', 'E5', 'F#5'),       # Dmaj9      rising idea...
        up('C#5', 'D5', 'E5'),       # Bm7        ...a step lower
        up('B4', 'C#5', 'D5'),       # Gmaj7#11   ...lower
        up('A4', 'B4', 'C#5'),       # A/C#       ...lower
        down('F#5', 'E5', 'D5'),     # D/F#       answer: falling idea...
        down('E5', 'D5', 'C#5'),     # Gmaj9      ...a step lower
        down('D5', 'C#5', 'B4'),     # Em9        ...lower
        down('C#5', 'B4', 'A4'),     # Asus4->A   ...lower, leading home to D
    ],
    "A'": [
        up('D5', 'E5', 'F#5'),
        up('C#5', 'D5', 'E5'),
        up('B4', 'C#5', 'D5'),
        up('A4', 'B4', 'C#5'),
        down('A5', 'G5', 'F#5'),     # the answer starts higher: the peak
        down('G5', 'F#5', 'E5'),
        down('F#5', 'E5', 'D5'),
        whole('E5'),
    ],
    'B': [                           # slower: falling pairs over a stepping line
        pair('F#5', 'D5'),           # Bm9
        whole('B4'),                 # Gmaj7
        pair('E5', 'C#5'),           # D/F#       pairs fall a step each time...
        whole('A4'),                 # Em7        ...and so do the long notes
        pair('D5', 'B4'),            # Bm9
        whole('G4'),                 # Gmaj7#11
        pair('B4', 'A4'),            # Asus2
        whole('C#5'),                # A
    ],
}
MEL["A''"] = MEL['A']
MELODY = [bar for name, _ in SECTIONS for bar in MEL[name]]

# ---------------------------------------------------------------- performance
def human(t, spread=0.02):           # timing wobble in beats
    return max(0.0, t + rng.uniform(-spread, spread))
def vel(v, spread=5):
    return max(1, min(127, int(v + rng.uniform(-spread, spread))))

def bed():
    notes = []
    for b, (low, _) in enumerate(CHORDS):
        t0 = b * BAR
        notes.append((human(t0, 0.01), low[0], BAR, vel(42)))
        notes.append((human(t0 + 0.12, 0.02), low[1], BAR - 0.12, vel(33)))
        if b % 2 == 1:   # a soft re-strike on the off bars keeps it breathing
            notes.append((human(t0 + 2.5), low[1] + 12, 1.5, vel(26)))
    return notes

FLOW_PATTERNS = [
    [(0, 0), (0.5, 1), (1.5, 2), (2, 3), (3, 1), (3.5, 2)],
    [(0, 0), (1, 2), (1.5, 3), (2.5, 1), (3, 2)],
    [(0, 1), (0.5, 2), (1, 3), (2, 0), (2.5, 2), (3.5, 3)],
    [(0, 0), (0.75, 1), (1.5, 2), (2.25, 3)],
]
def flow():
    notes = []
    for b, (_, up) in enumerate(CHORDS):
        pat = FLOW_PATTERNS[(b * 3 + b // 8) % len(FLOW_PATTERNS)]
        for beat, idx in pat:
            v = 30 + (6 if beat == 0 else 0) + rng.uniform(-4, 4)
            notes.append((human(b * BAR + beat), up[idx], 1.0, vel(v, 2)))
    return notes

def melody():
    notes = []
    for b, bar in enumerate(MELODY):
        for beat, name, length in bar:
            accent = 6 if beat == 0 else 0
            notes.append((human(b * BAR + beat, 0.03), N[name], length * 0.95, vel(48 + accent)))
    return notes

def lonely():
    # a high, distant note every couple of bars, taken from the tune an octave up
    notes = []
    for b in range(0, BARS, 2):
        bar = MELODY[b] or MELODY[b + 1]
        if not bar:
            continue
        beat, name, _ = bar[0]
        if b % 8 == 6:
            continue  # leave holes; loneliness needs silence
        notes.append((human(b * BAR + beat + 0.5, 0.05), N[name] + 12, 6, vel(30, 3)))
    return notes

# ---------------------------------------------------------------- MIDI writing
def vlq(x):
    out = [x & 0x7F]
    x >>= 7
    while x:
        out.insert(0, (x & 0x7F) | 0x80)
        x >>= 7
    return bytes(out)

def write_midi(path, notes, loops=2, pedal=True):
    """notes: (start_beat, pitch, length_beats, velocity). Written `loops` times back to back
    so render.sh can cut out a pass that already contains the previous pass's reverb tail."""
    ev = []
    span = BARS * BAR
    for k in range(loops):
        off = k * span
        for start, pitch, length, v in notes:
            ev.append((int((start + off) * TPB), 0x90, pitch, v))
            ev.append((int((start + off + length) * TPB), 0x80, pitch, 0))
        if pedal:  # sustain pedal: lift just before each bar, press just after it starts
            for b in range(BARS):
                t = (b * BAR + off) * TPB
                ev.append((max(0, t - 20), 0xB0, 64, 0))
                ev.append((t + 30, 0xB0, 64, 100))
    ev.append((loops * span * TPB + TPB * 8, 0xB0, 64, 0))
    ev.sort(key=lambda e: (e[0], 0 if e[1] in (0x80, 0xB0) else 1))
    track = bytearray()
    tempo = int(60_000_000 / BPM)
    track += b'\x00\xFF\x51\x03' + tempo.to_bytes(3, 'big')
    track += b'\x00\xC0\x00'  # program 0: acoustic piano
    last = 0
    for t, status, a, b in ev:
        track += vlq(t - last) + bytes([status, a, b])
        last = t
    track += b'\x00\xFF\x2F\x00'
    with open(path, 'wb') as f:
        f.write(b'MThd' + struct.pack('>IHHH', 6, 0, 1, TPB))
        f.write(b'MTrk' + struct.pack('>I', len(track)) + track)

if __name__ == '__main__':
    out = os.path.join(os.path.dirname(__file__), 'build')
    os.makedirs(out, exist_ok=True)
    for name, fn in [('bed', bed), ('flow', flow), ('melody', melody), ('lonely', lonely)]:
        write_midi(os.path.join(out, f'{name}.mid'), fn())
    print(f'{BARS} bars at {BPM} bpm = {BARS * BAR * 60 / BPM:.2f}s per loop')
