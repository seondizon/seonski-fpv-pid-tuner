/** Self-contained SVG line chart for a gyro noise spectrum (frequency vs.
 * magnitude in dB). The source arrays can be several thousand bins wide and
 * extend to the Nyquist frequency, so this component downsamples to a
 * plotting-friendly bin count and clips to the frequency range this
 * product actually cares about (motor/prop/structural noise, per
 * analysis/fftNoise.ts's band definitions) before drawing.
 */
import { View } from 'react-native';
import Svg, { Line, Path, Text as SvgText } from 'react-native-svg';
import { Body, space, typography, useThemeColors } from '../../theme';

export interface NoiseSpectrumChartProps {
  freqHz: Float64Array;
  magnitudeDb: Float64Array;
  axisLabel: string;
  peakHz?: number | null;
  peakClassification?: string | null;
}

const CHART_W = 320;
const CHART_H = 180;
const MARGIN_LEFT = 36;
const MARGIN_RIGHT = 10;
const MARGIN_TOP = 14;
const MARGIN_BOTTOM = 22;
const PLOT_W = CHART_W - MARGIN_LEFT - MARGIN_RIGHT;
const PLOT_H = CHART_H - MARGIN_TOP - MARGIN_BOTTOM;

const MAX_PLOTTED_HZ = 500;
const NUM_BINS = 150;

/** Downsamples (freqHz, magnitudeDb) to NUM_BINS evenly-spaced bins across
 * [0, MAX_PLOTTED_HZ], taking the max magnitude observed in each bin. Bins
 * with no source samples are filled from the nearest bin that has one, so
 * the plotted line never has a hole in it. */
function downsample(freqHz: Float64Array, magnitudeDb: Float64Array): { freq: number; mag: number }[] {
  const binWidth = MAX_PLOTTED_HZ / NUM_BINS;
  const binMax = new Array<number>(NUM_BINS).fill(-Infinity);
  const binHasData = new Array<boolean>(NUM_BINS).fill(false);

  const n = Math.min(freqHz.length, magnitudeDb.length);
  for (let i = 0; i < n; i++) {
    const f = freqHz[i];
    if (f < 0 || f > MAX_PLOTTED_HZ) continue;
    let b = Math.floor(f / binWidth);
    if (b >= NUM_BINS) b = NUM_BINS - 1;
    if (b < 0) b = 0;
    const m = magnitudeDb[i];
    if (Number.isFinite(m) && m > binMax[b]) {
      binMax[b] = m;
      binHasData[b] = true;
    }
  }

  // Forward-fill, then backward-fill, so gaps inherit a neighboring value.
  let lastKnown: number | null = null;
  for (let b = 0; b < NUM_BINS; b++) {
    if (binHasData[b]) lastKnown = binMax[b];
    else if (lastKnown !== null) binMax[b] = lastKnown;
  }
  lastKnown = null;
  for (let b = NUM_BINS - 1; b >= 0; b--) {
    if (binHasData[b]) lastKnown = binMax[b];
    else if (lastKnown !== null) binMax[b] = lastKnown;
  }

  const out: { freq: number; mag: number }[] = [];
  for (let b = 0; b < NUM_BINS; b++) {
    if (!Number.isFinite(binMax[b])) continue;
    out.push({ freq: (b + 0.5) * binWidth, mag: binMax[b] });
  }
  return out;
}

function niceNum(n: number): string {
  return n.toFixed(0);
}

function friendlyClassification(classification: string): string {
  return classification.replace(/_/g, ' ');
}

export function NoiseSpectrumChart({
  freqHz,
  magnitudeDb,
  axisLabel,
  peakHz,
  peakClassification,
}: NoiseSpectrumChartProps) {
  const colors = useThemeColors();

  if (freqHz.length === 0) {
    return (
      <View style={{ minHeight: CHART_H, justifyContent: 'center', gap: space(0.5) }}>
        <Body muted style={{ textAlign: 'center' }}>
          Not enough gyro data in this flight to plot a {axisLabel.toLowerCase()} noise spectrum.
        </Body>
      </View>
    );
  }

  const points = downsample(freqHz, magnitudeDb);

  let magMin = Infinity;
  let magMax = -Infinity;
  for (const p of points) {
    if (p.mag < magMin) magMin = p.mag;
    if (p.mag > magMax) magMax = p.mag;
  }
  if (!Number.isFinite(magMin) || !Number.isFinite(magMax)) {
    magMin = 0;
    magMax = 1;
  }
  const headroom = Math.max((magMax - magMin) * 0.1, 1);
  const yMin = magMin - headroom;
  const yMax = magMax + headroom;
  const yRange = yMax - yMin || 1;

  const xOf = (f: number) => MARGIN_LEFT + (f / MAX_PLOTTED_HZ) * PLOT_W;
  const yOf = (v: number) => MARGIN_TOP + PLOT_H - ((v - yMin) / yRange) * PLOT_H;

  let pathD = '';
  for (const p of points) {
    const x = xOf(p.freq);
    const y = yOf(p.mag);
    pathD += pathD === '' ? `M${x.toFixed(1)},${y.toFixed(1)}` : ` L${x.toFixed(1)},${y.toFixed(1)}`;
  }

  const hTickCount = 4;
  const hTicks: number[] = [];
  for (let i = 0; i < hTickCount; i++) {
    hTicks.push(yMin + (yRange * i) / (hTickCount - 1));
  }

  const vTickCount = 3;
  const vTicks: number[] = [];
  for (let i = 0; i < vTickCount; i++) {
    vTicks.push((MAX_PLOTTED_HZ * i) / (vTickCount - 1));
  }

  const showPeak = peakHz != null && peakHz >= 0 && peakHz <= MAX_PLOTTED_HZ;
  const peakX = showPeak ? xOf(peakHz as number) : 0;
  const peakLabel = showPeak
    ? `${Math.round(peakHz as number)} Hz${peakClassification ? ` · ${friendlyClassification(peakClassification)}` : ''}`
    : '';

  return (
    <View style={{ gap: space(0.5) }}>
      <Body style={typography.bodyMedium}>{axisLabel}</Body>
      <Svg width="100%" height={CHART_H} viewBox={`0 0 ${CHART_W} ${CHART_H}`}>
        {hTicks.map((v, idx) => {
          const y = yOf(v);
          return (
            <Line
              key={`h-${idx}`}
              x1={MARGIN_LEFT}
              y1={y}
              x2={MARGIN_LEFT + PLOT_W}
              y2={y}
              stroke={colors.border}
              strokeWidth={1}
            />
          );
        })}
        {vTicks.map((f, idx) => {
          const x = xOf(f);
          return (
            <Line
              key={`v-${idx}`}
              x1={x}
              y1={MARGIN_TOP}
              x2={x}
              y2={MARGIN_TOP + PLOT_H}
              stroke={colors.border}
              strokeWidth={1}
            />
          );
        })}

        {hTicks.map((v, idx) => (
          <SvgText
            key={`hl-${idx}`}
            x={MARGIN_LEFT - 4}
            y={yOf(v) + 3}
            fontSize={9}
            fill={colors.textSecondary}
            textAnchor="end"
          >
            {niceNum(v)}
          </SvgText>
        ))}
        {vTicks.map((f, idx) => (
          <SvgText
            key={`vl-${idx}`}
            x={xOf(f)}
            y={MARGIN_TOP + PLOT_H + 14}
            fontSize={9}
            fill={colors.textSecondary}
            textAnchor="middle"
          >
            {`${niceNum(f)}Hz`}
          </SvgText>
        ))}

        <Path d={pathD} stroke={colors.accent} strokeWidth={2} fill="none" />

        {showPeak ? (
          <>
            <Line
              x1={peakX}
              y1={MARGIN_TOP}
              x2={peakX}
              y2={MARGIN_TOP + PLOT_H}
              stroke={colors.textSecondary}
              strokeWidth={1}
              strokeDasharray="3,3"
            />
            <SvgText
              x={
                peakX < MARGIN_LEFT + 30
                  ? MARGIN_LEFT + 2
                  : peakX > MARGIN_LEFT + PLOT_W - 30
                    ? MARGIN_LEFT + PLOT_W - 2
                    : peakX
              }
              y={MARGIN_TOP - 4}
              fontSize={9}
              fill={colors.textSecondary}
              textAnchor={peakX < MARGIN_LEFT + 30 ? 'start' : peakX > MARGIN_LEFT + PLOT_W - 30 ? 'end' : 'middle'}
            >
              {peakLabel}
            </SvgText>
          </>
        ) : null}
      </Svg>
    </View>
  );
}
