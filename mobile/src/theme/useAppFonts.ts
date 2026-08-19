import {
  Montserrat_400Regular,
  Montserrat_500Medium,
  Montserrat_600SemiBold,
  Montserrat_700Bold,
  Montserrat_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/montserrat';

/** Loads every Montserrat weight the type scale (typography.ts) uses.
 * Returns false until loading finishes (or failed) -- callers should hold
 * a splash/blank view until this is true, since RN silently falls back to
 * a system font otherwise. */
export function useAppFonts(): boolean {
  const [loaded] = useFonts({
    Montserrat_400Regular,
    Montserrat_500Medium,
    Montserrat_600SemiBold,
    Montserrat_700Bold,
    Montserrat_800ExtraBold,
  });
  return loaded;
}
