import { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { X } from 'lucide-react';

interface DeviceInfo {
  deviceId: string;
  label: string;
}

export function SettingsModal() {
  const {
    audioInputDeviceId,
    audioOutputDeviceId,
    noiseGateThreshold,
    closeSettings,
    setAudioInputDeviceId,
    setAudioOutputDeviceId,
    setNoiseGateThreshold,
  } = useSettingsStore();

  const [inputDevices, setInputDevices] = useState<DeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<DeviceInfo[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const stopMicPreview = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setMicLevel(0);
  }, []);

  const startMicPreview = useCallback(async (deviceId: string) => {
    stopMicPreview();

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone access not available (insecure context?)');
      return;
    }

    try {
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      micStreamRef.current = stream;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      const dataArray = new Float32Array(analyser.fftSize);

      function tick() {
        analyser.getFloatTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);
        setMicLevel(Math.min(rms / 0.15, 1));
        rafRef.current = requestAnimationFrame(tick);
      }
      rafRef.current = requestAnimationFrame(tick);
      setError(null);
    } catch (err) {
      console.warn('[Settings] Mic preview failed:', err);
      setError('Could not access microphone');
    }
  }, [stopMicPreview]);

  useEffect(() => {
    async function loadDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) {
        setError('Device enumeration not available');
        return;
      }

      try {
        // Request mic permission first so labels are populated
        if (navigator.mediaDevices.getUserMedia) {
          const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          tempStream.getTracks().forEach((t) => t.stop());
        }

        const devices = await navigator.mediaDevices.enumerateDevices();
        setInputDevices(
          devices
            .filter((d) => d.kind === 'audioinput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 8)}` }))
        );
        setOutputDevices(
          devices
            .filter((d) => d.kind === 'audiooutput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || `Speaker ${d.deviceId.slice(0, 8)}` }))
        );
      } catch (err) {
        console.warn('[Settings] enumerateDevices failed:', err);
        setError('Could not list audio devices');
      }
    }

    loadDevices();
  }, []);

  // Start mic preview when input device changes or on mount
  useEffect(() => {
    startMicPreview(audioInputDeviceId);
    return () => stopMicPreview();
  }, [audioInputDeviceId, startMicPreview, stopMicPreview]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in">
      <div className="absolute inset-0 bg-black/60" onClick={closeSettings} />
      <div className="relative w-full max-w-md rounded-xl border border-vox-border bg-vox-bg-floating p-6 shadow-2xl animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-vox-text-primary">Audio Settings</h2>
          <button
            onClick={closeSettings}
            className="rounded-md p-1 text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-vox-accent-danger/10 px-3 py-2 text-xs text-vox-accent-danger">
            {error}
          </div>
        )}

        {/* Input Device */}
        <div className="mb-5">
          <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
            Input Device
          </label>
          <select
            value={audioInputDeviceId}
            onChange={(e) => setAudioInputDeviceId(e.target.value)}
            className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-primary"
          >
            <option value="">System Default</option>
            {inputDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
            ))}
          </select>

          {/* Mic Level Meter */}
          <div className="mt-2 h-2 rounded-full bg-vox-bg-secondary overflow-hidden">
            <div
              className="h-full rounded-full bg-vox-voice-connected transition-all duration-75"
              style={{ width: `${Math.max(micLevel * 100, 0)}%` }}
            />
          </div>
          <p className="mt-1 text-[10px] text-vox-text-muted">Speak to test your microphone</p>
        </div>

        {/* Output Device */}
        <div className="mb-5">
          <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
            Output Device
          </label>
          <select
            value={audioOutputDeviceId}
            onChange={(e) => setAudioOutputDeviceId(e.target.value)}
            className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-primary"
          >
            <option value="">System Default</option>
            {outputDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
            ))}
          </select>
        </div>

        {/* Mic Sensitivity */}
        <div className="mb-2">
          <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
            Mic Sensitivity
          </label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min="0.005"
              max="0.1"
              step="0.005"
              value={noiseGateThreshold}
              onChange={(e) => setNoiseGateThreshold(parseFloat(e.target.value))}
              className="flex-1 accent-vox-accent-primary"
            />
            <span className="text-xs text-vox-text-secondary w-8 text-right">
              {Math.round(noiseGateThreshold * 1000)}
            </span>
          </div>
          <p className="mt-1 text-[10px] text-vox-text-muted">
            Lower = more sensitive (picks up quieter sounds)
          </p>
        </div>
      </div>
    </div>
  );
}
