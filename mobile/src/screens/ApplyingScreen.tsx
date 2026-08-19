import { View } from 'react-native';
import type { ApplyingScreenProps } from '../controller/types';
import {
  Body,
  Card,
  Caption,
  Heading,
  PrimaryButton,
  ProgressBar,
  Screen,
  SecondaryButton,
  StatusPill,
  StepChecklist,
  space,
} from '../theme';

export function ApplyingScreen(props: ApplyingScreenProps) {
  const { apply, onDone, onRetryReconnect } = props;
  const isError = apply.phase === 'error';
  const isRunning = apply.phase === 'running';

  const savedButNotReconnected = apply.result?.saved === true && apply.result?.reconnected === false;

  return (
    <Screen>
      <View style={{ flex: 1, padding: space(3), gap: space(3) }}>
        <Heading level={1}>Applying Tune</Heading>

        <Card>
          <View style={{ gap: space(2.5) }}>
            <StepChecklist steps={apply.steps} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(1.5) }}>
              <View style={{ flex: 1 }}>
                <ProgressBar percent={apply.percent} />
              </View>
              <Body>{`${apply.percent}%`}</Body>
            </View>
          </View>
        </Card>

        {isRunning ? <Caption>Do not disconnect the flight controller.</Caption> : null}

        {isError ? (
          <Card>
            <View style={{ gap: space(2) }}>
              <StatusPill label="Apply Failed" tone="poor" />
              {apply.error ? <Body>{apply.error}</Body> : null}

              {savedButNotReconnected ? (
                <>
                  <Body muted>
                    The tune was saved to the flight controller, but it didn&apos;t reconnect afterward to
                    confirm — reconnect manually to verify.
                  </Body>
                  <View style={{ gap: space(1.5) }}>
                    <SecondaryButton title="Retry Reconnect" onPress={onRetryReconnect} />
                    <PrimaryButton title="Back to Start" onPress={onDone} />
                  </View>
                </>
              ) : (
                <>
                  <Body muted>No changes were saved — it&apos;s safe to try again.</Body>
                  <PrimaryButton title="Back to Start" onPress={onDone} />
                </>
              )}
            </View>
          </Card>
        ) : null}
      </View>
    </Screen>
  );
}
