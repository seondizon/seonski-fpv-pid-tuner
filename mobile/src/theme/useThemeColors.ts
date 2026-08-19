import { useColorScheme } from 'react-native';
import { darkColors, lightColors, ThemeColors } from './tokens';

export function useThemeColors(): ThemeColors {
  const scheme = useColorScheme();
  return scheme === 'dark' ? darkColors : lightColors;
}
