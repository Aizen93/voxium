/**
 * The noise gate's AudioWorkletProcessor: a thin shell around NoiseGate
 * (noiseGate.ts) on the audio thread. audioAnalyser.ts loads this file with
 * `?worker&url`, the way it loads the noise-suppression worklet, so the build
 * emits it as a script file of the app's own origin.
 *
 * It takes the start state from `processorOptions`, a threshold, the pause
 * and a stop from its port, and posts each change of its decision, and
 * nothing else, to the page.
 *
 * Never import this file from page code: it registers the processor as it
 * loads, and `registerProcessor` exists only in an AudioWorkletGlobalScope.
 */
import { DEFAULT_NOISE_GATE_THRESHOLD } from './audioDefaults';
import { NoiseGate, NOISE_GATE_PROCESSOR_NAME, readNoiseGateCommand, readNoiseGateInit, type NoiseGateReport } from './noiseGate';

// The names of the AudioWorkletGlobalScope this file uses, declared here and
// not globally: the page's own code has none of them
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

class NoiseGateProcessor extends AudioWorkletProcessor {
  private readonly gate: NoiseGate;
  private stopped = false;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const init = readNoiseGateInit(options?.processorOptions);
    this.gate = new NoiseGate({
      sampleRate,
      threshold: init.threshold ?? DEFAULT_NOISE_GATE_THRESHOLD,
      paused: init.paused,
      open: init.open,
      pauseClosesGate: init.pauseClosesGate,
      onChange: (speaking) => {
        const report: NoiseGateReport = { type: 'speaking', speaking };
        this.port.postMessage(report);
      },
    });
    this.port.onmessage = (event: MessageEvent) => this.receive(event.data);
  }

  private receive(data: unknown): void {
    const command = readNoiseGateCommand(data);
    if (!command) return;
    if (command.type === 'threshold') this.gate.setThreshold(command.value);
    else if (command.type === 'paused') this.gate.setPaused(command.value);
    else this.stopped = true;
  }

  /** Returning false after a stop lets the browser let go of the node. */
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    this.gate.process(inputs[0] ?? [], outputs[0] ?? []);
    return true;
  }
}

registerProcessor(NOISE_GATE_PROCESSOR_NAME, NoiseGateProcessor);
