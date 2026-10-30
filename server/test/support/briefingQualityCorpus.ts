/**
 * A fixed synthetic corpus for judging briefing quality with a real model.
 * Every item is invented (no real outlet, vendor or person), so the corpus
 * can be shared with a reviewer and re-run unchanged. Each case states what a
 * good briefing does with it; the harness
 * (`informationBriefingQualityHarnessDb.test.ts`) builds the real request from
 * it and, when an authorized model reply is supplied, checks it mechanically
 * and leaves the judgment to a person on the rubric below. A fixture reply is
 * never evidence of quality.
 */
export interface QualityItem {
  key: string;
  title: string;
  uri: string;
  summary: string;
  /** Hours before the request the item was published and collected. */
  hoursAgo: number;
}

export interface QualityCase {
  id: string;
  /** What a good briefing does with these items. */
  expectation: string;
  items: QualityItem[];
}

export const QUALITY_CASES: QualityCase[] = [
  {
    id: "same_event_two_urls",
    expectation: "One highlight for the launch, citing both outlets; not two highlights; source_domains = 2.",
    items: [
      { key: "launch_a", title: "Fictional Grippa Labs launches the SoftHand 2 gripper", uri: "https://outlet-alpha.example/softhand-2-launch", summary: "Grippa Labs released SoftHand 2, a soft gripper rated for 2 kg payloads, shipping in May.", hoursAgo: 30 },
      { key: "launch_b", title: "SoftHand 2: Grippa's new soft gripper ships in May", uri: "https://outlet-beta.example/news/grippa-softhand2", summary: "Grippa Labs' SoftHand 2 handles fragile items up to 2 kg and ships in May, the company said.", hoursAgo: 28 },
    ],
  },
  {
    id: "contradiction",
    expectation: "One highlight that states both claims and names the conflict in `contradictions`; no fact asserting either side.",
    items: [
      { key: "delay", title: "Fictional ActuaCorp delays actuator shipments to Q4", uri: "https://outlet-gamma.example/actuacorp-delay", summary: "Two unnamed sources say ActuaCorp will ship its linear actuators in Q4, not Q2.", hoursAgo: 20 },
      { key: "on_time", title: "ActuaCorp: actuator shipments remain on schedule", uri: "https://outlet-delta.example/actuacorp-statement", summary: "ActuaCorp's spokesperson says Q2 shipments of its linear actuators are on schedule.", hoursAgo: 18 },
    ],
  },
  {
    id: "irrelevant",
    expectation: "Not a highlight: nothing to do with the Project's goal or constraints.",
    items: [
      { key: "unrelated", title: "Fictional chef opens a rooftop restaurant", uri: "https://outlet-epsilon.example/rooftop-restaurant", summary: "A chef opened a rooftop restaurant with a seasonal menu.", hoursAgo: 26 },
    ],
  },
  {
    id: "project_impact",
    expectation: "A highlight whose impact cites the Project goal (C1) — the Q3 deadline — and says how; `affects`, not `insufficient_context`.",
    items: [
      { key: "standard", title: "Fictional safety standard for warehouse robots takes effect in Q3", uri: "https://outlet-zeta.example/warehouse-robot-standard", summary: "A new (fictional) safety standard requires certified force limits for warehouse picking robots from Q3.", hoursAgo: 22 },
    ],
  },
];

/** The delta case: after a published baseline on the launch, a repeat capture and a real update. */
export const QUALITY_DELTA: { expectation: string; repeat: QualityItem; update: QualityItem } = {
  expectation: "The repeat capture is not news (unchanged/merged); the price update is the one highlight, novelty `update` or `new`, citing the update.",
  repeat: { key: "launch_a_repeat", title: "Fictional Grippa Labs launches the SoftHand 2 gripper", uri: "https://outlet-alpha.example/softhand-2-launch", summary: "Grippa Labs released SoftHand 2, a soft gripper rated for 2 kg payloads, shipping in May.", hoursAgo: 0 },
  update: { key: "price", title: "Grippa Labs prices SoftHand 2 at a fictional 4,000 credits", uri: "https://outlet-eta.example/softhand-2-price", summary: "Grippa Labs set SoftHand 2's price at 4,000 credits and moved shipping to June.", hoursAgo: 0 },
};

/** The personal case: one reader's two Following topics, and a Project they opted into their Reading. */
export const QUALITY_PERSONAL: { expectation: string; shared: QualityItem; otherTopic: QualityItem; topics: [string, string] } = {
  expectation: "The shared item is one highlight drawing on both its lenses (a Following topic and the Project's Corpus); the battery item is a separate topic; impact cites the reader's own focus (C refs), never a Project goal as if it were theirs.",
  topics: ["Soft grippers", "Battery chemistry"],
  shared: { key: "personal_gripper", title: "Fictional Grippa Labs opens SoftHand 2 preorders", uri: "https://outlet-theta.example/softhand-2-preorders", summary: "Grippa Labs opened preorders for SoftHand 2, a soft gripper for fragile picking.", hoursAgo: 6 },
  otherTopic: { key: "personal_battery", title: "Fictional cell maker reports a solid-state battery milestone", uri: "https://outlet-iota.example/solid-state-milestone", summary: "A cell maker reports 500 cycles for a solid-state battery prototype.", hoursAgo: 5 },
};

/** What a person scores for each highlight of a real reply (the model's own words are not the score). */
export const QUALITY_RUBRIC = [
  "Grouping: items about one event are one highlight; different events are not merged (yes / partial / no)",
  "Support: every fact is stated by the item it cites (yes / partial / no, list the unsupported statement)",
  "Contradiction: conflicting reports are named as such, neither asserted as fact (yes / no / n.a.)",
  "Relevance: unrelated material is left out (yes / no)",
  "Impact: the impact names the Project or personal context it cites, and the reasoning holds (yes / partial / no)",
  "Novelty: baseline / new / update / ongoing matches what actually changed since the last briefing (yes / no)",
  "Cost: tokens and estimated cost from the Run's usage record (fill in; unknown if the runtime did not report)",
] as const;
