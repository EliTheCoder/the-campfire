#!/usr/bin/env python3
"""The Campfire - adaptive piano score, built on Eli's song.

Eli wrote the tune in Corgi Echo (source/2026-10-25-belligerent-grison.json): a 4-bar loop in
G major at 90 bpm over C - D - G - Em, with a piano melody, the same melody an octave up, soft
low piano chords and a synth bass. The notes below are read straight from that file; the synth
bass moves to piano (the score is piano only) and the file's drum track, which its arrangement
never switches on, is left out.

Writes one MIDI file per stem. render.sh turns them into seamlessly looping OGGs with a
sampled piano (FluidSynth + the CC0 Upright Piano KW soundfont) and reverb (SoX).

Stems (all the same length, played in sync by the game):
  bed     Eli's chords + bass               - always
  flow    rolling broken chords (new)       - when the fire is doing okay
  melody  Eli's melody (+ his octave double) - when the fire is strong
  lonely  sparse, distant high notes (new)  - out in the dark / when the fire is low
  arp     16th-note arpeggios (new)         - epic moments: violet fire or hotter, and for a
                                              while after the campfire grows a stage

Form (8-bar sections): A = Eli's phrase twice, then again with the octave doubling, a new
bridge B in the same rhythms (Am - Em - C - D), and A to close.
"""
import json, random, struct, os

HERE = os.path.dirname(os.path.abspath(__file__))
SONG = json.load(open(os.path.join(HERE, 'source', '2026-10-25-belligerent-grison.json')))

BPM = SONG['globalClock']['bpm']   # 90
TPB = 480                          # ticks per beat
BAR = 4                            # beats per bar
rng = random.Random(7)             # fixed seed: the same "performance" every render

# ---------------------------------------------------------------- reading Eli's song
# Echo sequencers count in steps; at rate 0.5 a step is an eighth note (a 32-step clip = 4 bars,
# matching the group sequencer's 16-beat blocks). Events past the clip's length are leftovers
# the clip never plays.
SEQS = SONG['shamuGraph']['nodes']['betterSequencers']['things']
def clip(seq_id):
    s = next(v for k, v in SEQS.items() if k.startswith(seq_id))
    c, step = s['midiClip'], s['rate']
    return sorted(((e['startBeat'] * step, e['note'] + s['pitch'], e['durationBeats'] * step)
                   for e in c['events'].values() if e['startBeat'] < c['length']))

ECHO_MELODY = clip('68e1fde0')     # piano lead
ECHO_OCTAVE = clip('561b6fee')     # the same line, pitch +12
ECHO_CHORDS = clip('9899c073')     # muffled, reverbed piano chords (lowpass ~1.2k in Echo)
ECHO_BASS = clip('4b4b83d0')       # sawtooth synth in Echo -> piano here
PHRASE = 4                         # bars in Eli's loop

def by_bar(notes):
    bars = [[] for _ in range(PHRASE)]
    for t, p, d in notes:
        bars[int(t // BAR)].append((t % BAR, p, d))
    return bars

# MIDI note numbers for the new parts
N = {}
for octave in range(0, 9):
    for i, name in enumerate(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']):
        N[f'{name}{octave}'] = 12 * (octave + 1) + i

# ---------------------------------------------------------------- the bridge (new)
# Same two rhythm figures as Eli's phrase: four eighths then two quarters, and a half note then
# four eighths. Chords ii - vi - IV - V voiced like his (low root, root, fifth, root, third).
def bars_of(*bars):
    return [[(t, N[n], d) for t, n, d in b] for b in bars]
FIG_A = lambda a, b, c, d, e, f: [(0, a, .5), (.5, b, .5), (1, c, .5), (1.5, d, .5), (2, e, 1), (3, f, 1)]
FIG_B = lambda a, b, c, d, e: [(0, a, 2), (2, b, .5), (2.5, c, .5), (3, d, .5), (3.5, e, .5)]
BRIDGE_MEL = bars_of(
    FIG_A('C5', 'A4', 'C5', 'E5', 'D5', 'E5'),     # Am
    FIG_B('B4', 'B4', 'C5', 'D5', 'C5'),           # Em
    FIG_A('E5', 'G4', 'C5', 'E5', 'D5', 'E5'),     # C
    FIG_B('D5', 'D5', 'E5', 'F#5', 'A5'),          # D   climbs...
    FIG_A('C6', 'A5', 'E5', 'C5', 'B4', 'C5'),     # Am  ...falls from the top
    FIG_B('B4', 'G4', 'A4', 'B4', 'G4'),           # Em
    FIG_A('E5', 'C5', 'G4', 'C5', 'B4', 'A4'),     # C
    FIG_B('A4', 'F#4', 'G4', 'A4', 'B4'),          # D   steps up into Eli's C5
)
BRIDGE_CHORDS = [
    ['A1', 'A2', 'E3', 'A3', 'C4'], ['E1', 'E2', 'B2', 'E3', 'G3'],
    ['C1', 'C2', 'G2', 'C3', 'E3'], ['D1', 'D2', 'A2', 'D3', 'F#3'],
] * 2
BRIDGE_BASS = ['A1', 'E2', 'C2', 'D2'] * 2

# ---------------------------------------------------------------- form
MEL, OCT, CH, BASS = by_bar(ECHO_MELODY), by_bar(ECHO_OCTAVE), by_bar(ECHO_CHORDS), by_bar(ECHO_BASS)
# each bar: (melody notes, octave-double notes, chord pitches, bass pitch, chord tones for flow)
BARS_DATA = []
def add_eli(times, octave):
    for _ in range(times):
        for b in range(PHRASE):
            chord = sorted(p for _, p, _ in CH[b])
            BARS_DATA.append((MEL[b], OCT[b] if octave else [], chord, BASS[b][0][1], chord))
def add_bridge():
    for b in range(8):
        chord = [N[x] for x in BRIDGE_CHORDS[b]]
        BARS_DATA.append((BRIDGE_MEL[b], [(t, p + 12, d) for t, p, d in BRIDGE_MEL[b]] if b >= 4 else [],
                          chord, N[BRIDGE_BASS[b]], chord))
add_eli(2, octave=False)   # A   bars 1-8   (Eli's opening: the tune on its own)
add_eli(2, octave=True)    # A   bars 9-16  (his octave doubling joins)
add_bridge()               # B   bars 17-24 (new)
add_eli(2, octave=True)    # A   bars 25-32
BARS = len(BARS_DATA)

# ---------------------------------------------------------------- performance
def human(t, spread=0.02):           # timing wobble in beats
    return max(0.0, t + rng.uniform(-spread, spread))
def vel(v, spread=5):
    return max(1, min(127, int(v + rng.uniform(-spread, spread))))

def bed():
    # Eli's chords and his bass line (synth in Echo, piano here), struck together on the
    # downbeat and held for the bar, exactly on the grid like his - no roll, no off-beat
    # re-strikes, so they sit with the melody instead of pushing ahead of it.
    notes = []
    for b, (_, _, chord, bass, _) in enumerate(BARS_DATA):
        t0 = b * BAR
        for p in chord:
            notes.append((t0, p, BAR, vel(32 if p > 40 else 40, 2)))
        notes.append((t0, bass + 12 if bass < 33 else bass, BAR, vel(38, 2)))
    return notes

def flow():
    # new: eighth-note broken chords in the middle, under the tune (never below E3 so the bass
    # stays clear); the pattern turns over every bar so it rolls instead of ticking
    PAT = [0, 1, 2, 1, 3, 1, 2, 1]
    notes = []
    for b, (*_, chord) in enumerate(BARS_DATA):
        tones = sorted({(p - 48) % 12 + 48 + (12 if (p - 48) % 12 + 48 < N['E3'] else 0) for p in chord})
        root = min(chord, key=lambda p: (p % 12 != chord[0] % 12, p))
        tones = sorted({root % 12 + 48 + (12 if root % 12 + 48 < N['E3'] else 0)} | set(tones))[:3]
        tones.append(tones[0] + 12)
        for i, idx in enumerate(PAT):
            v = 26 + (6 if i == 0 else 3 if i == 4 else 0)
            notes.append((human(b * BAR + i * 0.5, 0.008), tones[idx], 0.9, vel(v, 2)))
    return notes

def arp():
    # new: bright 16th notes up and down the chord across two octaves above middle C, so it
    # sparkles over the tune rather than crowding it; a little louder on each beat
    notes = []
    for b, (*_, chord) in enumerate(BARS_DATA):
        pcs = sorted({p % 12 for p in chord}, key=lambda pc: (pc - chord[0]) % 12)  # root first
        tones = sorted(60 + (pc - 60) % 12 for pc in pcs)                          # C4..B4
        run = [t for o in (0, 12) for t in tones] + [tones[0] + 24]
        seq = run + run[-2:0:-1]                                                   # up, then down
        for i in range(16):
            v = 30 + (8 if i % 4 == 0 else 0) + (4 if i == 0 else 0)
            notes.append((human(b * BAR + i * 0.25, 0.004), seq[(i + b * 3) % len(seq)], 0.3, vel(v, 2)))
    return notes

def melody():
    notes = []
    for b, (mel, octv, *_) in enumerate(BARS_DATA):
        for line, base in ((mel, 50), (octv, 36)):
            for t, p, d in line:
                accent = 6 if t == 0 else 3 if t == 2 else 0
                notes.append((human(b * BAR + t, 0.008), p, d * 0.95, vel(base + accent)))
    return notes

def lonely():
    # new: a high, distant note every couple of bars, taken from the tune's downbeats an octave
    # up, with holes left in; loneliness needs silence
    notes = []
    for b in range(0, BARS, 2):
        if b % 8 == 6:
            continue
        t, p, _ = BARS_DATA[b][0][0]
        notes.append((human(b * BAR + t + 0.5, 0.05), p + 12, 6, vel(30, 3)))
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
    out = os.path.join(HERE, 'build')
    os.makedirs(out, exist_ok=True)
    for name, fn in [('bed', bed), ('flow', flow), ('melody', melody), ('lonely', lonely), ('arp', arp)]:
        write_midi(os.path.join(out, f'{name}.mid'), fn(), pedal=name not in ('flow', 'arp'))
    print(f'{BARS} bars at {BPM} bpm = {BARS * BAR * 60 / BPM:.2f}s per loop')
