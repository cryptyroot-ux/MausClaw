// Read before main.tsx's first-paint writes: applySkin stamps mausclaw-skin on every boot.
const PRIOR_RUN_KEYS = ["mausclaw-skin", "mausclaw-installed", "mausclaw-email-gate", "mausclaw-drafts", "mausclaw-show-threads"];

export function hasPriorRun(store: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return PRIOR_RUN_KEYS.some((key) => store?.getItem(key) != null);
  } catch {
    return false;
  }
}
