import { ScrollView, View } from 'react-native';
import type { OscillationLevel } from '../analysis/grading';
import type { CompareResult } from '../tuning/compare';
import type { AnalysisScreenProps, AxisPidSetup } from '../controller/types';
import { NoiseSpectrumChart } from '../components/charts/NoiseSpectrumChart';
import { StepResponseChart } from '../components/charts/StepResponseChart';
import {
  Body,
  Card,
  Caption,
  Divider,
  Heading,
  KeyValueRow,
  Label,
  MetricTile,
  PrimaryButton,
  Screen,
  SecondaryButton,
  SectionTitle,
  StatusPill,
  Tone,
  toneFromGrade,
  space,
} from '../theme';

/** Plain-English, one-sentence explanations for terms a pilot who knows
 * Betaflight basics but not PID/noise theory won't necessarily know. Shown
 * via the small tappable "i" badge on KeyValueRow/MetricTile -- kept short
 * on purpose so it reads well in a native Alert popup. */
const HINTS = {
  p: 'How hard the axis corrects when it drifts off your stick input. Higher P reacts faster but can shake if too high.',
  i: 'Corrects slow drift over time, like wind or a bent frame pulling it off course. Too much can cause a slow wobble.',
  d: 'Smooths out overshoot and bounce as the axis settles. Higher D tightens stops but can pick up more noise.',
  ff: 'Feedforward -- reacts to your stick movement directly, making inputs feel more instant and less floaty.',
  dtermLpf: 'A filter that removes vibration noise from the D-term signal before it affects the motors.',
  gyroLpf: 'A filter that removes vibration noise from the gyro sensor before it’s used to correct flight.',
  tracking: 'How closely the actual flight matched your stick input. Higher % means it followed your commands more precisely.',
  overshoot: 'How far the copter swings past where your stick asked it to go before settling. Lower is tighter, more controlled.',
  settling: 'How long it takes to stop wobbling and settle after a stick movement. Lower means it locks in faster.',
  oscillation: 'How much the copter shakes or bounces after a move -- a sign the tune may be too aggressive for this axis.',
  gyroNoise: 'How much vibration is showing up in the raw gyro sensor data, often from props, motors, or loose hardware.',
  dtermNoise: 'How much vibration is showing up in the D-term signal specifically -- high noise here can mean D is picking up more shake than useful correction.',
  dtermRms: 'The overall strength of the D-term signal, vibration included. Higher isn’t automatically bad -- it’s only a problem alongside a high D/P ratio or high-freq energy.',
  dPRatio: 'How much of the D-term is noise/vibration versus useful correction, relative to P. Lower is cleaner; a high ratio means D is mostly reacting to shake, not your stick input.',
  hfEnergy: 'The share of the D-term signal that’s high-frequency noise (vibration) rather than smooth correction. Lower means a cleaner signal reaching the motors.',
} as const;

/** Betaflight PID/filter values are near-always whole numbers, but this
 * doesn't assume that -- one decimal place for anything that isn't. */
function fmtNum(v: number | null): string {
  if (v == null) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function fmtPct(v: number | null, digits = 1): string {
  return v == null ? '—' : `${v.toFixed(digits)}%`;
}

function fmtMs(v: number | null): string {
  return v == null ? '—' : `${v.toFixed(0)} ms`;
}

function fmtHz(v: number | null): string {
  return v == null ? '—' : `${fmtNum(v)} Hz`;
}

function toneFromOscillation(level: OscillationLevel): { tone: Tone; label: string } {
  switch (level) {
    case 'LOW':
      return { tone: 'good', label: 'Low' };
    case 'MODERATE':
      return { tone: 'fair', label: 'Moderate' };
    case 'HIGH':
      return { tone: 'poor', label: 'High' };
    default:
      return { tone: 'neutral', label: 'Unknown' };
  }
}

function toneFromComparison(better: CompareResult['better']): { tone: Tone; label: string } {
  switch (better) {
    case 'newer':
      return { tone: 'good', label: 'Improved' };
    case 'older':
      return { tone: 'fair', label: 'Regressed' };
    case 'tie':
      return { tone: 'neutral', label: 'Tie' };
    default:
      return { tone: 'neutral', label: 'Unknown' };
  }
}

function AxisPidColumn({ title, pid }: { title: string; pid: AxisPidSetup }) {
  return (
    <View style={{ minWidth: 110, flexGrow: 1, gap: space(0.25) }}>
      <Label>{title}</Label>
      <KeyValueRow label="P" value={fmtNum(pid.p)} hint={HINTS.p} />
      <KeyValueRow label="I" value={fmtNum(pid.i)} hint={HINTS.i} />
      <KeyValueRow label="D" value={fmtNum(pid.d)} hint={HINTS.d} />
      <KeyValueRow label="FF" value={fmtNum(pid.f)} hint={HINTS.ff} />
    </View>
  );
}

export function AnalysisScreen(props: AnalysisScreenProps) {
  const { fcSummary, currentTune, result } = props;
  const { summary, readiness, recommendations, comparison } = result;

  const rollSummary = summary.axes?.roll;
  const pitchSummary = summary.axes?.pitch;
  const noise = summary.noise;

  const rollChart = result.byAxis.roll;
  const pitchChart = result.byAxis.pitch;

  const noRecsAndNotBlocked = recommendations.length === 0 && !readiness.blocked;
  const primaryDisabled = readiness.blocked || recommendations.length === 0;
  // Filter-category recommendations never carry a concrete proposedValue --
  // see engine.ts -- so if every recommendation is one of those, the next
  // screen won't have anything to actually apply. Label the button
  // accordingly here rather than letting the user tap "GET RECOMMENDATION"
  // and land on a dead-end disabled Apply button with no warning.
  const hasApplicableRecommendation = recommendations.some((r) => r.proposedValue !== null);
  const primaryLabel = recommendations.length > 0 && !hasApplicableRecommendation ? 'VIEW GUIDANCE' : 'GET RECOMMENDATION';

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: space(3), gap: space(3) }}
        showsVerticalScrollIndicator={false}
      >
        {/* 1. Current Setup */}
        <View style={{ gap: space(1.5) }}>
          <SectionTitle>Current Setup</SectionTitle>
          <Card>
            <View style={{ gap: space(2) }}>
              {fcSummary.craftName ? <Heading level={3}>{fcSummary.craftName}</Heading> : null}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
                <AxisPidColumn title="Roll" pid={currentTune.roll} />
                <AxisPidColumn title="Pitch" pid={currentTune.pitch} />
                <AxisPidColumn title="Yaw" pid={currentTune.yaw} />
              </View>
              <Divider />
              <View style={{ gap: space(0.25) }}>
                <Label>Filters</Label>
                <KeyValueRow label="D-Term Filter 1" value={fmtHz(currentTune.filters.dtermLpf1Hz)} hint={HINTS.dtermLpf} />
                <KeyValueRow label="D-Term Filter 2" value={fmtHz(currentTune.filters.dtermLpf2Hz)} hint={HINTS.dtermLpf} />
                <KeyValueRow label="Gyro Filter 1" value={fmtHz(currentTune.filters.gyroLpf1Hz)} hint={HINTS.gyroLpf} />
                <KeyValueRow label="Gyro Filter 2" value={fmtHz(currentTune.filters.gyroLpf2Hz)} hint={HINTS.gyroLpf} />
              </View>
            </View>
          </Card>
        </View>

        {/* 2. Tune Status */}
        <View style={{ gap: space(1.5) }}>
          <SectionTitle>Tune Status</SectionTitle>
          <Card>
            <View style={{ gap: space(1.5) }}>
              {readiness.blocked ? (
                <>
                  <StatusPill tone="neutral" label="More Data Needed" />
                  <View style={{ gap: space(0.5) }}>
                    {readiness.blockReasons.map((reason, idx) => (
                      <Caption key={idx}>{reason}</Caption>
                    ))}
                  </View>
                </>
              ) : recommendations.length === 0 ? (
                <>
                  <StatusPill tone="good" label="Tune Complete" />
                  <Body>
                    Your current tune is already within the target range. No tuning changes are
                    recommended.
                  </Body>
                </>
              ) : (
                <>
                  {(() => {
                    const { tone, label } = toneFromGrade(summary.overallGrade);
                    return <StatusPill tone={tone} label={label} />;
                  })()}
                  <Caption>Tuning Recommended</Caption>
                </>
              )}

              <KeyValueRow
                label="Confidence"
                value={`${Math.round(readiness.confidencePct)}%`}
                hint="How much flight data we had to base this on. More usable step inputs from your flight means a more reliable result."
              />

              {comparison ? (
                <View style={{ gap: space(0.5) }}>
                  <Divider />
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(1) }}>
                    {(() => {
                      const { tone, label } = toneFromComparison(comparison.better);
                      return <StatusPill tone={tone} label={label} />;
                    })()}
                    <Caption style={{ flex: 1 }}>{`vs. previous flight: ${comparison.summary}`}</Caption>
                  </View>
                </View>
              ) : null}
            </View>
          </Card>
        </View>

        {/* 3. Flight Metrics */}
        <View style={{ gap: space(1.5) }}>
          <SectionTitle>Flight Metrics</SectionTitle>
          <Card>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
              <MetricTile label="Roll Tracking" value={fmtPct(rollSummary?.trackingPct ?? null)} hint={HINTS.tracking} />
              <MetricTile label="Pitch Tracking" value={fmtPct(pitchSummary?.trackingPct ?? null)} hint={HINTS.tracking} />
              <MetricTile label="Roll Overshoot" value={fmtPct(rollSummary?.overshootPct ?? null)} hint={HINTS.overshoot} />
              <MetricTile label="Pitch Overshoot" value={fmtPct(pitchSummary?.overshootPct ?? null)} hint={HINTS.overshoot} />
              <MetricTile label="Roll Settling" value={fmtMs(rollSummary?.settlingTimeMs ?? null)} hint={HINTS.settling} />
              <MetricTile label="Pitch Settling" value={fmtMs(pitchSummary?.settlingTimeMs ?? null)} hint={HINTS.settling} />
              <MetricTile
                label="Roll Oscillation"
                value={toneFromOscillation(rollSummary?.oscillation ?? 'UNKNOWN').label}
                tone={toneFromOscillation(rollSummary?.oscillation ?? 'UNKNOWN').tone}
                hint={HINTS.oscillation}
              />
              <MetricTile
                label="Pitch Oscillation"
                value={toneFromOscillation(pitchSummary?.oscillation ?? 'UNKNOWN').label}
                tone={toneFromOscillation(pitchSummary?.oscillation ?? 'UNKNOWN').tone}
                hint={HINTS.oscillation}
              />
              <MetricTile
                label="Gyro Noise"
                value={toneFromGrade(noise?.gyroGrade).label}
                tone={toneFromGrade(noise?.gyroGrade).tone}
                hint={HINTS.gyroNoise}
              />
              <MetricTile
                label="D-Term Noise"
                value={toneFromGrade(noise?.dtermGrade).label}
                tone={toneFromGrade(noise?.dtermGrade).tone}
                hint={HINTS.dtermNoise}
              />
            </View>
          </Card>
        </View>

        {/* 4. Step Response */}
        <View style={{ gap: space(1.5) }}>
          <SectionTitle>Step Response</SectionTitle>
          <Body muted>
            Each chart shows how quickly and cleanly the copter followed a quick stick movement,
            averaged across the flight. The dashed "Target" line is where a well-tuned response
            settles -- reaching it fast without swinging past it (overshoot) or wobbling around it
            (oscillation) means a tight, locked-in tune.
          </Body>
          <Card>
            {rollChart ? (
              <View style={{ gap: space(1) }}>
                <StepResponseChart data={rollChart.stepResponse} axisLabel="Roll" />
                <Caption>
                  {`Used ${rollChart.stepResponse.numSegmentsUsed} of ${
                    rollChart.stepResponse.numSegmentsUsed + rollChart.stepResponse.numSegmentsRejected
                  } step inputs from this flight`}
                </Caption>
              </View>
            ) : (
              <Body muted>No roll step-response data available for this flight.</Body>
            )}
          </Card>
          <Card>
            {pitchChart ? (
              <View style={{ gap: space(1) }}>
                <StepResponseChart data={pitchChart.stepResponse} axisLabel="Pitch" />
                <Caption>
                  {`Used ${pitchChart.stepResponse.numSegmentsUsed} of ${
                    pitchChart.stepResponse.numSegmentsUsed + pitchChart.stepResponse.numSegmentsRejected
                  } step inputs from this flight`}
                </Caption>
              </View>
            ) : (
              <Body muted>No pitch step-response data available for this flight.</Body>
            )}
          </Card>
        </View>

        {/* 5. Noise */}
        <View style={{ gap: space(1.5) }}>
          <SectionTitle>Noise</SectionTitle>
          <Body muted>
            Shows how much vibration the gyro picked up at each frequency -- the flatter and lower
            the line, the cleaner the signal. A tall spike points to a likely cause (labeled next to
            it, e.g. "motor" or "prop blade pass") -- usually something to fix mechanically (prop
            balance, a loose motor, frame resonance), not with PID values.
          </Body>
          <Card>
            {rollChart ? (
              <View style={{ gap: space(1) }}>
                <NoiseSpectrumChart
                  freqHz={rollChart.gyroSpectrum.freqHz}
                  magnitudeDb={rollChart.gyroSpectrum.magnitudeDb}
                  axisLabel="Roll"
                  peakHz={noise?.mainPeakHz ?? null}
                  peakClassification={noise?.mainPeakClassification ?? null}
                />
                {noise?.motorHarmonicLikely ? <Caption>Possible motor harmonic</Caption> : null}
                <Divider />
                <View style={{ gap: space(0.25) }}>
                  <KeyValueRow label="D-Term RMS" value={rollChart.dtermNoise.dTermRms.toFixed(2)} hint={HINTS.dtermRms} />
                  <KeyValueRow label="D/P Ratio" value={rollChart.dtermNoise.dPRatio.toFixed(2)} hint={HINTS.dPRatio} />
                  <KeyValueRow
                    label="High-Freq Energy"
                    value={`${(rollChart.dtermNoise.hfEnergyRatio * 100).toFixed(1)}%`}
                    hint={HINTS.hfEnergy}
                  />
                </View>
              </View>
            ) : (
              <Body muted>No roll noise data available for this flight.</Body>
            )}
          </Card>
          <Card>
            {pitchChart ? (
              <View style={{ gap: space(1) }}>
                <NoiseSpectrumChart
                  freqHz={pitchChart.gyroSpectrum.freqHz}
                  magnitudeDb={pitchChart.gyroSpectrum.magnitudeDb}
                  axisLabel="Pitch"
                />
                <Caption>Dominant peak detection uses roll gyro data.</Caption>
                <Divider />
                <View style={{ gap: space(0.25) }}>
                  <KeyValueRow label="D-Term RMS" value={pitchChart.dtermNoise.dTermRms.toFixed(2)} />
                  <KeyValueRow label="D/P Ratio" value={pitchChart.dtermNoise.dPRatio.toFixed(2)} />
                  <KeyValueRow
                    label="High-Freq Energy"
                    value={`${(pitchChart.dtermNoise.hfEnergyRatio * 100).toFixed(1)}%`}
                  />
                </View>
              </View>
            ) : (
              <Body muted>No pitch noise data available for this flight.</Body>
            )}
          </Card>
        </View>
      </ScrollView>

      {/* 6. Bottom actions */}
      <View style={{ paddingHorizontal: space(3), paddingTop: space(2), paddingBottom: space(3), gap: space(1.5) }}>
        <Divider style={{ marginBottom: space(0.5) }} />
        <View style={{ flexDirection: 'row', gap: space(1.5) }}>
          <SecondaryButton title="EXIT" onPress={props.onExit} style={{ flex: 1 }} />
          {noRecsAndNotBlocked ? (
            <PrimaryButton title="FINISH" onPress={props.onFinish} style={{ flex: 1 }} />
          ) : (
            <PrimaryButton
              title={primaryLabel}
              onPress={props.onGetRecommendation}
              disabled={primaryDisabled}
              style={{ flex: 2 }}
            />
          )}
        </View>
      </View>
    </Screen>
  );
}
