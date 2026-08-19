import type { TextStyle } from 'react-native';
import { fonts } from './tokens';

/** Type scale from the brand doc's "3. Typography" table, mapped to RN
 * TextStyle presets. Color is deliberately NOT baked in here -- screens
 * apply `useThemeColors().textPrimary` / `.textSecondary` so the same
 * preset works in both themes. */
export const typography: Record<string, TextStyle> = {
  display: { fontFamily: fonts.extraBold, fontSize: 40, lineHeight: 44, letterSpacing: -0.5 },
  h1: { fontFamily: fonts.bold, fontSize: 28, lineHeight: 34 },
  h2: { fontFamily: fonts.semiBold, fontSize: 22, lineHeight: 28 },
  h3: { fontFamily: fonts.semiBold, fontSize: 18, lineHeight: 24 },
  body: { fontFamily: fonts.regular, fontSize: 16, lineHeight: 23 },
  bodyMedium: { fontFamily: fonts.medium, fontSize: 16, lineHeight: 23 },
  button: { fontFamily: fonts.semiBold, fontSize: 15, letterSpacing: 0.2 },
  label: { fontFamily: fonts.semiBold, fontSize: 13, letterSpacing: 0.4, textTransform: 'uppercase' },
  caption: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16 },
  numeric: { fontFamily: fonts.semiBold, fontSize: 20, fontVariant: ['tabular-nums'] },
};
