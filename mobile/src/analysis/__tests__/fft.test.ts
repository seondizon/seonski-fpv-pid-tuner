import {
  fftFreq,
  gaussianFilter1dWrap,
  hannWindow,
  ifftFull,
  magnitude,
  nextPow2,
  realFftFull,
  realFftHalf,
  rfftFreq,
} from '../fft';

test('nextPow2', () => {
  expect(nextPow2(1)).toBe(1);
  expect(nextPow2(2)).toBe(2);
  expect(nextPow2(3)).toBe(4);
  expect(nextPow2(1000)).toBe(1024);
  expect(nextPow2(1024)).toBe(1024);
});

test('fftFreq matches numpy.fft.fftfreq for even n', () => {
  // numpy.fft.fftfreq(8, d=1/8) == [0,1,2,3,-4,-3,-2,-1]
  const freqs = Array.from(fftFreq(8, 1 / 8));
  expect(freqs).toEqual([0, 1, 2, 3, -4, -3, -2, -1]);
});

test('fftFreq matches numpy.fft.fftfreq for odd n', () => {
  // numpy.fft.fftfreq(5, d=1/5) == [0,1,2,-2,-1]
  const freqs = Array.from(fftFreq(5, 1 / 5));
  expect(freqs).toEqual([0, 1, 2, -2, -1]);
});

test('rfftFreq matches numpy.fft.rfftfreq', () => {
  // numpy.fft.rfftfreq(8, d=1/8) == [0,1,2,3,4]
  const freqs = Array.from(rfftFreq(8, 1 / 8));
  expect(freqs).toEqual([0, 1, 2, 3, 4]);
});

test('hannWindow is zero at the edges and periodic (endpoint not duplicated)', () => {
  const w = hannWindow(8);
  expect(w[0]).toBeCloseTo(0, 10);
  // periodic hann never re-reaches exactly 0 or 1 at the far edge (sym=False)
  expect(w[7]).toBeGreaterThan(0);
  expect(w[7]).toBeLessThan(0.2);
});

test('realFftHalf finds the correct peak bin for a pure sine wave', () => {
  const n = 256;
  const sampleRateHz = 256;
  const freqHzTarget = 32;
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) signal[i] = Math.sin((2 * Math.PI * freqHzTarget * i) / sampleRateHz);

  const spectrum = realFftHalf(signal, n);
  const mag = magnitude(spectrum);
  let peakIdx = 0;
  for (let i = 1; i < mag.length; i++) if (mag[i] > mag[peakIdx]) peakIdx = i;

  const freqs = rfftFreq(n, 1 / sampleRateHz);
  expect(freqs[peakIdx]).toBe(freqHzTarget);
});

test('realFftFull produces a conjugate-symmetric full spectrum', () => {
  const n = 16;
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) signal[i] = Math.sin((2 * Math.PI * 3 * i) / n) + 0.3;

  const spectrum = realFftFull(signal, n);
  for (let k = 1; k < n / 2; k++) {
    expect(spectrum.re[n - k]).toBeCloseTo(spectrum.re[k], 8);
    expect(spectrum.im[n - k]).toBeCloseTo(-spectrum.im[k], 8);
  }
});

test('realFftFull -> ifftFull round-trips the original signal', () => {
  const n = 32;
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) signal[i] = Math.sin((2 * Math.PI * 5 * i) / n) * 3 + 1;

  const spectrum = realFftFull(signal, n);
  const back = ifftFull(spectrum.re, spectrum.im);
  for (let i = 0; i < n; i++) {
    expect(back.re[i]).toBeCloseTo(signal[i], 8);
    expect(back.im[i]).toBeCloseTo(0, 8);
  }
});

test('gaussianFilter1dWrap preserves a constant signal', () => {
  const data = new Float64Array(64).fill(5.0);
  const smoothed = gaussianFilter1dWrap(data, 2.0);
  for (const v of smoothed) expect(v).toBeCloseTo(5.0, 10);
});

test('gaussianFilter1dWrap smooths a single spike and conserves its total mass', () => {
  const n = 64;
  const data = new Float64Array(n);
  data[32] = 1.0;
  const smoothed = gaussianFilter1dWrap(data, 2.0);

  expect(smoothed[32]).toBeLessThan(1.0);
  expect(smoothed[32]).toBeGreaterThan(0);
  // Neighboring bins should pick up some of the spike's energy.
  expect(smoothed[31]).toBeGreaterThan(0);
  expect(smoothed[33]).toBeGreaterThan(0);

  let total = 0;
  for (const v of smoothed) total += v;
  expect(total).toBeCloseTo(1.0, 8); // convolution with a normalized kernel conserves total mass
});

test('gaussianFilter1dWrap wraps across the array boundary', () => {
  const n = 64;
  const data = new Float64Array(n);
  data[0] = 1.0; // a spike right at the wrap boundary
  const smoothed = gaussianFilter1dWrap(data, 2.0);
  // Energy should spread to both the end of the array and the start,
  // proving the boundary is treated as circular, not zero-padded.
  expect(smoothed[n - 1]).toBeGreaterThan(0);
  expect(smoothed[1]).toBeGreaterThan(0);
});
