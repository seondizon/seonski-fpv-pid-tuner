import { ScrollView, View } from 'react-native';
import type { FcInfoScreenProps, ProcessingPhase } from '../controller/types';
import {
  Body,
  Card,
  Caption,
  ChecklistStep,
  Heading,
  KeyValueRow,
  PrimaryButton,
  ProgressBar,
  Screen,
  SecondaryButton,
  SectionTitle,
  StatusPill,
  StepChecklist,
  space,
} from '../theme';

/** Formats a byte count as e.g. "4.2 MB" -- MB with one decimal is plenty of
 * precision for a blackbox download progress readout on a phone screen. */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) {
    const kb = bytes / 1024;
    return `${kb.toFixed(0)} KB`;
  }
  return `${mb.toFixed(1)} MB`;
}

const PHASE_ORDER: ProcessingPhase[] = ['downloading', 'decoding', 'analyzing', 'done'];

/** Only meaningful while `processing.phase` is one of the "active" phases
 * (downloading/decoding/analyzing/done) -- the 'error' phase is rendered as
 * its own distinct state below and never reads these statuses. */
function stepStatus(
  step: 'downloading' | 'decoding' | 'analyzing',
  phase: ProcessingPhase,
): ChecklistStep['status'] {
  const stepIndex = PHASE_ORDER.indexOf(step);
  const phaseIndex = PHASE_ORDER.indexOf(phase);
  if (phaseIndex > stepIndex) return 'done';
  if (phaseIndex === stepIndex) return 'in_progress';
  return 'pending';
}

export function FcInfoScreen(props: FcInfoScreenProps) {
  const { fcSummary, processing, onDownload, onRetry, onDisconnect } = props;

  const notStarted = processing.message === '' && processing.phase === 'downloading';
  const isError = processing.phase === 'error';
  const isActive = !notStarted && !isError;

  const downloadingStatus = stepStatus('downloading', processing.phase);
  const decodingStatus = stepStatus('decoding', processing.phase);
  const analyzingStatus = stepStatus('analyzing', processing.phase);

  const steps: ChecklistStep[] = [
    {
      name: 'Downloading Blackbox',
      status: downloadingStatus,
      detail:
        downloadingStatus === 'in_progress'
          ? `${formatBytes(processing.downloadedBytes)} / ${formatBytes(processing.totalBytes)}`
          : null,
    },
    {
      name: 'Decoding',
      status: decodingStatus,
      detail: decodingStatus === 'in_progress' ? processing.message : null,
    },
    {
      name: 'Analyzing',
      status: analyzingStatus,
      detail: analyzingStatus === 'in_progress' ? processing.message : null,
    },
  ];

  let percent = 0;
  if (downloadingStatus === 'done') percent += 100 / 3;
  else if (downloadingStatus === 'in_progress' && processing.totalBytes > 0) {
    percent += (processing.downloadedBytes / processing.totalBytes) * (100 / 3);
  }
  if (decodingStatus === 'done') percent += 100 / 3;
  if (analyzingStatus === 'done') percent += 100 / 3;
  if (processing.phase === 'done') percent = 100;
  const roundedPercent = Math.round(Math.max(0, Math.min(100, percent)));

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: space(3), gap: space(3) }}
        showsVerticalScrollIndicator={false}
      >
        <Card>
          <SectionTitle>Flight Controller</SectionTitle>
          <View style={{ marginBottom: space(1.5) }}>
            <StatusPill
              label={
                fcSummary.priorFlightCount > 0
                  ? `Recognized -- ${fcSummary.priorFlightCount} flight${fcSummary.priorFlightCount === 1 ? '' : 's'} recorded`
                  : 'New craft -- no flight history yet'
              }
              tone={fcSummary.priorFlightCount > 0 ? 'good' : 'neutral'}
            />
          </View>
          <View>
            <KeyValueRow label="Craft" value={fcSummary.craftName ?? '—'} />
            <KeyValueRow label="Betaflight" value={fcSummary.versionRaw ?? '—'} />
            <KeyValueRow label="Board / Target" value={fcSummary.boardTarget ?? '—'} />
            <KeyValueRow
              label="PID Profile"
              value={fcSummary.pidProfile != null ? `Profile ${fcSummary.pidProfile}` : '—'}
            />
            <KeyValueRow label="Blackbox Storage" value={fcSummary.blackboxStorage ?? '—'} />
            {fcSummary.blackboxUsedBytes != null ? (
              <KeyValueRow
                label="Blackbox Log"
                value={`${formatBytes(fcSummary.blackboxUsedBytes)} downloaded`}
              />
            ) : null}
          </View>
        </Card>

        {notStarted ? (
          <PrimaryButton title="DOWNLOAD BLACKBOX" onPress={onDownload} />
        ) : null}

        {isActive ? (
          <Card>
            <View style={{ gap: space(2.5) }}>
              <Heading level={2}>Analyzing Flight</Heading>
              <StepChecklist steps={steps} />
              <View style={{ gap: space(1) }}>
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <View style={{ flex: 1, marginRight: space(1.5) }}>
                    <ProgressBar percent={roundedPercent} />
                  </View>
                  <Body>{`${roundedPercent}%`}</Body>
                </View>
                {processing.message ? <Caption>{processing.message}</Caption> : null}
              </View>
            </View>
          </Card>
        ) : null}

        {isError ? (
          <Card>
            <View style={{ gap: space(2) }}>
              <StatusPill label="Something Went Wrong" tone="poor" />
              <Body>{processing.error ?? 'An unexpected error occurred.'}</Body>
              <View style={{ gap: space(1.5) }}>
                <PrimaryButton title="Retry" onPress={onRetry} />
                <SecondaryButton title="Back to Start" onPress={onDisconnect} />
              </View>
            </View>
          </Card>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
