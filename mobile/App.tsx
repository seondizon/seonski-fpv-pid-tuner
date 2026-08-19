import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

import { useAppFonts, useThemeColors } from './src/theme';
import { useTunerController } from './src/controller/useTunerController';
import { WaitingScreen } from './src/screens/WaitingScreen';
import { FcInfoScreen } from './src/screens/FcInfoScreen';
import { AnalysisScreen } from './src/screens/AnalysisScreen';
import { RecommendationScreen } from './src/screens/RecommendationScreen';
import { ApplyingScreen } from './src/screens/ApplyingScreen';
import { AppliedScreen } from './src/screens/AppliedScreen';

// The native splash screen's auto-hide doesn't reliably fire under React
// Native's Bridgeless/New Architecture mode (confirmed live: a standalone
// release build sat on the splash screen indefinitely even though the JS
// bundle had loaded and rendered fine underneath it -- only ever showed up
// outside dev-client builds, which have different native scaffolding).
// Explicitly holding then releasing it once fonts are ready is the
// standard, reliable pattern -- don't go back to relying on auto-hide.
SplashScreen.preventAutoHideAsync().catch(() => {});

/** Root component: a thin switch over the tuning flow's current screen.
 * All FC/blackbox/analysis/tuning orchestration lives in
 * useTunerController(); every screen below is presentational, driven
 * entirely by the prop bundle the controller hands it. */
export default function App() {
  const colors = useThemeColors();
  const fontsLoaded = useAppFonts();
  const controller = useTunerController();

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: colors.canvas }} />;
  }

  return (
    <>
      <StatusBar style="auto" />
      {controller.screen === 'waiting' && <WaitingScreen {...controller.waitingProps} />}
      {controller.screen === 'fcInfo' && <FcInfoScreen {...controller.fcInfoProps} />}
      {controller.screen === 'analysis' && controller.analysisProps && (
        <AnalysisScreen {...controller.analysisProps} />
      )}
      {controller.screen === 'recommendation' && controller.recommendationProps && (
        <RecommendationScreen {...controller.recommendationProps} />
      )}
      {controller.screen === 'applying' && <ApplyingScreen {...controller.applyingProps} />}
      {controller.screen === 'applied' && <AppliedScreen {...controller.appliedProps} />}
    </>
  );
}
