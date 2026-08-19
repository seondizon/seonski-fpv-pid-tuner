/** Design tokens derived from the Seonski Brand Design System (v1.0) PDF.
 *
 * The PDF's own "Default design recipe" is light-first (white/off-white
 * canvas, charcoal text, signature red accent) -- that's `light` below.
 * `dark` reuses the brand's own "Deep Charcoal" dark-mode-surface color
 * rather than inventing a new palette, keeping the same red accent and
 * charcoal/gray relationships so the app reads as the same product in
 * either theme.
 *
 * Semantic tones (good/fair/poor) are intentionally NOT the brand red --
 * the brand doc calls for "one strong red focal point per composition" and
 * warns against turning everything red, so status (a POOR grade) uses its
 * own danger color and the brand red stays reserved for actions/accents.
 */
export const brand = {
  red: '#CC3D42',
  redDark: '#A92E33',
  redSoft: '#E58B8E',
  redPale: '#F7E5E6',
  charcoal: '#4C4C4C',
  charcoalDeep: '#303030',
  gray: '#D1D1D1',
  grayBorder: '#E8E8E8',
  offWhite: '#F2F1F3',
  white: '#FFFFFF',
  textMuted: '#8E8E8E',
} as const;

export const semantic = {
  good: '#3D8A4E',
  goodSoft: '#E3F1E6',
  fair: '#C1861F',
  fairSoft: '#F6ECD9',
  poor: '#CC3D42',
  poorSoft: '#F7E5E6',
  neutral: '#8E8E8E',
  neutralSoft: '#EDEDEE',
} as const;

export interface ThemeColors {
  canvas: string;
  canvasAlt: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textOnAccent: string;
  accent: string;
  accentPressed: string;
  accentSoft: string;
  overlay: string;
}

export const lightColors: ThemeColors = {
  canvas: brand.offWhite,
  canvasAlt: brand.white,
  surface: brand.white,
  surfaceRaised: brand.white,
  border: brand.grayBorder,
  textPrimary: brand.charcoal,
  textSecondary: brand.textMuted,
  textOnAccent: brand.white,
  accent: brand.red,
  accentPressed: brand.redDark,
  accentSoft: brand.redPale,
  overlay: 'rgba(48,48,48,0.55)',
};

export const darkColors: ThemeColors = {
  canvas: brand.charcoalDeep,
  canvasAlt: '#262626',
  surface: '#3A3A3A',
  surfaceRaised: '#434343',
  border: '#4C4C4C',
  textPrimary: brand.offWhite,
  textSecondary: '#B7B7B7',
  textOnAccent: brand.white,
  accent: brand.red,
  accentPressed: brand.redSoft,
  accentSoft: 'rgba(204,61,66,0.18)',
  overlay: 'rgba(0,0,0,0.6)',
};

/** 8px base grid, per the brand doc's spacing token. */
export function space(units: number): number {
  return units * 8;
}

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
} as const;

export const fonts = {
  regular: 'Montserrat_400Regular',
  medium: 'Montserrat_500Medium',
  semiBold: 'Montserrat_600SemiBold',
  bold: 'Montserrat_700Bold',
  extraBold: 'Montserrat_800ExtraBold',
} as const;
