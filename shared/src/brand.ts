/** Normalised brand shape used by the pipeline. Only the server's catalogue loader produces this. */
export interface Creative {
  id: string;
  durationSec: number;
  language: string;
  /** Absolute path on the server. */
  file: string;
}

export interface Brand {
  id: string;
  name: string;
  category: string;
  targetContexts: string[];
  negativeContexts: string[];
  creatives: Creative[];
}

export interface Catalogue {
  brands: Brand[];
  /** Union of every brand's negativeContexts, deduped. Built at runtime. */
  negativeVocab: string[];
  /** Hash of the normalised catalogue; cached stages that depend on it re-run when it changes. */
  hash: string;
}
