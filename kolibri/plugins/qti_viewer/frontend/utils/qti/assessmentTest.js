/**
 * Parse a QTI 3.0 assessment test into a plain tree, and resolve the item
 * order a learner sees in each test part.
 *
 * Structure: qti-assessment-test > qti-test-part > qti-assessment-section
 * (nestable) > qti-assessment-item-ref. Every test has at least one part
 * and every part at least one section.
 *   https://www.imsglobal.org/spec/qti/v3p0/info#Root_AssessmentTest
 *
 * Parsing and item resolution are pure: no DOM is kept in the tree, and all
 * randomness comes from the `random` function the caller passes in, so the
 * same seed always gives the same draw (across reloads and devices).
 * @module assessmentTest
 */

export const NAVIGATION_MODE = Object.freeze({
  LINEAR: 'linear',
  NONLINEAR: 'nonlinear',
});

export const SUBMISSION_MODE = Object.freeze({
  INDIVIDUAL: 'individual',
  SIMULTANEOUS: 'simultaneous',
});

const NODE_TYPE = Object.freeze({
  SECTION: 'section',
  ITEM: 'item',
});

/**
 * Item session control attributes and their parsers. Only attributes present
 * in the XML are recorded, so that nearer scopes override only what they set.
 */
const SESSION_CONTROL_ATTRIBUTES = {
  'max-attempts': ['maxAttempts', Number],
  'show-feedback': ['showFeedback', parseBoolean],
  'allow-review': ['allowReview', parseBoolean],
  'show-solution': ['showSolution', parseBoolean],
  'allow-comment': ['allowComment', parseBoolean],
  'allow-skipping': ['allowSkipping', parseBoolean],
  'validate-responses': ['validateResponses', parseBoolean],
};

/**
 * Spec defaults, applied beneath every explicitly set value.
 * `maxAttempts` is left unset here: its default depends on whether the item
 * is adaptive, which is only known once the item itself is loaded.
 */
const SESSION_CONTROL_DEFAULTS = Object.freeze({
  showFeedback: false,
  allowReview: true,
  showSolution: false,
  allowComment: false,
  allowSkipping: true,
  validateResponses: false,
});

function parseBoolean(value) {
  return value === 'true';
}

function booleanAttribute(element, name, fallback) {
  return element.hasAttribute(name) ? parseBoolean(element.getAttribute(name)) : fallback;
}

/**
 * Direct children of `element` with the given tag name.
 * @param {Element} element - The parent element
 * @param {string} tagName - Local tag name to match
 * @returns {Element[]} Matching children in document order
 */
function childElements(element, tagName) {
  return Array.from(element.children).filter(child => child.localName === tagName);
}

function parseSessionControl(element) {
  const control = childElements(element, 'qti-item-session-control')[0];
  if (!control) {
    return {};
  }
  const parsed = {};
  for (const [attribute, [key, parse]] of Object.entries(SESSION_CONTROL_ATTRIBUTES)) {
    if (control.hasAttribute(attribute)) {
      parsed[key] = parse(control.getAttribute(attribute));
    }
  }
  return parsed;
}

function parseSelection(sectionElement) {
  const selection = childElements(sectionElement, 'qti-selection')[0];
  if (!selection) {
    return null;
  }
  return {
    select: Number(selection.getAttribute('select')),
    withReplacement: booleanAttribute(selection, 'with-replacement', false),
  };
}

function parseOrdering(sectionElement) {
  const ordering = childElements(sectionElement, 'qti-ordering')[0];
  return ordering ? { shuffle: booleanAttribute(ordering, 'shuffle', false) } : null;
}

function parseItemRef(element) {
  const category = element.getAttribute('category');
  return {
    type: NODE_TYPE.ITEM,
    identifier: element.getAttribute('identifier'),
    href: element.getAttribute('href'),
    categories: category ? category.trim().split(/\s+/) : [],
    required: booleanAttribute(element, 'required', false),
    fixed: booleanAttribute(element, 'fixed', false),
    sessionControl: parseSessionControl(element),
  };
}

function parseSection(element) {
  const children = Array.from(element.children)
    .map(child => {
      if (child.localName === 'qti-assessment-section') {
        return parseSection(child);
      }
      if (child.localName === 'qti-assessment-item-ref') {
        return parseItemRef(child);
      }
      return null;
    })
    .filter(Boolean);
  return {
    type: NODE_TYPE.SECTION,
    identifier: element.getAttribute('identifier'),
    title: element.getAttribute('title') || '',
    visible: booleanAttribute(element, 'visible', true),
    required: booleanAttribute(element, 'required', false),
    fixed: booleanAttribute(element, 'fixed', false),
    keepTogether: booleanAttribute(element, 'keep-together', true),
    selection: parseSelection(element),
    ordering: parseOrdering(element),
    sessionControl: parseSessionControl(element),
    children,
  };
}

function parseTestPart(element) {
  const identifier = element.getAttribute('identifier');
  const sections = childElements(element, 'qti-assessment-section').map(parseSection);
  if (!sections.length) {
    throw new Error(`QTI test part "${identifier}" has no qti-assessment-section`);
  }
  return {
    identifier,
    navigationMode: element.getAttribute('navigation-mode') || NAVIGATION_MODE.LINEAR,
    submissionMode: element.getAttribute('submission-mode') || SUBMISSION_MODE.INDIVIDUAL,
    sessionControl: parseSessionControl(element),
    sections,
  };
}

/**
 * Parse a `qti-assessment-test` element (or a document containing one).
 * @param {Document|Element} source - The parsed test XML
 * @returns {object} The test tree: identifier, title, outcome identifiers and
 * its test parts, each holding nested sections and item refs.
 * @throws {Error} when there is no test element, or a test or part is empty
 */
export function parseAssessmentTest(source) {
  const root = source.documentElement || source;
  const test = root.localName === 'qti-assessment-test' ? root : null;
  if (!test) {
    throw new Error('Expected a qti-assessment-test element');
  }
  const testParts = childElements(test, 'qti-test-part').map(parseTestPart);
  if (!testParts.length) {
    throw new Error(
      `QTI assessment test "${test.getAttribute('identifier')}" has no qti-test-part`,
    );
  }
  return {
    identifier: test.getAttribute('identifier'),
    title: test.getAttribute('title') || '',
    outcomeIdentifiers: childElements(test, 'qti-outcome-declaration').map(declaration =>
      declaration.getAttribute('identifier'),
    ),
    testParts,
  };
}

/**
 * Deterministic pseudo-random generator (mulberry32) seeded from a string,
 * e.g. `${userId}:${attemptId}`, so a learner's draw is stable.
 * @param {string} seed - Any string; equal seeds give equal sequences
 * @returns {() => number} A function returning floats in [0, 1)
 */
export function createSeededRandom(seed) {
  let state = 0;
  for (let i = 0; i < seed.length; i++) {
    state = (Math.imul(31, state) + seed.charCodeAt(i)) | 0;
  }
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomIndex(random, length) {
  return Math.floor(random() * length);
}

/**
 * Apply `qti-selection`: required children are always kept, the rest of the
 * `select` count is drawn at random. Document order is preserved; reordering
 * is `qti-ordering`'s job.
 * @param {object[]} children - A section's child sections and item refs
 * @param {?object} selection - Parsed `qti-selection`, or null
 * @param {() => number} random - Random source in [0, 1)
 * @returns {object[]} The selected children
 */
function selectChildren(children, selection, random) {
  if (!selection || !(selection.select >= 0)) {
    return children;
  }
  const required = children.filter(child => child.required);
  const remaining = Math.max(selection.select - required.length, 0);
  let drawn;
  if (selection.withReplacement) {
    drawn = Array.from({ length: remaining }, () => children[randomIndex(random, children.length)]);
  } else {
    const pool = children.filter(child => !child.required);
    drawn = [];
    while (drawn.length < remaining && pool.length) {
      drawn.push(pool.splice(randomIndex(random, pool.length), 1)[0]);
    }
  }
  const order = new Map(children.map((child, index) => [child, index]));
  return [...required, ...drawn].sort((a, b) => order.get(a) - order.get(b));
}

/**
 * Fisher–Yates shuffle of the non-fixed entries; fixed entries keep their
 * position.
 * @param {object[]} entries - Entries with a `fixed` flag
 * @param {() => number} random - Random source in [0, 1)
 * @returns {object[]} The entries in their new order
 */
function shuffleUnfixed(entries, random) {
  const movable = entries.filter(entry => !entry.fixed);
  for (let i = movable.length - 1; i > 0; i--) {
    const j = randomIndex(random, i + 1);
    [movable[i], movable[j]] = [movable[j], movable[i]];
  }
  let next = 0;
  return entries.map(entry => (entry.fixed ? entry : movable[next++]));
}

function mergeSessionControl(parent, own) {
  return { ...parent, ...own };
}

/**
 * Resolve one section into the list of items it presents, in order.
 * Invisible sections that don't keep together are spliced into their parent
 * before the parent shuffles, so their items mix with the parent's.
 * @param {object} section - A parsed section
 * @param {() => number} random - Random source in [0, 1)
 * @param {object} sessionControl - Session control inherited from above
 * @returns {object[]} Item refs in presentation order
 */
function resolveSection(section, random, sessionControl) {
  const scope = mergeSessionControl(sessionControl, section.sessionControl);
  const selected = selectChildren(section.children, section.selection, random);
  let entries = [];
  for (const child of selected) {
    if (child.type === NODE_TYPE.ITEM) {
      entries.push({
        fixed: child.fixed,
        items: [{ ...child, sessionControl: mergeSessionControl(scope, child.sessionControl) }],
      });
      continue;
    }
    const childItems = resolveSection(child, random, scope);
    if (!child.visible && !child.keepTogether) {
      entries.push(...childItems.map(item => ({ fixed: item.fixed, items: [item] })));
    } else {
      entries.push({ fixed: child.fixed, items: childItems });
    }
  }
  if (section.ordering && section.ordering.shuffle) {
    entries = shuffleUnfixed(entries, random);
  }
  return entries.flatMap(entry => entry.items);
}

/**
 * The ordered item refs a learner sees in one test part, after selection and
 * ordering, each with its effective session control (defaults, then part,
 * then each enclosing section, then the item ref).
 * @param {object} testPart - A test part from `parseAssessmentTest`
 * @param {() => number} random - e.g. from `createSeededRandom`
 * @returns {object[]} Item refs in presentation order
 */
export function resolveTestPartItems(testPart, random) {
  const scope = mergeSessionControl(SESSION_CONTROL_DEFAULTS, testPart.sessionControl);
  return testPart.sections.flatMap(section => resolveSection(section, random, scope));
}

/**
 * Whether a learner may move from one item position to another within a
 * test part. Linear parts only move forward one item at a time; nonlinear
 * parts allow any move.
 * @param {object} testPart - A test part from `parseAssessmentTest`
 * @param {number} from - Current item index
 * @param {number} to - Target item index
 * @returns {boolean} True when the move is allowed
 */
export function canNavigate(testPart, from, to) {
  if (testPart.navigationMode === NAVIGATION_MODE.NONLINEAR) {
    return true;
  }
  return to === from + 1;
}

/**
 * When response processing runs for a test part: after each item
 * (individual) or once for the whole part when it is submitted
 * (simultaneous).
 * @param {object} testPart - A test part from `parseAssessmentTest`
 * @returns {'item'|'testPart'} Where response processing runs
 */
export function responseProcessingScope(testPart) {
  return testPart.submissionMode === SUBMISSION_MODE.SIMULTANEOUS ? 'testPart' : 'item';
}
