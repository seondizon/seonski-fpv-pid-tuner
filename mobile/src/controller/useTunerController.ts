/** Top-level app state machine + FC/analysis/tuning orchestration.
 *
 * This hook owns ALL of the flow logic described in the product's UX spec
 * (waiting -> connect -> FC info + blackbox processing -> analysis ->
 * recommendation -> confirm -> applying -> applied -> back to waiting) and
 * exposes one prop-bundle per screen. Screens under src/screens/ are pure
 * presentational components; every FC/blackbox/analysis/tuning call lives
 * here so the visual refactor never touches the underlying engines.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import UsbSerial from '../../modules/usb-serial/src/UsbSerialModule';
import { detectFcDevice, looksLikeFc } from '../fc/detect';
import { SerialTransport } from '../fc/transport';
import { BetaflightCliClient } from '../fc/cliClient';
import { getBlackboxStorageType, getCraftName, getPidProfileIndex } from '../fc/info';
import { parseVersionFromCliBanner } from '../fc/version';
import { resolveGetParam } from '../fc/paramCompat';
import { readBlackboxFromFc } from '../fc/blackboxReader';
import { MSP_UID, buildMspV1Request, parseMspV1Response, parseUidPayload, readMspV1Frame } from '../fc/msp';
import { decodeBlackboxLog } from '../blackbox/decoder';
import { buildBlackboxLog, type BlackboxLog } from '../analysis/blackboxLog';
import { computeStepResponse } from '../analysis/stepResponse';
import { computeTrackingErrorStats } from '../analysis/tracking';
import { computeDtermNoiseMetrics } from '../analysis/fftNoise';
import { hannWindow, magnitude, nextPow2, realFftHalf, rfftFreq } from '../analysis/fft';
import { buildAnalysisSummary, type AnalysisSummary } from '../tuning/analysisSummary';
import { computeReadiness, generateRecommendations, type Recommendation } from '../tuning/engine';
import { applyJobStepNames, applyTuningChanges } from '../tuning/apply';
import { createJob } from '../jobs';
import { craftIdFromName, getLatestIteration, loadIterations, saveIteration, type AppliedChange } from '../tuning/store';
import { compareIterations } from '../tuning/compare';
import type {
  AnalysisResult,
  ApplyState,
  CurrentPidValues,
  CurrentTuneSetup,
  FcSummary,
  ProcessingState,
  ScreenName,
} from './types';

const FC_POLL_INTERVAL_MS = 1500;
const RECONNECT_TIMEOUT_S = 30;
const RECONNECT_POLL_INTERVAL_S = 2;

const EMPTY_PROCESSING: ProcessingState = {
  phase: 'downloading',
  downloadedBytes: 0,
  totalBytes: 0,
  message: '',
  error: null,
};

const EMPTY_APPLY: ApplyState = { phase: 'idle', steps: [], percent: 0, result: null, error: null };

function emptyAxisPids() {
  return { p: null, i: null, d: null, f: null };
}

/** Reads the FC's factory-programmed hardware UID over MSP (must be called
 * while the transport is in normal MSP mode, i.e. before enterCli()) -- see
 * fc/msp.ts's MSP_UID doc. This is the authoritative per-craft identity key:
 * unlike the CLI craft name, it can't collide between two different
 * physical FCs and doesn't change if the craft is renamed, which matters
 * once someone is tuning more than one quad with this app. Returns null
 * (never throws) if the request fails for any reason, so callers can fall
 * back to name-based identification rather than blocking the whole connect
 * flow on this one best-effort read. */
async function readFcUid(transport: SerialTransport): Promise<string | null> {
  try {
    await transport.write(buildMspV1Request(MSP_UID));
    const raw = await readMspV1Frame(transport, 2000);
    const { payload } = parseMspV1Response(raw);
    return parseUidPayload(payload);
  } catch {
    return null;
  }
}

// e.g. "# Betaflight / STM32F7X2 4.5.0 Jan  1 2024 / 12:00:00 (abcdef1234) MSP API: 1.45"
// The CLI echoes the sent command back before printing this line, so the
// banner text can't be assumed to start on line 1 -- find the actual
// "Betaflight / ..." line instead of taking the first line blindly.
function boardTargetFromVersionBanner(banner: string): string | null {
  const match = /Betaflight\s*\/\s*(\S+)/.exec(banner);
  return match ? match[1] : null;
}

/** A short, display-friendly version string (e.g. "4.5.0") -- the CLI
 * banner also carries a build date/hash/MSP-API tail that's useful for
 * debugging but too long for the compact FC-info card, so this
 * deliberately shows less than the full banner rather than truncating it
 * awkwardly mid-string. */
function shortVersionFromBanner(banner: string): string | null {
  return parseVersionFromCliBanner(banner)?.raw ?? null;
}

/** Reads each canonical parameter name, falling back to any known legacy
 * alias for firmware where it was renamed (see paramCompat.ts -- e.g. the
 * dterm/gyro *_static_hz filter names on pre-4.3.0 Betaflight). Values are
 * always stored under the canonical (modern) key regardless of which
 * actual CLI name resolved, so every downstream consumer (buildCurrentTuneSetup,
 * the tuning engine, the apply path) only ever needs to know the modern name. */
async function readNumericParams(
  client: BetaflightCliClient,
  params: readonly string[]
): Promise<CurrentPidValues> {
  const out: CurrentPidValues = {};
  for (const param of params) {
    const resolved = await resolveGetParam(client, param);
    if (!resolved) continue;
    const match = /=\s*(-?\d+(?:\.\d+)?)/.exec(resolved.response);
    if (match) out[param] = parseFloat(match[1]);
  }
  return out;
}

const TUNE_PARAMS = [
  'p_roll', 'i_roll', 'd_roll', 'f_roll',
  'p_pitch', 'i_pitch', 'd_pitch', 'f_pitch',
  'p_yaw', 'i_yaw', 'd_yaw', 'f_yaw',
  'dterm_lpf1_static_hz', 'dterm_lpf2_static_hz', 'gyro_lpf1_static_hz', 'gyro_lpf2_static_hz',
] as const;

function buildCurrentTuneSetup(values: CurrentPidValues): CurrentTuneSetup {
  const axis = (prefix: string) => ({
    p: values[`p_${prefix}`] ?? null,
    i: values[`i_${prefix}`] ?? null,
    d: values[`d_${prefix}`] ?? null,
    f: values[`f_${prefix}`] ?? null,
  });
  return {
    roll: axis('roll'),
    pitch: axis('pitch'),
    yaw: axis('yaw'),
    filters: {
      dtermLpf1Hz: values.dterm_lpf1_static_hz ?? null,
      dtermLpf2Hz: values.dterm_lpf2_static_hz ?? null,
      gyroLpf1Hz: values.gyro_lpf1_static_hz ?? null,
      gyroLpf2Hz: values.gyro_lpf2_static_hz ?? null,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Betaflight's USB CDC-ACM connection can drop/re-enumerate as a direct,
 * expected result of leaving CLI mode or `save` rebooting the FC (see
 * cliClient.ts's exitCli() doc and apply.ts's module doc) -- confirmed
 * repeatedly against real hardware. A transport object that was open
 * before that reset is no longer usable even though `_isOpen` still reads
 * true, so every call site that just finished a CLI/save operation must
 * close, wait for re-enumeration, rescan, and open a fresh transport
 * before the next MSP or CLI exchange -- never assume the old transport
 * still works. Returns null if the FC hasn't reappeared yet. */
async function reopenFcTransport(
  previous: SerialTransport | null,
  waitMs: number = 1500
): Promise<SerialTransport | null> {
  if (previous) await previous.close().catch(() => {});
  await sleep(waitMs);
  const device = detectFcDevice();
  if (!device) return null;
  const transport = new SerialTransport(device.deviceId, 115200);
  await transport.open();
  return transport;
}

/** Only recommendations with a concrete, engine-computed proposedValue are
 * safe to write to the FC -- filter-category recs are advisory-only (see
 * engine.ts). Also de-dupes by parameter name: engine.ts can independently
 * recommend the same non-per-axis FC parameter from both roll and pitch
 * analysis, and writing it twice would just have the second write silently
 * win with no guarantee it's the more correct of the two. */
export function applicableRecommendations(
  recommendations: Recommendation[],
  seenParams: Set<string> = new Set()
): Recommendation[] {
  const out: Recommendation[] = [];
  for (const rec of recommendations) {
    if (rec.proposedValue === null) continue;
    if (seenParams.has(rec.parameter)) continue;
    seenParams.add(rec.parameter);
    out.push(rec);
  }
  return out;
}

function gyroSpectrumFor(log: BlackboxLog, axis: 'roll' | 'pitch') {
  const gyro = log.gyro[axis];
  if (!gyro || gyro.length < 8) {
    return { freqHz: new Float64Array(0), magnitudeDb: new Float64Array(0) };
  }
  const win = hannWindow(gyro.length);
  const windowed = new Float64Array(gyro.length);
  for (let i = 0; i < gyro.length; i++) windowed[i] = gyro[i] * win[i];
  const paddedSize = nextPow2(gyro.length);
  const mag = magnitude(realFftHalf(windowed, paddedSize));
  const freqHz = rfftFreq(paddedSize, 1 / log.sampleRateHz);
  const magnitudeDb = new Float64Array(mag.length);
  for (let i = 0; i < mag.length; i++) magnitudeDb[i] = 20 * Math.log10(mag[i] + 1e-12);
  return { freqHz, magnitudeDb };
}

export function useTunerController() {
  const [screen, setScreen] = useState<ScreenName>('waiting');

  // Screen 1 -- waiting/detected/connecting
  const [fcAttached, setFcAttached] = useState(false);
  const [deviceLabel, setDeviceLabel] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Session state, live across screens 2-6
  const transportRef = useRef<SerialTransport | null>(null);
  const decodedLogRef = useRef<BlackboxLog | null>(null);
  const craftIdRef = useRef<string>('unnamed');
  const pendingAppliedChangesRef = useRef<AppliedChange[]>([]);

  const [fcSummary, setFcSummary] = useState<FcSummary>({
    craftName: null,
    versionRaw: null,
    boardTarget: null,
    pidProfile: null,
    blackboxStorage: null,
    blackboxUsedBytes: null,
    priorFlightCount: 0,
  });
  const [currentTune, setCurrentTune] = useState<CurrentTuneSetup>({
    roll: emptyAxisPids(),
    pitch: emptyAxisPids(),
    yaw: emptyAxisPids(),
    filters: { dtermLpf1Hz: null, dtermLpf2Hz: null, gyroLpf1Hz: null, gyroLpf2Hz: null },
  });
  const [processing, setProcessing] = useState<ProcessingState>(EMPTY_PROCESSING);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [apply, setApply] = useState<ApplyState>(EMPTY_APPLY);

  // --- Screen 1: passive FC-presence polling -----------------------------
  useEffect(() => {
    if (screen !== 'waiting') return;
    const poll = () => {
      const device = detectFcDevice();
      setFcAttached(device !== null);
      setDeviceLabel(device ? device.deviceName : null);
    };
    poll();
    const id = setInterval(poll, FC_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [screen]);

  const resetToWaiting = useCallback(async (reason?: string) => {
    const t = transportRef.current;
    transportRef.current = null;
    if (t) {
      try {
        await t.close();
      } catch {
        // best-effort -- the FC may already be gone
      }
    }
    decodedLogRef.current = null;
    setFcSummary({
      craftName: null,
      versionRaw: null,
      boardTarget: null,
      pidProfile: null,
      blackboxStorage: null,
      blackboxUsedBytes: null,
      priorFlightCount: 0,
    });
    setCurrentTune({
      roll: emptyAxisPids(),
      pitch: emptyAxisPids(),
      yaw: emptyAxisPids(),
      filters: { dtermLpf1Hz: null, dtermLpf2Hz: null, gyroLpf1Hz: null, gyroLpf2Hz: null },
    });
    setProcessing(EMPTY_PROCESSING);
    setAnalysisResult(null);
    setApply(EMPTY_APPLY);
    setConnectError(reason ?? null);
    setScreen('waiting');
  }, []);

  // --- Disconnect watchdog -------------------------------------------------
  // Detects a genuine physical unplug from wherever the user currently is
  // and returns to the waiting screen -- not just from Screen 1. Checks the
  // SPECIFIC device we're connected to (by deviceId), not merely "is some
  // FC-like device present": if this FC is pulled and a different one is
  // plugged in before the next poll, that's still a disconnect from this
  // craft's perspective (it must not silently keep showing craft A's data
  // once craft B is what's actually attached -- see the craft-identity
  // work this depends on).
  //
  // Deliberately does NOT run on:
  //  - 'waiting': has its own presence poll driving the CONNECT button, and
  //    onConnect()'s own internal exitCli-then-reopen dance (a real,
  //    expected transient disconnect) happens while still on this screen.
  //  - 'applying': has its own dedicated save -> reboot -> reconnect
  //    handling, complete with its own timeout and error UI -- a second,
  //    independent watchdog racing against that would only cause confusion,
  //    not help.
  //  - FcInfoScreen while a download/decode/analyze is actively running: a
  //    real mid-transfer I/O failure already surfaces as a specific,
  //    actionable error card via runDownloadDecodeAnalyze's own try/catch;
  //    let that own its failure story instead of racing a generic watchdog
  //    against it.
  useEffect(() => {
    if (screen === 'waiting' || screen === 'applying') return;
    const activelyTransferring =
      screen === 'fcInfo' && processing.message !== '' && processing.phase !== 'error';
    if (activelyTransferring) return;

    const watchedDeviceId = transportRef.current?.deviceId;
    if (watchedDeviceId == null) return;

    const REQUIRED_MISSED_POLLS = 2;
    let missedPolls = 0;
    const id = setInterval(() => {
      const stillPresent = UsbSerial.listDevices().some((d) => d.deviceId === watchedDeviceId);
      if (stillPresent) {
        missedPolls = 0;
        return;
      }
      missedPolls += 1;
      if (missedPolls >= REQUIRED_MISSED_POLLS) {
        clearInterval(id);
        void resetToWaiting('The flight controller was disconnected.');
      }
    }, 1200);
    return () => clearInterval(id);
  }, [screen, processing.phase, processing.message, resetToWaiting]);

  // --- Screen 1 -> 2: CONNECT ----------------------------------------------
  const onConnect = useCallback(async () => {
    const device = detectFcDevice();
    if (!device) return;
    setConnecting(true);
    setConnectError(null);
    try {
      const transport = new SerialTransport(device.deviceId, 115200);
      await transport.open();
      transportRef.current = transport;

      // Read the hardware UID while still in normal MSP mode (before
      // entering CLI) -- this is the authoritative craft-identity key, see
      // readFcUid's doc. Best-effort: falls back to a name-based slug below
      // if it fails, rather than blocking the connect on it.
      const fcUid = await readFcUid(transport);

      const client = new BetaflightCliClient(transport);
      await client.enterCli();
      try {
        const versionBanner = await client.runCommand('version');
        const craftName = await getCraftName(client);
        const blackboxStorage = await getBlackboxStorageType(client);
        const pidProfile = await getPidProfileIndex(client);
        const values = await readNumericParams(client, TUNE_PARAMS);

        craftIdRef.current = fcUid ? `fc-${fcUid}` : craftIdFromName(craftName);
        const priorFlightCount = (await loadIterations(craftIdRef.current)).length;
        setFcSummary({
          craftName,
          versionRaw: shortVersionFromBanner(versionBanner),
          boardTarget: boardTargetFromVersionBanner(versionBanner),
          pidProfile,
          blackboxStorage,
          blackboxUsedBytes: null,
          priorFlightCount,
        });
        setCurrentTune(buildCurrentTuneSetup(values));
      } finally {
        await client.exitCli();
      }

      // exitCli() likely just dropped/reset the FC's USB connection (see
      // reopenFcTransport's doc) -- reopen fresh now, while we're already
      // in a loading state, so Screen 2's download step gets a known-good
      // transport instead of failing on a stale one.
      const fresh = await reopenFcTransport(transport);
      if (!fresh) {
        throw new Error('Flight controller did not reconnect after reading its settings. Reconnect the USB cable and try again.');
      }
      transportRef.current = fresh;

      setScreen('fcInfo');
    } catch (e) {
      setConnectError((e as Error).message);
      const t = transportRef.current;
      transportRef.current = null;
      if (t) await t.close().catch(() => {});
    } finally {
      setConnecting(false);
    }
  }, []);

  // --- Screen 2: DOWNLOAD BLACKBOX -> decode -> analyze -------------------
  const runDownloadDecodeAnalyze = useCallback(async () => {
    const transport = transportRef.current;
    if (!transport) return;

    setProcessing({ ...EMPTY_PROCESSING, phase: 'downloading', message: 'Downloading Blackbox log…' });
    try {
      const data = await readBlackboxFromFc(transport, (done, total) => {
        setProcessing((prev) => ({ ...prev, downloadedBytes: done, totalBytes: total }));
      });
      setFcSummary((prev) => ({ ...prev, blackboxUsedBytes: data.length }));

      setProcessing((prev) => ({ ...prev, phase: 'decoding', message: 'Decoding Blackbox log…' }));
      const segments = decodeBlackboxLog(data);
      if (segments.length === 0) {
        throw new Error('No flight data found in the downloaded Blackbox log.');
      }
      const segment = segments.reduce((a, b) => (b.frameCount > a.frameCount ? b : a));
      const log = buildBlackboxLog(segment);
      decodedLogRef.current = log;

      setProcessing((prev) => ({ ...prev, phase: 'analyzing', message: 'Calculating step response…' }));
      const byAxis: AnalysisResult['byAxis'] = {};
      for (const axis of ['roll', 'pitch'] as const) {
        byAxis[axis] = {
          stepResponse: computeStepResponse(log, axis),
          dtermNoise: computeDtermNoiseMetrics(log, axis),
          tracking: computeTrackingErrorStats(log, axis),
          gyroSpectrum: gyroSpectrumFor(log, axis),
        };
      }
      setProcessing((prev) => ({ ...prev, message: 'Scoring current tune…' }));
      const summary = buildAnalysisSummary(log);

      const stepByAxis = { roll: byAxis.roll?.stepResponse, pitch: byAxis.pitch?.stepResponse };
      const dtermByAxis = { roll: byAxis.roll?.dtermNoise, pitch: byAxis.pitch?.dtermNoise };
      const trackingByAxis = { roll: byAxis.roll?.tracking, pitch: byAxis.pitch?.tracking };
      const currentPidValues: CurrentPidValues = {
        p_roll: currentTune.roll.p ?? NaN,
        d_roll: currentTune.roll.d ?? NaN,
        p_pitch: currentTune.pitch.p ?? NaN,
        d_pitch: currentTune.pitch.d ?? NaN,
      };
      const havePids = currentTune.roll.p !== null && currentTune.pitch.p !== null;
      const recommendations = generateRecommendations(
        stepByAxis,
        dtermByAxis,
        trackingByAxis,
        havePids ? currentPidValues : null
      );
      const readiness = computeReadiness(recommendations, true, havePids);

      const previous = await getLatestIteration(craftIdRef.current);
      const previousSummary = previous?.analysisSummary ?? null;
      const comparison = previousSummary ? compareIterations(previousSummary, summary) : null;

      await saveIteration(
        craftIdRef.current,
        previous ? `Flight ${previous.number + 1}` : 'Flight 1',
        pendingAppliedChangesRef.current,
        summary
      );
      pendingAppliedChangesRef.current = [];

      setAnalysisResult({ summary, byAxis, recommendations, readiness, comparison, previousSummary });
      setProcessing((prev) => ({ ...prev, phase: 'done', message: 'Analysis complete.' }));
      setScreen('analysis');
    } catch (e) {
      setProcessing((prev) => ({ ...prev, phase: 'error', error: (e as Error).message }));
    }
  }, [currentTune]);

  const onRetryProcessing = useCallback(() => {
    void runDownloadDecodeAnalyze();
  }, [runDownloadDecodeAnalyze]);

  // --- Screen 3: EXIT / GET RECOMMENDATION / FINISH -----------------------
  const onExit = useCallback(() => {
    void resetToWaiting();
  }, [resetToWaiting]);

  const onGetRecommendation = useCallback(() => {
    setScreen('recommendation');
  }, []);

  // --- Screen 4: CANCEL / APPLY -------------------------------------------
  const onCancelRecommendation = useCallback(() => {
    setScreen('analysis');
  }, []);

  const reconnectAfterSave = useCallback(async (): Promise<BetaflightCliClient | null> => {
    try {
      // Short wait here -- applyTuningChanges already polls this function
      // every reconnectPollIntervalS on a null return, so the outer loop
      // supplies the patience; this just avoids hammering detectFcDevice()
      // in the same instant as the previous attempt.
      const transport = await reopenFcTransport(transportRef.current, 300);
      if (!transport) return null;
      transportRef.current = transport;
      const client = new BetaflightCliClient(transport);
      await client.enterCli();
      return client;
    } catch {
      return null;
    }
  }, []);

  const onApplyConfirmed = useCallback(async () => {
    const transport = transportRef.current;
    const result = analysisResult;
    if (!transport || !result) return;

    setScreen('applying');
    const job = createJob(applyJobStepNames());
    setApply({ phase: 'running', steps: job.toSnapshot().steps, percent: 0, result: null, error: null });

    const progressTimer = setInterval(() => {
      const snap = job.toSnapshot();
      setApply((prev) => ({ ...prev, steps: snap.steps, percent: snap.percent }));
    }, 250);

    try {
      const client = new BetaflightCliClient(transport);
      await client.enterCli();
      // Filter-category recommendations (e.g. "lower dterm_lpf1_static_hz by
      // ~10%") deliberately carry no concrete proposedValue -- see engine.ts's
      // module doc -- so they're advisory-only and must never reach
      // applyTuningChanges, which treats a null proposedValue as an always-
      // mismatching write (apply.ts's own documented safety behavior).
      // Sending them here would write literally "set X = null" to the FC and
      // then correctly abort at verification, exactly as this project's
      // testing caught. De-dupe by parameter name too, since two axes can
      // recommend the same underlying (non-per-axis) FC parameter.
      const seenParams = new Set<string>();
      const applicable = applicableRecommendations(result.recommendations, seenParams);

      if (applicable.length === 0) {
        clearInterval(progressTimer);
        setApply({
          phase: 'error',
          steps: job.toSnapshot().steps,
          percent: 0,
          result: null,
          error: 'These recommendations are advisory-only (e.g. filter cutoff guidance) and have no concrete value to write automatically.',
        });
        return;
      }

      const applyResult = await applyTuningChanges(
        client,
        applicable,
        job,
        reconnectAfterSave,
        RECONNECT_TIMEOUT_S,
        RECONNECT_POLL_INTERVAL_S
      );

      pendingAppliedChangesRef.current = applicable
        .filter((r) => applyResult.applied.includes(r.parameter))
        .map((r) => ({ parameter: r.parameter, from: r.currentValue, to: r.proposedValue }));

      const snap = job.toSnapshot();
      if (applyResult.aborted) {
        setApply({
          phase: 'error',
          steps: snap.steps,
          percent: snap.percent,
          result: applyResult,
          error: applyResult.abortReason,
        });
      } else {
        setApply({ phase: 'done', steps: snap.steps, percent: 100, result: applyResult, error: null });
        setScreen('applied');
      }
    } catch (e) {
      const snap = job.toSnapshot();
      setApply({ phase: 'error', steps: snap.steps, percent: snap.percent, result: null, error: (e as Error).message });
    } finally {
      clearInterval(progressTimer);
    }
  }, [analysisResult, reconnectAfterSave]);

  // --- Screen 6: DONE ------------------------------------------------------
  const onDone = useCallback(() => {
    void resetToWaiting();
  }, [resetToWaiting]);

  return {
    screen,
    waitingProps: {
      fcAttached,
      deviceLabel,
      connecting,
      connectError,
      onConnect: () => void onConnect(),
    },
    fcInfoProps: {
      fcSummary,
      processing,
      onDownload: () => void runDownloadDecodeAnalyze(),
      onRetry: onRetryProcessing,
      onDisconnect: onExit,
    },
    analysisProps: analysisResult && {
      fcSummary,
      currentTune,
      result: analysisResult,
      onExit,
      onGetRecommendation,
      onFinish: onExit,
    },
    recommendationProps: analysisResult && {
      recommendations: analysisResult.recommendations,
      confidencePct: analysisResult.readiness.confidencePct,
      currentTune,
      onCancel: onCancelRecommendation,
      onApply: () => void onApplyConfirmed(),
    },
    applyingProps: {
      apply,
      onDone,
      onRetryReconnect: () => void onApplyConfirmed(),
    },
    appliedProps: {
      apply,
      onDone,
    },
  };
}
