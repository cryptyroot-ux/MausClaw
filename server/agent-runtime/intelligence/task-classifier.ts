// Task classifier: heuristically scores an incoming brief as coding/research/analysis/writing/debugging/general.
// Additive port of MausClaw-Pivot's server/intelligence/task-classifier.ts.
// MausClaw already has a separate task-classifier.ts (complexity levels); this is additive and lives under intelligence/.

export type TaskType =
  | "coding"
  | "research"
  | "analysis"
  | "writing"
  | "debugging"
  | "general";

type Category = Exclude<TaskType, "general">;

const PATTERNS: Record<Category, ReadonlyArray<readonly [RegExp, number]>> = {
  coding: [
    [/\bimplement(?:s|ed|ing)?\b/g, 2],
    [/\bcode(?:s|d)?\b/g, 2],
    [/\bapi\b/g, 2],
    [/\bendpoint(?:s)?\b/g, 2],
    [/\bfunction(?:s)?\b/g, 2],
    [/\brest\b/g, 1],
    [/\bbinary search\b/g, 3],
    [/\bpython\b/g, 2],
    [/\btypescript\b/g, 2],
    [/\bjavascript\b/g, 2],
    [/\bjava\b/g, 1],
    [/\bcomponent(?:s)?\b/g, 1],
    [/\bclass(?:es)?\b/g, 1],
    [/\bmodule(?:s)?\b/g, 1],
    [/\brefactor(?:s|ed|ing)?\b/g, 2],
    [/\balgorithm(?:s)?\b/g, 2],
    [/\bdatabase\b/g, 1],
    [/\bschema(?:s)?\b/g, 1],
    [/\bmigration(?:s)?\b/g, 1],
    [/\bbuild\b/g, 1],
    [/\bcreate\b/g, 1],
    [/\bdevelop(?:s|ed|ing)?\b/g, 2],
    [/\bprogram(?:s|med|ming)?\b/g, 1],
    [/\bwrite a\b/g, 1],
  ],
  research: [
    [/\bresearch(?:es|ed|ing)?\b/g, 3],
    [/\bfind out\b/g, 3],
    [/\bcompetitors?\b/g, 3],
    [/\bpricing\b/g, 2],
    [/\bbest practices?\b/g, 3],
    [/\binvestigate(?:s|d)?\b/g, 2],
    [/\bsurvey(?:s|ed|ing)?\b/g, 2],
    [/\bexplore(?:s|d)?\b/g, 1],
    [/\bcompare(?:s|d)?\b/g, 1],
    [/\bmarket\b/g, 1],
    [/\bliterature\b/g, 2],
  ],
  debugging: [
    [/\bdebug(?:s|ged|ging)?\b/g, 3],
    [/\bfix(?:es|ed|ing)?\b/g, 3],
    [/\bbugs?\b/g, 3],
    [/\bexceptions?\b/g, 3],
    [/\bnull pointer\b/g, 3],
    [/\bfailing\b/g, 2],
    [/\berrors?\b/g, 2],
    [/\bcrash(?:es|ed|ing)?\b/g, 2],
    [/\btraceback\b/g, 3],
    [/\bstack trace\b/g, 3],
    [/\bci\b/g, 1],
    [/\btests? failing\b/g, 3],
    [/\broot cause\b/g, 3],
    [/\bissues?\b/g, 1],
  ],
  analysis: [
    [/\banalyze(?:s|d)?\b/g, 3],
    [/\banalysis\b/g, 3],
    [/\breview(?:s|ed|ing)?\b/g, 3],
    [/\bperformance\b/g, 2],
    [/\bbottleneck(?:s)?\b/g, 3],
    [/\bsecurity\b/g, 2],
    [/\baudit(?:s|ed|ing)?\b/g, 2],
    [/\binspect(?:s|ed|ing)?\b/g, 2],
    [/\bevaluate(?:s|d)?\b/g, 2],
    [/\bassess(?:es|ed|ing)?\b/g, 2],
    [/\boptimize(?:s|d)?\b/g, 2],
    [/\bprofile(?:s|d)?\b/g, 1],
    [/\bmetrics?\b/g, 1],
  ],
  writing: [
    [/\bdocumentation\b/g, 3],
    [/\bdocs\b/g, 2],
    [/\bdraft(?:s|ed|ing)?\b/g, 3],
    [/\bblogs?\b/g, 3],
    [/\bposts?\b/g, 2],
    [/\barticles?\b/g, 2],
    [/\bessays?\b/g, 2],
    [/\breadme\b/g, 3],
    [/\bcopy\b/g, 1],
    [/\bcontent\b/g, 1],
    [/\bwrite documentation\b/g, 3],
    [/\bwrite doc\b/g, 3],
  ],
};

export function classifyTask(brief: string): TaskType {
  const text = brief.toLowerCase();
  const scores: Record<Category, number> = {
    coding: 0,
    research: 0,
    analysis: 0,
    writing: 0,
    debugging: 0,
  };

  for (const category of Object.keys(PATTERNS) as Category[]) {
    for (const [pattern, weight] of PATTERNS[category]) {
      const matches = text.match(pattern);
      if (matches) {
        scores[category] += weight * matches.length;
      }
    }
  }

  let best: Category | null = null;
  let bestScore = 0;
  let tie = false;
  for (const category of Object.keys(scores) as Category[]) {
    const score = scores[category];
    if (score > bestScore) {
      bestScore = score;
      best = category;
      tie = false;
    } else if (score === bestScore && score > 0) {
      tie = true;
    }
  }

  if (bestScore === 0 || tie || best === null) {
    return "general";
  }
  return best;
}
