import { useState } from 'react';
import { Modal, ScrollView, View } from 'react-native';
import type { RecommendationScreenProps, CurrentTuneSetup } from '../controller/types';
import type { Recommendation } from '../tuning/engine';
import {
  Body,
  Card,
  Caption,
  Divider,
  Heading,
  InfoBadge,
  Label,
  PrimaryButton,
  Screen,
  SecondaryButton,
  SectionTitle,
  StatusPill,
  space,
  useThemeColors,
} from '../theme';

/** Friendly display names for the CLI parameter names the tuning engine
 * emits. Falls back to the raw parameter string for anything unanticipated
 * so a new engine parameter never silently disappears from the UI. */
const PARAM_LABELS: Record<string, string> = {
  p_roll: 'Roll P',
  i_roll: 'Roll I',
  d_roll: 'Roll D',
  f_roll: 'Roll FF',
  p_pitch: 'Pitch P',
  i_pitch: 'Pitch I',
  d_pitch: 'Pitch D',
  f_pitch: 'Pitch FF',
  p_yaw: 'Yaw P',
  i_yaw: 'Yaw I',
  d_yaw: 'Yaw D',
  f_yaw: 'Yaw FF',
  dterm_lpf1_static_hz: 'D-Term Filter Cutoff',
};

function friendlyParamName(parameter: string): string {
  return PARAM_LABELS[parameter] ?? parameter;
}

/** One-sentence, plain-English explanation for the small tappable "i"
 * badge next to each recommendation's parameter name -- most users here
 * know Betaflight basics but not PID/filter theory. Keyed by the term
 * letter/kind rather than per-axis, since "what P does" doesn't change
 * between Roll and Pitch. */
const PARAM_HINTS: Record<string, string> = {
  p: 'How hard the axis corrects when it drifts off your stick input. Higher P reacts faster but can shake if too high.',
  i: 'Corrects slow drift over time. Too much can cause a slow wobble.',
  d: 'Smooths out overshoot and bounce as the axis settles. Higher D tightens stops but can pick up more noise.',
  ff: 'Feedforward -- reacts to your stick movement directly, making inputs feel more instant.',
  dterm_lpf1_static_hz: 'A filter that removes vibration noise from the D-term signal before it affects the motors.',
};

function hintForParam(parameter: string): string | null {
  if (parameter in PARAM_HINTS) return PARAM_HINTS[parameter];
  const term = parameter.split('_')[0];
  return PARAM_HINTS[term] ?? null;
}

/** Maps a filter CLI parameter name to its key in CurrentTuneSetup.filters
 * -- used only as a fallback display for filter-category recommendations,
 * which never carry a concrete currentValue of their own (see engine.ts). */
const FILTER_PARAM_TO_TUNE_KEY: Record<string, keyof CurrentTuneSetup['filters']> = {
  dterm_lpf1_static_hz: 'dtermLpf1Hz',
  dterm_lpf2_static_hz: 'dtermLpf2Hz',
  gyro_lpf1_static_hz: 'gyroLpf1Hz',
  gyro_lpf2_static_hz: 'gyroLpf2Hz',
};

function formatPct(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function formatSignedPct(changePct: number): string {
  return `${changePct > 0 ? '+' : ''}${formatPct(changePct)}%`;
}

/** Descriptive change text for recommendations with no concrete
 * proposedValue (filter-category recs -- see engine.ts module doc). Never
 * fabricates a Hz number the engine didn't produce. */
function descriptiveChange(changePct: number): string {
  if (changePct < 0) return `${formatPct(Math.abs(changePct))}% lower`;
  if (changePct > 0) return `${formatPct(changePct)}% higher`;
  return 'no change';
}

function currentValueDisplay(rec: Recommendation, currentTune: CurrentTuneSetup): { value: string; note?: string } {
  if (rec.currentValue !== null) {
    return { value: String(rec.currentValue) };
  }
  const filterKey = FILTER_PARAM_TO_TUNE_KEY[rec.parameter];
  if (filterKey) {
    const value = currentTune.filters[filterKey];
    if (value !== null) {
      return { value: String(value), note: 'current' };
    }
  }
  return { value: '—' };
}

function recommendedValueDisplay(rec: Recommendation): string {
  if (rec.proposedValue !== null) return String(rec.proposedValue);
  return descriptiveChange(rec.changePct);
}

function RecommendationCard({ rec, currentTune }: { rec: Recommendation; currentTune: CurrentTuneSetup }) {
  const current = currentValueDisplay(rec, currentTune);
  const hint = hintForParam(rec.parameter);
  return (
    <Card>
      <View style={{ gap: space(1.5) }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
            <Heading level={3}>{friendlyParamName(rec.parameter)}</Heading>
            {hint ? <InfoBadge title={friendlyParamName(rec.parameter)} hint={hint} /> : null}
          </View>
          <Caption>{formatSignedPct(rec.changePct)}</Caption>
        </View>

        <View style={{ flexDirection: 'row', gap: space(3) }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Label>Current</Label>
            <Body>{current.value}</Body>
            {current.note ? <Caption>{current.note}</Caption> : null}
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Label>Recommended</Label>
            <Body>{recommendedValueDisplay(rec)}</Body>
          </View>
        </View>

        <View style={{ gap: 2 }}>
          <Label>Why</Label>
          <Body muted>{rec.reason}</Body>
        </View>

        <Caption>{`Confidence: ${rec.confidencePct}%`}</Caption>
      </View>
    </Card>
  );
}

function summaryLine(rec: Recommendation): string {
  const name = friendlyParamName(rec.parameter);
  if (rec.proposedValue !== null) {
    const from = rec.currentValue !== null ? String(rec.currentValue) : '—';
    return `${name}  ${from} → ${rec.proposedValue}`;
  }
  return `${name}  (~${descriptiveChange(rec.changePct)})`;
}

export function RecommendationScreen(props: RecommendationScreenProps) {
  const { recommendations, confidencePct, currentTune, onCancel, onApply } = props;
  const [confirmVisible, setConfirmVisible] = useState(false);
  const colors = useThemeColors();

  const rollRecs = recommendations.filter((r) => r.category === 'roll');
  const pitchRecs = recommendations.filter((r) => r.category === 'pitch');
  const filterRecs = recommendations.filter((r) => r.category === 'filter_ff');

  // Only recommendations with a concrete proposedValue are ever written to
  // the FC (filter-category recs are advisory-only -- see engine.ts and
  // useTunerController.ts's applicableRecommendations); de-duped by
  // parameter name since two axes can name the same non-per-axis FC
  // setting. This must match what onApply actually sends, or the counts
  // and the confirmation dialog would overpromise.
  const seenParams = new Set<string>();
  const applicableRecs = recommendations.filter((r) => {
    if (r.proposedValue === null) return false;
    if (seenParams.has(r.parameter)) return false;
    seenParams.add(r.parameter);
    return true;
  });
  const canApply = applicableRecs.length > 0;

  return (
    <Screen>
      <View style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ padding: space(3), gap: space(3) }}
          showsVerticalScrollIndicator={false}
        >
          <Heading level={1}>Recommended Tune</Heading>

          {!canApply ? (
            <Card>
              <View style={{ gap: space(1) }}>
                <StatusPill label="Guidance Only" tone="neutral" />
                <Body muted>
                  These are advisory suggestions -- they point in a direction (e.g. lower a filter
                  cutoff) without a computed target value, so there's nothing to apply automatically
                  here. Adjust them manually in Betaflight Configurator if you'd like to try them.
                </Body>
              </View>
            </Card>
          ) : null}

          {rollRecs.length > 0 ? (
            <View style={{ gap: space(2) }}>
              <SectionTitle>Roll</SectionTitle>
              {rollRecs.map((rec) => (
                <RecommendationCard key={rec.parameter} rec={rec} currentTune={currentTune} />
              ))}
            </View>
          ) : null}

          {pitchRecs.length > 0 ? (
            <View style={{ gap: space(2) }}>
              <SectionTitle>Pitch</SectionTitle>
              {pitchRecs.map((rec) => (
                <RecommendationCard key={rec.parameter} rec={rec} currentTune={currentTune} />
              ))}
            </View>
          ) : null}

          {filterRecs.length > 0 ? (
            <View style={{ gap: space(2) }}>
              <SectionTitle>Filters</SectionTitle>
              {filterRecs.map((rec, idx) => (
                <RecommendationCard key={`${rec.parameter}-${idx}`} rec={rec} currentTune={currentTune} />
              ))}
            </View>
          ) : null}

          <Card>
            <View style={{ gap: space(1) }}>
              <SectionTitle>Recommendation Summary</SectionTitle>
              {recommendations.map((rec, idx) => (
                <Body key={`${rec.parameter}-${idx}`}>{summaryLine(rec)}</Body>
              ))}
              <Caption>{`${applicableRecs.length} setting(s) will be changed.`}</Caption>
              <Caption>{`Confidence: ${confidencePct}%`}</Caption>
            </View>
          </Card>
        </ScrollView>

        <Divider />
        <View style={{ flexDirection: 'row', gap: space(2), padding: space(3) }}>
          <View style={{ flex: 1 }}>
            <SecondaryButton title="CANCEL" onPress={onCancel} />
          </View>
          <View style={{ flex: 1 }}>
            <PrimaryButton title="APPLY TUNE" onPress={() => setConfirmVisible(true)} disabled={!canApply} />
          </View>
        </View>
      </View>

      <Modal visible={confirmVisible} transparent animationType="fade" onRequestClose={() => setConfirmVisible(false)}>
        <View
          style={{
            flex: 1,
            backgroundColor: colors.overlay,
            alignItems: 'center',
            justifyContent: 'center',
            padding: space(3),
          }}
        >
          <Card style={{ width: '100%', maxWidth: 420 }}>
            <View style={{ gap: space(2) }}>
              <Heading level={2}>Apply Recommended Tune?</Heading>
              <Body>The current Betaflight configuration will be backed up before any changes are made.</Body>
              <Body>{`${applicableRecs.length} setting(s) will be modified.`}</Body>
              <View style={{ flexDirection: 'row', gap: space(2), marginTop: space(1) }}>
                <View style={{ flex: 1 }}>
                  <SecondaryButton title="Cancel" onPress={() => setConfirmVisible(false)} />
                </View>
                <View style={{ flex: 1 }}>
                  <PrimaryButton
                    title="Apply Tune"
                    onPress={() => {
                      onApply();
                      setConfirmVisible(false);
                    }}
                  />
                </View>
              </View>
            </View>
          </Card>
        </View>
      </Modal>
    </Screen>
  );
}
