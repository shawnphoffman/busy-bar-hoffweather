#!/usr/bin/env python3
"""Synthesizes HoffWeather's alert sounds as BUSY Bar .snd files.

A .snd file is headerless signed 16-bit little-endian mono PCM at 44.1 kHz (the firmware's AUDIO_SAMPLE_RATE).
The sounds are simple bell tones made here, so the app ships no third-party audio. Run from the repo root:

    python3 tools/gensounds.py

and it rewrites src/sounds/*.snd. Pass --wav <dir> to also write .wav copies there for listening.
"""

import math
import struct
import sys
import wave
from pathlib import Path

RATE = 44100
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "sounds"


def bell(freq: float, dur: float, decay: float, amp: float) -> list[float]:
    """A soft bell: the fundamental plus a quiet inharmonic partial, with a 4 ms attack and exponential decay."""
    n = int(RATE * dur)
    out = []
    for i in range(n):
        t = i / RATE
        env = min(1.0, t / 0.004) * math.exp(-t / decay)
        s = math.sin(2 * math.pi * freq * t) + 0.25 * math.sin(2 * math.pi * freq * 2.76 * t) * math.exp(-t / (decay / 3))
        out.append(amp * env * s / 1.25)
    return out


def mix(parts: list[tuple[float, list[float]]]) -> list[float]:
    """Lays each (start seconds, samples) part onto one track."""
    length = max(int(start * RATE) + len(p) for start, p in parts)
    track = [0.0] * length
    for start, p in parts:
        o = int(start * RATE)
        for i, v in enumerate(p):
            track[o + i] += v
    return track


def finish(track: list[float]) -> list[float]:
    """Trims to the audible part and adds a 10 ms fade-out so the end never clicks."""
    end = len(track)
    while end > 0 and abs(track[end - 1]) < 0.002:
        end -= 1
    track = track[:end]
    fade = int(RATE * 0.01)
    for i in range(min(fade, len(track))):
        track[-1 - i] *= i / fade
    return track


SOUNDS = {
    # Rain starting or the AQI rising: two rising notes, a gentle "heads up".
    "chime": finish(mix([(0.0, bell(880.0, 0.5, 0.12, 0.45)), (0.14, bell(1318.5, 0.6, 0.16, 0.45))])),
    # Lightning nearby: three quick falling notes, more urgent but still soft.
    "lightning": finish(
        mix([(0.0, bell(1568.0, 0.3, 0.06, 0.4)), (0.09, bell(1174.7, 0.3, 0.06, 0.4)), (0.18, bell(880.0, 0.6, 0.14, 0.45))])
    ),
}


def to_pcm(track: list[float]) -> bytes:
    return b"".join(struct.pack("<h", max(-32767, min(32767, round(v * 32767)))) for v in track)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    wav_dir = Path(sys.argv[sys.argv.index("--wav") + 1]) if "--wav" in sys.argv else None
    for name, track in SOUNDS.items():
        pcm = to_pcm(track)
        (OUT / f"{name}.snd").write_bytes(pcm)
        print(f"{name}.snd  {len(track) / RATE:.2f}s  {len(pcm)} bytes")
        if wav_dir:
            with wave.open(str(wav_dir / f"{name}.wav"), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(RATE)
                w.writeframes(pcm)


if __name__ == "__main__":
    main()
