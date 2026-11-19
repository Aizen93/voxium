/**
 * The noise-gate threshold a user hears unless they moved the slider: the
 * settings store's default for a fresh install and for a stored entry that
 * lost the value, and the analyser's starting value before the store has been
 * applied. One constant, so the three can never part again. No imports: both
 * the store and the analyser load it.
 */
export const DEFAULT_NOISE_GATE_THRESHOLD = 0.008;
