import { quoteDraft, type PageState, type PaneSelector } from "./observe.js";
import { snapshotScript } from "./snapshot.js";

export interface Observation {
  page: PageState;
  /** The expectation's own in-page probe result (JSON value), or null without a probe. */
  probe: unknown;
}

export type Judgement = "met" | "pending" | { contradicted: string };

export interface Expectation {
  label: string;
  /** In-page expression; its JSON value becomes `observed.probe`. */
  probe?: string;
  /** A missing pane makes the read unusable (target gone) instead of a plain observation. */
  usesPane?: boolean;
  /** Default true: holding before the action is a contradiction, so success means a real change. */
  requireChange?: boolean;
  judge(observed: Observation, baseline: Observation): Judgement;
  describeTimeout?(observed: Observation, baseline: Observation): string;
}

export interface ExpectationOptions {
  requireChange?: boolean;
}

const WORKING = "Working";
const FAILED = "Error";

/** Composer emptied and the pane started work; a menu, queueing or already-working is a failure. */
export function promptStarted(): Expectation {
  return {
    label: "prompt left the composer and the pane shows Working",
    usesPane: true,
    judge(observed, baseline) {
      if (baseline.page.status === WORKING) {
        return { contradicted: "the pane was already Working, so the prompt would only queue" };
      }
      if (baseline.page.composerDisabled === true) {
        return { contradicted: "the composer is disabled" };
      }
      if (observed.page.menuOpen) {
        return {
          contradicted: `a menu is open (draft ${quoteDraft(observed.page.draft)}), so Enter goes to the menu`,
        };
      }
      if (observed.page.queued > baseline.page.queued) {
        return { contradicted: "the prompt was queued instead of starting" };
      }
      if (
        observed.page.draft === "" &&
        observed.page.status === FAILED &&
        baseline.page.status !== FAILED
      ) {
        // A run that fails at once can skip Working between two reads.
        return {
          contradicted: "the prompt left the composer but the run failed (pane shows Error)",
        };
      }
      return observed.page.draft === "" && observed.page.status === WORKING ? "met" : "pending";
    },
    describeTimeout(observed, baseline) {
      const { draft, status } = observed.page;
      if (draft === baseline.page.draft) {
        return `draft is unchanged (${quoteDraft(draft)}); the prompt was not sent`;
      }
      if (draft !== "") return `draft changed to ${quoteDraft(draft)} but was not sent`;
      return `composer cleared but the pane status is ${status ?? "missing"}, not ${WORKING}`;
    },
  };
}

/** The composer holds exactly `text`; a different starting draft is a contradiction. */
export function typedIntoEmptyComposer(text: string): Expectation {
  return {
    label: `composer draft is ${quoteDraft(text)}`,
    usesPane: true,
    judge(observed, baseline) {
      if (baseline.page.draft !== "") {
        return {
          contradicted: `the composer already had a draft (${quoteDraft(baseline.page.draft)})`,
        };
      }
      return observed.page.draft === text ? "met" : "pending";
    },
  };
}

export function draftEquals(text: string, options: ExpectationOptions = {}): Expectation {
  return {
    label: `composer draft is ${quoteDraft(text)}`,
    usesPane: true,
    ...options,
    judge: (observed) => (observed.page.draft === text ? "met" : "pending"),
  };
}

export function condition(
  label: string,
  expression: string,
  options: ExpectationOptions = {},
): Expectation {
  return {
    label,
    probe: `Boolean(${expression})`,
    ...options,
    judge: (observed) => (observed.probe === true ? "met" : "pending"),
  };
}

export function elementAppears(selector: string, options: ExpectationOptions = {}): Expectation {
  return condition(
    `${selector} appears`,
    `document.querySelector(${JSON.stringify(selector)})`,
    options,
  );
}

export function elementGone(selector: string, options: ExpectationOptions = {}): Expectation {
  return condition(
    `${selector} is gone`,
    `!document.querySelector(${JSON.stringify(selector)})`,
    options,
  );
}

export function textAppears(text: string, options: ExpectationOptions = {}): Expectation {
  return condition(
    `text ${JSON.stringify(text)} appears`,
    `(document.body?.innerText ?? '').includes(${JSON.stringify(text)})`,
    options,
  );
}

export function textGone(text: string, options: ExpectationOptions = {}): Expectation {
  return condition(
    `text ${JSON.stringify(text)} is gone`,
    `!(document.body?.innerText ?? '').includes(${JSON.stringify(text)})`,
    options,
  );
}

export function focusOn(selector: string, options: ExpectationOptions = {}): Expectation {
  return condition(
    `focus is on ${selector}`,
    `document.activeElement?.matches(${JSON.stringify(selector)})`,
    options,
  );
}

function pageDigest(observed: Observation): string {
  const probe = observed.probe;
  // The registry generation moves on every registering snapshot, which is not a page change.
  const elements =
    typeof probe === "object" && probe !== null && "elements" in probe ? probe.elements : probe;
  return JSON.stringify([observed.page, elements]);
}

/** Something visible changed: the pane state or the list of interactive elements and their state. */
export function pageChanged(pane: PaneSelector = null): Expectation {
  return {
    label: "the page changed",
    probe: snapshotScript({ pane, register: false }),
    judge: (observed, baseline) =>
      pageDigest(observed) !== pageDigest(baseline) ? "met" : "pending",
  };
}
