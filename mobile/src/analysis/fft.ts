/** FFT and windowing utilities backing the analysis engine.
 *
 * Ported from the Python reference's use of numpy's fft/rfft/fftfreq family
 * and scipy.signal.windows.hann, built on top of `fft.js` (a pure-JS
 * radix-4 FFT with no native dependencies, suitable for Hermes).
 *
 * IMPORTANT DEVIATION FROM THE PYTHON REFERENCE: numpy's FFT supports
 * arbitrary transform lengths; fft.js only supports power-of-two sizes.
 * Every call site in this module zero-pads to `nextPow2` of its natural
 * length. backend/app/analysis/fft_noise.py's rfft calls do NOT zero-pad
 * (numpy handles the natural, non-padded length directly), so this
 * changes the exact bin count/frequency resolution at those call sites
 * compared to the Python reference -- this is intentional and documented
 * at each call site, not an oversight. It does not apply to
 * step_response.py's port, which already zero-pads to a power of two in
 * the original Python.
 */
import FFT from 'fft.js';

export function nextPow2(n: number): number {
  return 1 << Math.ceil(Math.log2(Math.max(n, 1)));
}

/** Matches numpy.fft.fftfreq(n, d): full bin ordering
 * [0, 1, ..., ceil(n/2)-1, -floor(n/2), ..., -1] / (n*d). */
export function fftFreq(n: number, d: number): Float64Array {
  const val = 1.0 / (n * d);
  const result = new Float64Array(n);
  const posCount = Math.floor((n - 1) / 2) + 1;
  for (let i = 0; i < posCount; i++) result[i] = i;
  let idx = posCount;
  for (let i = -Math.floor(n / 2); i < 0; i++) result[idx++] = i;
  for (let i = 0; i < n; i++) result[i] *= val;
  return result;
}

/** Matches numpy.fft.rfftfreq(n, d): non-negative bins only, length
 * floor(n/2)+1. */
export function rfftFreq(n: number, d: number): Float64Array {
  const val = 1.0 / (n * d);
  const count = Math.floor(n / 2) + 1;
  const result = new Float64Array(count);
  for (let i = 0; i < count; i++) result[i] = i * val;
  return result;
}

/** Periodic (sym=False) Hann window, matching
 * scipy.signal.windows.hann(length, sym=False): w[n] = 0.5*(1-cos(2*pi*n/N)). */
export function hannWindow(length: number): Float64Array {
  const w = new Float64Array(length);
  for (let n = 0; n < length; n++) {
    w[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / length));
  }
  return w;
}

export interface ComplexSpectrum {
  re: Float64Array;
  im: Float64Array;
}

/** Real-input FFT, zero-padded to `size` (must be a power of two), full
 * spectrum (size complex bins) via conjugate-symmetric mirroring --
 * equivalent to numpy.fft.fft() of a real, zero-padded input. */
export function realFftFull(input: ArrayLike<number>, size: number): ComplexSpectrum {
  const f = new FFT(size);
  const real = new Array(size).fill(0);
  const n = Math.min(input.length, size);
  for (let i = 0; i < n; i++) real[i] = input[i];
  const out = f.createComplexArray();
  f.realTransform(out, real);
  f.completeSpectrum(out);
  return unpackComplexArray(out, size);
}

/** Real-input FFT, zero-padded to `size` (must be a power of two), only
 * the non-redundant half (size/2+1 bins) -- equivalent to numpy.fft.rfft(). */
export function realFftHalf(input: ArrayLike<number>, size: number): ComplexSpectrum {
  const f = new FFT(size);
  const real = new Array(size).fill(0);
  const n = Math.min(input.length, size);
  for (let i = 0; i < n; i++) real[i] = input[i];
  const out = f.createComplexArray();
  f.realTransform(out, real);
  return unpackComplexArray(out, size / 2 + 1);
}

/** Full complex inverse FFT (fft.js normalizes by 1/size internally,
 * matching numpy's default "backward" normalization convention). */
export function ifftFull(re: Float64Array, im: Float64Array): ComplexSpectrum {
  const size = re.length;
  const f = new FFT(size);
  const data = f.createComplexArray();
  for (let i = 0; i < size; i++) {
    data[2 * i] = re[i];
    data[2 * i + 1] = im[i];
  }
  const out = f.createComplexArray();
  f.inverseTransform(out, data);
  return unpackComplexArray(out, size);
}

export function magnitude(spec: ComplexSpectrum): Float64Array {
  const n = spec.re.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.hypot(spec.re[i], spec.im[i]);
  return out;
}

function unpackComplexArray(interleaved: number[], count: number): ComplexSpectrum {
  const re = new Float64Array(count);
  const im = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    re[i] = interleaved[2 * i];
    im[i] = interleaved[2 * i + 1];
  }
  return { re, im };
}

/** 1D Gaussian smoothing with circular (wrap) boundary handling, matching
 * scipy.ndimage.gaussian_filter1d(mode='wrap', truncate=4.0): kernel radius
 * = floor(truncate*sigma + 0.5), kernel normalized to sum 1. */
export function gaussianFilter1dWrap(data: Float64Array, sigma: number): Float64Array {
  const n = data.length;
  if (n === 0) return new Float64Array(0);
  const truncate = 4.0;
  const radius = Math.max(0, Math.floor(truncate * sigma + 0.5));
  const kernel = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-0.5 * (i / sigma) ** 2);
    kernel[i + radius] = w;
    sum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      const idx = ((i + k) % n + n) % n;
      acc += data[idx] * kernel[k + radius];
    }
    out[i] = acc;
  }
  return out;
}
