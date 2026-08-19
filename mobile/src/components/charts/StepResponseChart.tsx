/** Self-contained SVG line chart for a single axis's normalized step
 * response (see analysis/stepResponse.ts's module docstring -- `response`
 * is already a deconvolved, normalized curve converging to 1.0, not a raw
 * setpoint/gyro pair). Reads theme colors itself so it renders correctly in
 * both light and dark without the caller having to thread colors through.
 */
import { View } from 'react-native';
import Svg, { Line, Path, Text as SvgText } from 'react-native-svg';
import type { StepResponseResult } from '../../analysis/stepResponse';
import { Body, Caption, space, typography, useThemeColors } from '../../theme';

export interface StepResponseChartProps {
  data: StepResponseResult;
  axisLabel: string;
}

const CHART_W = 320;
const CHART_H = 180;
const MARGIN_LEFT = 36;
const MARGIN_RIGHT = 10;
const MARGIN_TOP = 14;
const MARGIN_BOTTOM = 22;
const PLOT_W = CHART_W - MARGIN_LEFT - MARGIN_RIGHT;
const PLOT_H = CHART_H - MARGIN_TOP - MARGIN_BOTTOM;

function niceNum(n: number): string {
  return Math.abs(n) < 10 ? n.toFixed(2) : n.toFixed(0);
}

export function StepResponseChart({ data, axisLabel }: StepResponseChartProps) {
  const colors = useThemeColors();

  if (data.numSegmentsUsed === 0) {
    return (
      <View style={{ minHeight: CHART_H, justifyContent: 'center', gap: space(0.5) }}>
        <Body muted style={{ textAlign: 'center' }}>
          Not enough clean step inputs in this flight to plot a {axisLabel.toLowerCase()} response
          curve.
        </Body>
      </View>
    );
  }

  const timeS = data.timeS;
  const response = data.response;
  const tMax = timeS.length > 0 ? timeS[timeS.length - 1] : 0.5;

  let peak = -Infinity;
  let dataMin = Infinity;
  for (const v of response) {
    if (!Number.isFinite(v)) continue;
    if (v > peak) peak = v;
    if (v < dataMin) dataMin = v;
  }
  if (!Number.isFinite(peak)) peak = 1.0;
  if (!Number.isFinite(dataMin)) dataMin = 0;

  const yMax = Math.max(1.3, peak * 1.1);
  const yMin = Math.min(0, dataMin * 1.1);
  const yRange = yMax - yMin || 1;

  const xOf = (t: number) => MARGIN_LEFT + (tMax > 0 ? (t / tMax) * PLOT_W : 0);
  const yOf = (v: number) => MARGIN_TOP + PLOT_H - ((v - yMin) / yRange) * PLOT_H;

  let pathD = '';
  for (let i = 0; i < timeS.length; i++) {
    const v = response[i];
    if (!Number.isFinite(v)) continue;
    const x = xOf(timeS[i]);
    const y = yOf(v);
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
    vTicks.push((tMax * i) / (vTickCount - 1));
  }

  const targetY = yOf(1.0);
  const showTargetLine = 1.0 >= yMin && 1.0 <= yMax;

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
        {vTicks.map((t, idx) => {
          const x = xOf(t);
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
        {vTicks.map((t, idx) => (
          <SvgText
            key={`vl-${idx}`}
            x={xOf(t)}
            y={MARGIN_TOP + PLOT_H + 14}
            fontSize={9}
            fill={colors.textSecondary}
            textAnchor="middle"
          >
            {`${t.toFixed(2)}s`}
          </SvgText>
        ))}

        {showTargetLine ? (
          <>
            <Line
              x1={MARGIN_LEFT}
              y1={targetY}
              x2={MARGIN_LEFT + PLOT_W}
              y2={targetY}
              stroke={colors.textSecondary}
              strokeWidth={1}
              strokeDasharray="4,4"
            />
            <SvgText
              x={MARGIN_LEFT + PLOT_W}
              y={targetY - 4}
              fontSize={9}
              fill={colors.textSecondary}
              textAnchor="end"
            >
              Target
            </SvgText>
          </>
        ) : null}

        <Path d={pathD} stroke={colors.accent} strokeWidth={2} fill="none" />
      </Svg>
    </View>
  );
}
