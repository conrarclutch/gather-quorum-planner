import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SourcesView } from '../src/components/SourcesView';
import type { PlannerEvent } from '../src/types';

describe('source schedule dates', () => {
  it.each(['Oct 20', '24-Oct'])('renders raw date %s alongside the ISO planning date without crashing', sourceDate => {
    const record = {
      id: 'synthetic-record', sourceUrl: '#', sourceTab: 'Synthetic source', sourceRow: 1,
      sourceDate, eventDate: '2026-10-24', originalTitle: 'Sample event',
      dateCaveat: '', yearConfidence: '2026 confirmed by source date serial',
    } as PlannerEvent;
    const html = renderToStaticMarkup(createElement(SourcesView, { events: [record], preview: false }));
    expect(html).toContain(sourceDate);
    expect(html).toContain('October 24');
    expect(html).not.toContain('Year needs confirmation');
    expect(html).not.toContain('Date shown for planning differs');
  });
});
