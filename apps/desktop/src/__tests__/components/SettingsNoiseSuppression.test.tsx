import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * A noise-suppression failure never changes the saved preference (#91): the
 * switch keeps showing what the user chose, and a note under it says that it
 * is not active in this app session.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

import { SettingsModal } from '../../components/settings/SettingsModal';
import { useSettingsStore } from '../../stores/settingsStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useSettingsStore.setState({ isSettingsOpen: true, initialSettingsTab: 'audio', enableNoiseSuppression: true, noiseSuppressionUnavailable: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useSettingsStore.setState({ isSettingsOpen: false, initialSettingsTab: null, noiseSuppressionUnavailable: false });
});

const note = () => document.body.querySelector('[data-testid="noise-suppression-unavailable"]');
const nsSwitch = () => [...document.body.querySelectorAll('[role="switch"]')]
  .find((s) => s.closest('.mb-5')?.textContent?.includes('settings.audio.noiseSuppression'))!;

function render() {
  act(() => { root.render(<SettingsModal />); });
}

describe('the noise-suppression setting after a failure this session', () => {
  it('normally: the switch reads on, no note', () => {
    render();
    expect(nsSwitch().getAttribute('aria-checked')).toBe('true');
    expect(note()).toBeNull();
  });

  it('unavailable this session: the switch still reads the saved preference (on), the note says it is not active', () => {
    useSettingsStore.setState({ noiseSuppressionUnavailable: true });
    render();
    expect(nsSwitch().getAttribute('aria-checked')).toBe('true');
    expect(note()?.textContent).toBe('voice.toasts.noiseSuppressionUnavailable');
    expect(nsSwitch().getAttribute('aria-describedby')).toBe(note()!.id);
  });

  it('turned off by the user: no note (there is nothing to be unavailable)', () => {
    useSettingsStore.setState({ noiseSuppressionUnavailable: true, enableNoiseSuppression: false });
    render();
    expect(nsSwitch().getAttribute('aria-checked')).toBe('false');
    expect(note()).toBeNull();
  });

  it('the flag is never saved with the settings', () => {
    useSettingsStore.setState({ noiseSuppressionUnavailable: true });
    useSettingsStore.getState().setEnableNoiseSuppression(true);
    const saved = JSON.parse(localStorage.getItem('voxium_settings') ?? '{}');
    expect(saved.enableNoiseSuppression).toBe(true);
    expect('noiseSuppressionUnavailable' in saved).toBe(false);
  });
});
