import { ScrollView, View } from 'react-native';
import type { AppliedScreenProps } from '../controller/types';
import { Body, Card, Heading, PrimaryButton, Screen, SectionTitle, StatusPill, space } from '../theme';

/** Friendly display names for the CLI parameter names the tuning engine
 * emits -- duplicated from RecommendationScreen.tsx rather than shared,
 * since these are separate presentational files (see task instructions). */
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

const NEXT_FLIGHT_STEPS = [
  'Disconnect the quad',
  'Fly normally',
  'Include several clean roll and pitch inputs',
  'Land',
  'Reconnect the FC',
  'Analyze the new Blackbox log',
];

export function AppliedScreen(props: AppliedScreenProps) {
  const { apply, onDone } = props;
  const applied = apply.result?.applied ?? [];

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: space(3), gap: space(3), flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ gap: space(1.5) }}>
          <StatusPill label="Success" tone="good" />
          <Heading level={1}>Tune Applied Successfully</Heading>
        </View>

        {applied.length > 0 ? (
          <Body muted>{`Updated: ${applied.map(friendlyParamName).join(', ')}`}</Body>
        ) : null}

        <Card>
          <View style={{ gap: space(1) }}>
            <SectionTitle>Next Test Flight</SectionTitle>
            {NEXT_FLIGHT_STEPS.map((step, idx) => (
              <Body key={step}>{`${idx + 1}. ${step}`}</Body>
            ))}
          </View>
        </Card>

        <View style={{ flex: 1 }} />

        <PrimaryButton title="DONE" onPress={onDone} />
      </ScrollView>
    </Screen>
  );
}
