/** Sarvam speech priced as in the Python library 1.46.0: speech-to-text by the seconds of audio sent. */
import { describe, expect, it } from 'vitest';
import { getDefaultCostCalculator } from '../../src/cost';
import { wavSeconds } from '../../src/instrumentors/sarvam';

/** A PCM WAV of `seconds` at 16 kHz mono 16-bit. */
function wav(seconds: number): Uint8Array {
  const byteRate = 16000 * 2;
  const dataSize = Math.round(seconds * byteRate);
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => [...text].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  tag(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, dataSize, true);
  return bytes;
}

describe('Sarvam speech-to-text pricing', () => {
  it('reads the duration from the WAV header: bytes, an upload pair, an ArrayBuffer', () => {
    expect(wavSeconds(wav(2.5))).toBeCloseTo(2.5, 3);
    expect(wavSeconds(['clip.wav', wav(1)])).toBeCloseTo(1, 3);
    expect(wavSeconds(wav(0.5).buffer)).toBeCloseTo(0.5, 3);
  });

  it('anything that is not a readable WAV has no duration (so no cost, never a guess)', () => {
    expect(wavSeconds(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(wavSeconds(Uint8Array.from(Buffer.from('ID3 not a wav'.padEnd(64, ' '))))).toBeUndefined();
    expect(wavSeconds(new Blob([wav(1)]))).toBeUndefined();
    expect(wavSeconds(undefined)).toBeUndefined();
  });

  it('the audio is priced per second under sarvam/<model>, the name as requested', () => {
    const cost = getDefaultCostCalculator().calculateCost('sarvam/saarika:v2.5', { seconds: 60 } as never, 'audio');
    expect(cost).toBeCloseTo(60 * 8.77193e-5, 9);
    const tts = getDefaultCostCalculator().calculateCost('sarvam/bulbul:v2', { characters: 1000 } as never, 'audio');
    expect(tts).toBeCloseTo(0.031579, 6);
  });
});
