/** Shared visual-system primitives, styled per the Seonski Brand Design
 * System PDF: card-based, spacious, 8px grid, 12-16px radius, Montserrat
 * type, signature red as the one deliberate accent per screen. Every
 * screen component in src/screens/ should be built from these rather than
 * ad-hoc View/Text/TouchableOpacity styling, so the four main screens stay
 * visually consistent.
 */
import { ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { fonts, radius, space } from './tokens';
import { typography } from './typography';
import { useThemeColors } from './useThemeColors';

/** Small tap-to-explain "i" badge for a jargon term -- most users of this
 * app won't know PID/filter/noise terminology, but the layout can't afford
 * a paragraph of explanation next to every label. Alert.alert is a
 * deliberately minimal choice: a native, zero-dependency, one-tap popover,
 * not a custom tooltip/popover component. */
export function InfoBadge({ title, hint }: { title: string; hint: string }) {
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={() => Alert.alert(title, hint)}
      hitSlop={10}
      style={{
        width: 14,
        height: 14,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: colors.textSecondary,
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: 4,
      }}
    >
      <Text style={{ fontSize: 9, lineHeight: 11, fontFamily: fonts.semiBold, color: colors.textSecondary }}>
        i
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Screen({
  children,
  style,
}: {
  children: ReactNode;
  style?: ViewStyle;
}) {
  const colors = useThemeColors();
  return <View style={[{ flex: 1, backgroundColor: colors.canvas }, style]}>{children}</View>;
}

export function Card({
  children,
  style,
  onPress,
}: {
  children: ReactNode;
  style?: ViewStyle;
  onPress?: () => void;
}) {
  const colors = useThemeColors();
  const content = (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderColor: colors.border },
        style,
      ]}
    >
      {children}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [pressed && { opacity: 0.85 }]}>
      {content}
    </Pressable>
  );
}

export function Divider({ style }: { style?: ViewStyle }) {
  const colors = useThemeColors();
  return <View style={[{ height: 1, backgroundColor: colors.border }, style]} />;
}

// ---------------------------------------------------------------------------
// Typography helpers
// ---------------------------------------------------------------------------

export function Heading({
  children,
  level = 1,
  style,
}: {
  children: ReactNode;
  level?: 1 | 2 | 3;
  style?: TextStyle;
}) {
  const colors = useThemeColors();
  const preset = level === 1 ? typography.h1 : level === 2 ? typography.h2 : typography.h3;
  return <Text style={[preset, { color: colors.textPrimary }, style]}>{children}</Text>;
}

export function Body({
  children,
  muted = false,
  style,
}: {
  children: ReactNode;
  muted?: boolean;
  style?: TextStyle;
}) {
  const colors = useThemeColors();
  return (
    <Text style={[typography.body, { color: muted ? colors.textSecondary : colors.textPrimary }, style]}>
      {children}
    </Text>
  );
}

export function Caption({ children, style }: { children: ReactNode; style?: TextStyle }) {
  const colors = useThemeColors();
  return <Text style={[typography.caption, { color: colors.textSecondary }, style]}>{children}</Text>;
}

export function Label({ children, style }: { children: ReactNode; style?: TextStyle }) {
  const colors = useThemeColors();
  return <Text style={[typography.label, { color: colors.textSecondary }, style]}>{children}</Text>;
}

export function SectionTitle({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const colors = useThemeColors();
  return (
    <View style={[{ marginBottom: space(1.5) }, style]}>
      <Text style={[typography.h3, { color: colors.textPrimary }]}>{children}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

interface ButtonProps {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}

export function PrimaryButton({ title, onPress, disabled, loading, style }: ButtonProps) {
  const colors = useThemeColors();
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: isDisabled ? colors.border : pressed ? colors.accentPressed : colors.accent,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={colors.textOnAccent} />
      ) : (
        <Text
          style={[typography.button, { color: isDisabled ? colors.textSecondary : colors.textOnAccent }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.8}
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function SecondaryButton({ title, onPress, disabled, style }: ButtonProps) {
  const colors = useThemeColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        styles.buttonSecondary,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      <Text
        style={[typography.button, { color: colors.textPrimary }]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.8}
      >
        {title}
      </Text>
    </Pressable>
  );
}

export function TextLink({ title, onPress, style }: ButtonProps) {
  const colors = useThemeColors();
  return (
    <Pressable onPress={onPress} style={style}>
      <Text style={[typography.button, { color: colors.accent }]}>{title}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type Tone = 'good' | 'fair' | 'poor' | 'neutral';

const TONE_COLORS: Record<Tone, { fg: string; bg: string }> = {
  good: { fg: '#3D8A4E', bg: '#E3F1E6' },
  fair: { fg: '#C1861F', bg: '#F6ECD9' },
  poor: { fg: '#CC3D42', bg: '#F7E5E6' },
  neutral: { fg: '#8E8E8E', bg: '#EDEDEE' },
};

export function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  const { fg, bg } = TONE_COLORS[tone];
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[typography.label, { color: fg, textTransform: 'none' }]}>{label}</Text>
    </View>
  );
}

/** Maps this project's Grade ('GOOD'|'FAIR'|'POOR'|'UNKNOWN') to a display
 * tone + human label, without inventing a grade the analysis engine
 * doesn't actually produce. */
export function toneFromGrade(grade: string | undefined): { tone: Tone; label: string } {
  switch (grade) {
    case 'GOOD':
      return { tone: 'good', label: 'Good' };
    case 'FAIR':
      return { tone: 'fair', label: 'Fair' };
    case 'POOR':
      return { tone: 'poor', label: 'Needs Attention' };
    default:
      return { tone: 'neutral', label: 'Unknown' };
  }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export function ProgressBar({ percent }: { percent: number }) {
  const colors = useThemeColors();
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <View style={[styles.trackOuter, { backgroundColor: colors.border }]}>
      <View style={[styles.trackFill, { width: `${clamped}%`, backgroundColor: colors.accent }]} />
    </View>
  );
}

export interface ChecklistStep {
  name: string;
  status: 'pending' | 'in_progress' | 'done' | 'error';
  detail?: string | null;
}

function StepIcon({ status }: { status: ChecklistStep['status'] }) {
  const colors = useThemeColors();
  if (status === 'done') {
    return (
      <Svg width={20} height={20} viewBox="0 0 20 20">
        <Circle cx={10} cy={10} r={10} fill={semanticGood} />
        <Path d="M5.5 10.2l3 3 6-6.4" stroke="#FFFFFF" strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    );
  }
  if (status === 'error') {
    return (
      <Svg width={20} height={20} viewBox="0 0 20 20">
        <Circle cx={10} cy={10} r={10} fill={TONE_COLORS.poor.fg} />
        <Path d="M7 7l6 6M13 7l-6 6" stroke="#FFFFFF" strokeWidth={2} strokeLinecap="round" />
      </Svg>
    );
  }
  if (status === 'in_progress') {
    return <ActivityIndicator size="small" color={colors.accent} />;
  }
  return (
    <View
      style={{
        width: 18,
        height: 18,
        borderRadius: 9,
        borderWidth: 2,
        borderColor: colors.border,
      }}
    />
  );
}

const semanticGood = '#3D8A4E';

/** A named, ordered checklist with per-step status -- the shared visual
 * pattern behind Screen 2's "Downloading / Decoding / Analyzing" progress
 * and the Apply-Tune flow's "Backup / Writing / Verifying / Saving /
 * Rebooting / Reconnecting / Final verification" progress. Accepts the
 * same shape as jobs.ts's JobStep so a Job's toSnapshot().steps can be
 * passed straight through. */
export function StepChecklist({ steps }: { steps: ChecklistStep[] }) {
  const colors = useThemeColors();
  return (
    <View style={{ gap: space(1.5) }}>
      {steps.map((step) => (
        <View key={step.name} style={{ flexDirection: 'row', alignItems: 'center', gap: space(1.5) }}>
          <StepIcon status={step.status} />
          <View style={{ flex: 1 }}>
            <Text
              style={[
                typography.bodyMedium,
                {
                  color: step.status === 'pending' ? colors.textSecondary : colors.textPrimary,
                },
              ]}
            >
              {step.name}
            </Text>
            {step.detail ? <Caption>{step.detail}</Caption> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Data display
// ---------------------------------------------------------------------------

export function MetricTile({
  label,
  value,
  sublabel,
  tone = 'neutral',
  hint,
}: {
  label: string;
  value: string;
  sublabel?: string;
  tone?: Tone;
  /** One-sentence, plain-English explanation shown in a native Alert when
   * the small "i" badge next to the label is tapped -- see InfoBadge. */
  hint?: string;
}) {
  const colors = useThemeColors();
  const toneColor = tone === 'neutral' ? colors.textPrimary : TONE_COLORS[tone].fg;
  return (
    <View style={styles.metricTile}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Label>{label}</Label>
        {hint ? <InfoBadge title={label} hint={hint} /> : null}
      </View>
      <Text style={[typography.numeric, { color: toneColor, marginTop: 2 }]}>{value}</Text>
      {sublabel ? <Caption>{sublabel}</Caption> : null}
    </View>
  );
}

export function KeyValueRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  /** One-sentence, plain-English explanation shown in a native Alert when
   * the small "i" badge next to the label is tapped -- see InfoBadge. */
  hint?: string;
}) {
  const colors = useThemeColors();
  return (
    <View style={styles.kvRow}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={[typography.body, { color: colors.textSecondary }]}>{label}</Text>
        {hint ? <InfoBadge title={label} hint={hint} /> : null}
      </View>
      <Text
        style={[typography.bodyMedium, { color: colors.textPrimary, flexShrink: 1, textAlign: 'right' }]}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space(2),
  },
  button: {
    borderRadius: radius.md,
    paddingVertical: space(1.75),
    paddingHorizontal: space(1),
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  buttonSecondary: {
    borderWidth: 1,
  },
  pill: {
    alignSelf: 'flex-start',
    paddingHorizontal: space(1.25),
    paddingVertical: space(0.5),
    borderRadius: radius.sm,
  },
  trackOuter: {
    height: 10,
    borderRadius: 999,
    overflow: 'hidden',
  },
  trackFill: {
    height: '100%',
    borderRadius: 999,
  },
  metricTile: {
    minWidth: 120,
    flexGrow: 1,
  },
  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: space(0.75),
  },
});
