import { parseXML } from '../../xml';
import {
  NAVIGATION_MODE,
  SUBMISSION_MODE,
  canNavigate,
  createSeededRandom,
  parseAssessmentTest,
  resolveTestPartItems,
  responseProcessingScope,
} from '../assessmentTest';

function testXML(inner, attrs = '') {
  return parseXML(`<qti-assessment-test
      xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0"
      identifier="test-1" title="Fractions check" ${attrs}>
      ${inner}
    </qti-assessment-test>`);
}

function part(inner, attrs = 'navigation-mode="linear" submission-mode="individual"') {
  return `<qti-test-part identifier="part-1" ${attrs}>${inner}</qti-test-part>`;
}

function section(identifier, inner, attrs = '') {
  return `<qti-assessment-section identifier="${identifier}" title="${identifier}" ${attrs}>${inner}</qti-assessment-section>`;
}

function itemRef(identifier, attrs = '') {
  return `<qti-assessment-item-ref identifier="${identifier}" href="items/${identifier}.xml" ${attrs}/>`;
}

function itemIds(items) {
  return items.map(item => item.identifier);
}

describe('parseAssessmentTest', () => {
  it('parses parts, nested sections and item refs in document order', () => {
    const test = parseAssessmentTest(
      testXML(
        `<qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"/>
        ${part(
          section(
            's1',
            `${itemRef('q1', 'category="algebra core"')}${section('s1a', itemRef('q2'))}`,
          ),
          'navigation-mode="nonlinear" submission-mode="simultaneous"',
        )}`,
      ),
    );

    expect(test.identifier).toBe('test-1');
    expect(test.title).toBe('Fractions check');
    expect(test.outcomeIdentifiers).toEqual(['SCORE']);
    expect(test.testParts).toHaveLength(1);

    const [testPart] = test.testParts;
    expect(testPart.navigationMode).toBe(NAVIGATION_MODE.NONLINEAR);
    expect(testPart.submissionMode).toBe(SUBMISSION_MODE.SIMULTANEOUS);

    const [s1] = testPart.sections;
    expect(s1.children.map(child => child.type)).toEqual(['item', 'section']);
    expect(s1.children[0]).toMatchObject({
      identifier: 'q1',
      href: 'items/q1.xml',
      categories: ['algebra', 'core'],
      required: false,
      fixed: false,
    });
    expect(s1.children[1].children[0].identifier).toBe('q2');
  });

  it('applies spec defaults for section attributes', () => {
    const test = parseAssessmentTest(testXML(part(section('s1', itemRef('q1')))));
    expect(test.testParts[0].sections[0]).toMatchObject({
      visible: true,
      required: false,
      fixed: false,
      keepTogether: true,
      selection: null,
      ordering: null,
    });
  });

  it('rejects a test without test parts and a part without sections', () => {
    expect(() => parseAssessmentTest(testXML(''))).toThrow(/no qti-test-part/);
    expect(() => parseAssessmentTest(testXML(part('')))).toThrow(/no qti-assessment-section/);
  });

  it('rejects a document that is not an assessment test', () => {
    const item = parseXML('<qti-assessment-item identifier="i"/>');
    expect(() => parseAssessmentTest(item)).toThrow(/qti-assessment-test/);
  });
});

describe('resolveTestPartItems', () => {
  const items = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];

  function resolve(sectionInner, sectionAttrs = '', seed = 'learner-1:attempt-1') {
    const test = parseAssessmentTest(testXML(part(section('s1', sectionInner, sectionAttrs))));
    return itemIds(resolveTestPartItems(test.testParts[0], createSeededRandom(seed)));
  }

  it('presents items in document order without selection or ordering', () => {
    expect(resolve(items.map(id => itemRef(id)).join(''))).toEqual(items);
  });

  it('selects the requested number of items, always keeping required ones', () => {
    const inner = `<qti-selection select="3"/>${items
      .map(id => itemRef(id, id === 'q5' ? 'required="true"' : ''))
      .join('')}`;
    const drawn = resolve(inner);

    expect(drawn).toHaveLength(3);
    expect(drawn).toContain('q5');
    expect(new Set(drawn).size).toBe(3);
    // Selection keeps document order
    expect(drawn).toEqual([...drawn].sort());
  });

  it('can draw the same item more than once with replacement', () => {
    const inner = `<qti-selection select="5" with-replacement="true"/>${itemRef('q1')}${itemRef(
      'q2',
    )}`;
    const drawn = resolve(inner);
    expect(drawn).toHaveLength(5);
    expect(new Set(drawn).size).toBeLessThan(5);
  });

  it('gives the same draw for the same seed and a different one for another seed', () => {
    const inner = `<qti-selection select="3"/><qti-ordering shuffle="true"/>${items
      .map(id => itemRef(id))
      .join('')}`;
    expect(resolve(inner, '', 'learner-1:attempt-1')).toEqual(
      resolve(inner, '', 'learner-1:attempt-1'),
    );
    const draws = new Set(
      ['a', 'b', 'c', 'd', 'e'].map(seed => resolve(inner, '', seed).join(',')),
    );
    expect(draws.size).toBeGreaterThan(1);
  });

  it('keeps fixed items in place when shuffling', () => {
    const inner = `<qti-ordering shuffle="true"/>${items
      .map(id => itemRef(id, id === 'q1' || id === 'q4' ? 'fixed="true"' : ''))
      .join('')}`;
    for (const seed of ['a', 'b', 'c', 'd']) {
      const order = resolve(inner, '', seed);
      expect(order[0]).toBe('q1');
      expect(order[3]).toBe('q4');
      expect([...order].sort()).toEqual(items);
    }
  });

  it('mixes items of an invisible section into the parent shuffle unless kept together', () => {
    const nested = keepTogether =>
      `<qti-ordering shuffle="true"/>${itemRef('q1')}${itemRef('q2')}${section(
        'inner',
        `${itemRef('q3')}${itemRef('q4')}`,
        `visible="false" keep-together="${keepTogether}"`,
      )}`;
    const adjacent = order => Math.abs(order.indexOf('q3') - order.indexOf('q4')) === 1;
    const seeds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

    expect(seeds.every(seed => adjacent(resolve(nested(true), '', seed)))).toBe(true);
    expect(seeds.some(seed => !adjacent(resolve(nested(false), '', seed)))).toBe(true);
  });

  it('resolves item session control from defaults, part, sections and item', () => {
    const test = parseAssessmentTest(
      testXML(
        part(
          `<qti-item-session-control max-attempts="2" allow-review="false"/>
          ${section(
            's1',
            `<qti-item-session-control show-feedback="true"/>
            ${itemRef('q1')}
            <qti-assessment-item-ref identifier="q2" href="items/q2.xml">
              <qti-item-session-control max-attempts="1"/>
            </qti-assessment-item-ref>`,
          )}`,
        ),
      ),
    );
    const [q1, q2] = resolveTestPartItems(test.testParts[0], createSeededRandom('x'));

    expect(q1.sessionControl).toEqual({
      maxAttempts: 2,
      showFeedback: true,
      allowReview: false,
      showSolution: false,
      allowComment: false,
      allowSkipping: true,
      validateResponses: false,
    });
    expect(q2.sessionControl.maxAttempts).toBe(1);
    expect(q2.sessionControl.showFeedback).toBe(true);
  });
});

describe('navigation and submission modes', () => {
  const linear = { navigationMode: NAVIGATION_MODE.LINEAR, submissionMode: 'individual' };
  const nonlinear = { navigationMode: NAVIGATION_MODE.NONLINEAR, submissionMode: 'simultaneous' };

  it('only allows moving forward one item in a linear part', () => {
    expect(canNavigate(linear, 2, 3)).toBe(true);
    expect(canNavigate(linear, 2, 1)).toBe(false);
    expect(canNavigate(linear, 2, 4)).toBe(false);
  });

  it('allows any move in a nonlinear part', () => {
    expect(canNavigate(nonlinear, 2, 0)).toBe(true);
    expect(canNavigate(nonlinear, 0, 5)).toBe(true);
  });

  it('processes responses per item or once per test part', () => {
    expect(responseProcessingScope(linear)).toBe('item');
    expect(responseProcessingScope(nonlinear)).toBe('testPart');
  });
});
