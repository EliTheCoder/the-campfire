#!/usr/bin/env python3
"""The Campfire - soundtrack cut: the game's stems sequenced into one through-composed track.

In the game the stems loop and fade with the fire. Here each 8-bar section of the score is
played with a chosen set of stems, so the track tells a night at the fire: a lonely start, the
tune arriving, the first blaze, a dip into the dark, the epic climb, and a short closing tag
(C - D - G) that lets the last chord ring out.

Writes build/ost-<stem>.mid; render-soundtrack.sh turns them into soundtrack.wav/.flac/.mp3.
"""
import os
import compose as c

SECTION = 8 * c.BAR    # beats per section; one game loop = 4 sections: A, A+8va, bridge, A+8va
A, A8, B, A8b = range(4)

# (which section of the score, which stems play it)
ARRANGEMENT = [
    (A,   {'bed', 'lonely'}),                       # dusk: just the chords and a far-off voice
    (A,   {'bed', 'flow', 'lonely'}),               # the fire catches
    (A,   {'bed', 'flow', 'melody'}),               # Eli's tune
    (A8,  {'bed', 'flow', 'melody'}),               #   ...with its octave double
    (B,   {'bed', 'flow', 'melody'}),               # bridge
    (A8b, {'bed', 'flow', 'melody', 'arp'}),        # first blaze
    (A8,  {'bed', 'lonely'}),                       # the dark comes in
    (A,   {'bed', 'flow', 'lonely'}),               # finding the way back
    (B,   {'bed', 'flow', 'melody', 'arp'}),        # violet fire
    (A8,  {'bed', 'flow', 'melody', 'arp'}),        # the whole band
    (A8b, {'bed', 'flow', 'melody', 'arp'}),
    (A,   {'bed', 'melody'}),                       # embers
]
FNS = {'bed': c.bed, 'flow': c.flow, 'melody': c.melody, 'lonely': c.lonely, 'arp': c.arp}

def tag(stem, t0):
    """Closing tag after the last section: Eli's C and D bars, then G held to the end."""
    (mel_c, _, ch_c, bass_c, _), (mel_d, _, ch_d, bass_d, _), (mel_g, _, ch_g, bass_g, _) = c.BARS_DATA[:3]
    out = []
    if stem == 'bed':
        for b, (chord, bass, length) in enumerate([(ch_c, bass_c, 4), (ch_d, bass_d, 4), (ch_g, bass_g, 12)]):
            for p in chord:
                out.append((t0 + b * 4, p, length, c.vel(30 if p > 40 else 38, 2)))
            out.append((t0 + b * 4, bass + 12 if bass < 33 else bass, length, c.vel(36, 2)))
    elif stem == 'melody':
        for b, mel in enumerate([mel_c, mel_d]):
            for t, p, d in mel:
                out.append((c.human(t0 + b * 4 + t, 0.008), p, d * 0.95, c.vel(46 - b * 4)))
        out.append((t0 + 8.05, 67, 12, c.vel(40)))   # land on G and let it ring
        out.append((t0 + 8.05, 79, 12, c.vel(28)))
    elif stem == 'lonely':
        out.append((t0 + 10, 91, 10, c.vel(24, 2)))  # one last high G, far away
    return out

TAG_BEATS = 20         # 3 bars + room for the ring-out
TOTAL_BEATS = len(ARRANGEMENT) * SECTION + TAG_BEATS

def stem_notes(stem):
    notes = []
    for k, (src, stems) in enumerate(ARRANGEMENT):
        perf = FNS[stem]()                 # a fresh performance each time (new human wobble)
        if stem not in stems:
            continue
        lo, hi = src * SECTION, (src + 1) * SECTION
        notes += [(t - lo + k * SECTION, p, d, v) for t, p, d, v in perf if lo <= t < hi]
    return notes + tag(stem, len(ARRANGEMENT) * SECTION)

def write_midi(path, notes, pedal=True):
    ev = []
    for start, pitch, length, v in notes:
        ev.append((int(start * c.TPB), 0x90, pitch, v))
        ev.append((int((start + length) * c.TPB), 0x80, pitch, 0))
    if pedal:  # same pedalling as the game stems: lift just before each bar
        for b in range(int(TOTAL_BEATS // c.BAR)):
            t = b * c.BAR * c.TPB
            if t >= (len(ARRANGEMENT) * SECTION + 8) * c.TPB:
                break                              # hold the pedal through the final G
            ev.append((max(0, t - 20), 0xB0, 64, 0))
            ev.append((t + 30, 0xB0, 64, 100))
    ev.append((int(TOTAL_BEATS * c.TPB), 0xB0, 64, 0))
    ev.sort(key=lambda e: (e[0], 0 if e[1] in (0x80, 0xB0) else 1))
    track = bytearray(b'\x00\xFF\x51\x03' + int(60_000_000 / c.BPM).to_bytes(3, 'big') + b'\x00\xC0\x00')
    last = 0
    for t, status, a, b in ev:
        track += c.vlq(t - last) + bytes([status, a, b])
        last = t
    track += b'\x00\xFF\x2F\x00'
    with open(path, 'wb') as f:
        f.write(b'MThd' + c.struct.pack('>IHHH', 6, 0, 1, c.TPB))
        f.write(b'MTrk' + c.struct.pack('>I', len(track)) + track)

if __name__ == '__main__':
    out = os.path.join(c.HERE, 'build')
    os.makedirs(out, exist_ok=True)
    for stem in FNS:
        write_midi(os.path.join(out, f'ost-{stem}.mid'), stem_notes(stem), pedal=stem not in ('flow', 'arp'))
    secs = TOTAL_BEATS * 60 / c.BPM
    print(f'{len(ARRANGEMENT)} sections + tag = {int(secs // 60)}:{secs % 60:04.1f} (plus reverb tail)')
