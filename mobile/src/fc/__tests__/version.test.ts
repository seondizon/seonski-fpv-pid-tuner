import { parseBetaflightVersion, parseVersionFromCliBanner } from '../version';

test('parses semver-style version', () => {
  const v = parseBetaflightVersion('4.5.0');
  expect(v.scheme).toBe('semver');
  expect(v.major).toBe(4);
  expect(v.minor).toBe(5);
  expect(v.patch).toBe(0);
  expect(v.raw).toBe('4.5.0');
});

test('parses calver-style version', () => {
  const v = parseBetaflightVersion('2025.12.0');
  expect(v.scheme).toBe('calver');
  expect(v.major).toBe(2025);
  expect(v.minor).toBe(12);
  expect(v.patch).toBe(0);
});

test('invalid version string throws', () => {
  expect(() => parseBetaflightVersion('not-a-version')).toThrow();
  expect(() => parseBetaflightVersion('4.5')).toThrow();
});

test('supportsFeature: semver gate', () => {
  const v43 = parseBetaflightVersion('4.3.0');
  const v44 = parseBetaflightVersion('4.4.0');
  expect(v43.supportsFeature('pid_profile_count_4')).toBe(false);
  expect(v44.supportsFeature('pid_profile_count_4')).toBe(true);
});

test('supportsFeature: save_noreboot calver gate', () => {
  const v43 = parseBetaflightVersion('4.3.0');
  const vCalver = parseBetaflightVersion('2025.12.0');
  const vCalverOlderMonth = parseBetaflightVersion('2025.6.0');

  expect(v43.supportsFeature('save_noreboot')).toBe(false);
  expect(vCalver.supportsFeature('save_noreboot')).toBe(true);
  expect(vCalverOlderMonth.supportsFeature('save_noreboot')).toBe(false);
});

test('supportsFeature: cross-scheme assumptions', () => {
  const v45 = parseBetaflightVersion('4.5.0');
  expect(v45.supportsFeature('save_noreboot')).toBe(false);

  const vCalver = parseBetaflightVersion('2025.12.0');
  expect(vCalver.supportsFeature('resource_syntax_v2')).toBe(true);
});

test('parses version from semver CLI banner', () => {
  const banner = '# Betaflight / STM32F7X2 4.5.0 Jan  1 2024 / 12:00:00 (abcdef1234) MSP API: 1.45';
  const version = parseVersionFromCliBanner(banner);
  expect(version).not.toBeNull();
  expect(version!.scheme).toBe('semver');
  expect([version!.major, version!.minor, version!.patch]).toEqual([4, 5, 0]);
});

test('parses version from calver CLI banner', () => {
  const banner = '# Betaflight / STM32F405 2025.12.0 Dec 10 2025 / 09:00:00 (0123456789abcd) MSP API: 1.47';
  const version = parseVersionFromCliBanner(banner);
  expect(version).not.toBeNull();
  expect(version!.scheme).toBe('calver');
  expect([version!.major, version!.minor, version!.patch]).toEqual([2025, 12, 0]);
});

test('garbage CLI banner returns null', () => {
  expect(parseVersionFromCliBanner('not a version banner at all')).toBeNull();
  expect(parseVersionFromCliBanner('')).toBeNull();
});
