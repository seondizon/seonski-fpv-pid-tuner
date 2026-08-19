import { useEffect, useRef } from 'react';
import { Animated, Image, View } from 'react-native';
import type { WaitingScreenProps } from '../controller/types';
import {
  Body,
  Card,
  Caption,
  Heading,
  KeyValueRow,
  PrimaryButton,
  Screen,
  StatusPill,
  space,
  typography,
  useThemeColors,
} from '../theme';

/** This wordmark variant is all dark lettering (black/red/charcoal), so it
 * reads directly on the app's light canvas without needing a background
 * field -- unlike the mixed light/dark variant used for the splash screen,
 * which does need one. Deliberately a tiny corner signature, not a focal
 * point. */
function BrandFooter() {
  return (
    <View style={{ alignItems: 'center', paddingBottom: space(4) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(1) }}>
        <Caption>Built by</Caption>
        <Image
          source={require('../../assets/seonski-black.png')}
          style={{ width: 62, height: 21 }}
          resizeMode="contain"
          accessibilityLabel="Seonski"
        />
      </View>
    </View>
  );
}

/** A calm, breathing dashed ring shown while no FC is attached. Built from a
 * plain View (no border-style tricks beyond RN's own `borderStyle: 'dashed'`)
 * pulsed via RN's built-in Animated API -- no external animation library.
 * The loop is torn down on unmount so it never leaks. */
function PulsingRing() {
  const colors = useThemeColors();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1400, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1400, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.9] });

  return (
    <View style={{ width: 160, height: 160, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        style={{
          width: 160,
          height: 160,
          borderRadius: 80,
          borderWidth: 2,
          borderStyle: 'dashed',
          borderColor: colors.accent,
          opacity,
          transform: [{ scale }],
        }}
      />
    </View>
  );
}

export function WaitingScreen(props: WaitingScreenProps) {
  const { fcAttached, deviceLabel, connecting, connectError, onConnect } = props;
  const colors = useThemeColors();

  return (
    <Screen>
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: space(3),
          gap: space(4),
        }}
      >
        <Heading level={1} style={{ ...typography.display, textAlign: 'center' }}>
          FPV Tuner
        </Heading>

        {!fcAttached ? (
          <View style={{ alignItems: 'center', gap: space(3) }}>
            <PulsingRing />
            <View style={{ alignItems: 'center', gap: space(1) }}>
              <Heading level={2} style={{ textAlign: 'center' }}>
                Waiting for Flight Controller
              </Heading>
              <Body muted style={{ textAlign: 'center' }}>
                Connect your Betaflight FC using USB.
              </Body>
            </View>
          </View>
        ) : (
          <View style={{ width: '100%', alignItems: 'center', gap: space(3) }}>
            <View style={{ alignItems: 'center', gap: space(1.5) }}>
              <StatusPill label="Flight Controller Detected" tone="good" />
              {deviceLabel ? (
                <View style={{ width: '100%' }}>
                  <KeyValueRow label="Device" value={deviceLabel} />
                </View>
              ) : null}
            </View>

            <View style={{ width: '100%', gap: space(2) }}>
              <PrimaryButton
                title="CONNECT"
                onPress={onConnect}
                loading={connecting}
                disabled={connecting}
              />
            </View>
          </View>
        )}

        {/* Shown either after a failed CONNECT attempt, or after the
            disconnect watchdog bounced back here from elsewhere in the app
            (see useTunerController.ts) -- kept outside the attached/not-
            attached branches above since a genuine mid-session unplug lands
            here with fcAttached already false. */}
        {connectError ? (
          <Card style={{ width: '100%' }}>
            <View style={{ gap: space(1) }}>
              <StatusPill label="Connection Lost" tone="poor" />
              <Body>{connectError}</Body>
              <Caption>Reconnect the USB cable, then tap CONNECT once the FC is detected again.</Caption>
            </View>
          </Card>
        ) : null}
      </View>

      <BrandFooter />
    </Screen>
  );
}
