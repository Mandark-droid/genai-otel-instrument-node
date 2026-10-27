/**
 * `GENAI_TOXICITY_ONNX_MODEL` (contract/SDK_ADDITIONS.md section 12): toxicity
 * scored in-process by a Detoxify-style ONNX classifier, through the optional
 * add-on `genai-otel-instrument-node-onnx`. This package never depends
 * on ONNX Runtime: the add-on is imported on the first score, only when the
 * variable is set. Node only.
 *
 * A local model file is not a download, so the judge is allowed when
 * air-gapped. An add-on that is not installed, or a model it cannot load, is
 * one warning, and toxicity is not measured - never scored 0.
 */
import { logger } from '../logger';
import { stateSlot } from '../state';
import type { ToxicityScorer, ToxicityScores } from './detectors';

export const ONNX_ADDON = 'genai-otel-instrument-node-onnx';

type AddonJudge = (text: string, categories: readonly string[]) => Promise<ToxicityScores>;
export interface OnnxAddon {
  createOnnxToxicityJudge(directory: string): Promise<AddonJudge>;
}
type Loader = () => Promise<OnnxAddon>;

const slot = (): { loader?: Loader } => stateSlot('evaluation.onnx-addon-loader', () => ({}));

/** Replace how the add-on is imported (tests). `undefined` restores the default. */
export function setOnnxAddonLoader(loader: Loader | undefined): void {
  slot().loader = loader;
}

const importAddon: Loader = () => import(/* webpackIgnore: true */ ONNX_ADDON) as Promise<OnnxAddon>;

/** A scorer running the model in `directory` through the add-on, loaded on its first use. */
export function onnxToxicityJudge(directory: string): ToxicityScorer {
  let judge: Promise<AddonJudge> | undefined;
  return async (text, categories) => {
    judge ??= (slot().loader ?? importAddon)()
      .then((addon) => addon.createOnnxToxicityJudge(directory))
      .catch((error: unknown) => {
        // Once: the rejected promise is kept, so every later score fails quietly.
        logger.warn(
          `GENAI_TOXICITY_ONNX_MODEL is set, but ${ONNX_ADDON} could not score with '${directory}' ` +
            `(install the add-on next to this package, and check the model directory): ${String(error)}. Toxicity is not measured.`,
        );
        throw error;
      });
    return (await judge)(text, categories);
  };
}
