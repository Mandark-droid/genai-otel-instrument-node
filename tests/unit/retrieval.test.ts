import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { addRetrievalAttributes } from '../../src';

function record(fn: (span: import('@opentelemetry/api').Span) => void) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const span = provider.getTracer('t').startSpan('retrieve');
  fn(span);
  span.end();
  return exporter.getFinishedSpans()[0]!.attributes;
}

describe('addRetrievalAttributes (port of add_retrieval_attributes)', () => {
  it('records the query and each document in rank order, with the same names as the Python library', () => {
    const attributes = record((span) =>
      addRetrievalAttributes(
        span,
        [
          { id: 'm1', score: 0.91, content: 'Refunds are accepted within 30 days', metadata: { kind: 'policy' } },
          { id: 7, score: 0.42, content: 'Shipping takes 3 to 5 days' },
        ],
        { query: 'What is the refund window?' },
      ),
    );
    expect(attributes).toEqual({
      'retrieval.query': 'What is the refund window?',
      'retrieval.documents.0.document.id': 'm1',
      'retrieval.documents.0.document.score': 0.91,
      'retrieval.documents.0.document.content': 'Refunds are accepted within 30 days',
      'retrieval.documents.0.document.metadata.kind': 'policy',
      'retrieval.documents.1.document.id': '7',
      'retrieval.documents.1.document.score': 0.42,
      'retrieval.documents.1.document.content': 'Shipping takes 3 to 5 days',
      'retrieval.document_count': 2,
    });
  });

  it('keeps the first five documents, truncates as the Python library does, and counts them all', () => {
    const docs = Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, content: 'x'.repeat(900), metadata: { ['k'.repeat(80)]: 'v'.repeat(300) } }));
    const attributes = record((span) => addRetrievalAttributes(span, docs, { query: 'q'.repeat(700) }));
    expect(String(attributes['retrieval.query'])).toHaveLength(500);
    expect(String(attributes['retrieval.documents.0.document.content'])).toHaveLength(500);
    expect(attributes[`retrieval.documents.0.document.metadata.${'k'.repeat(50)}`]).toBe('v'.repeat(200));
    expect(attributes['retrieval.documents.4.document.id']).toBe('d4');
    expect('retrieval.documents.5.document.id' in attributes).toBe(false);
    expect(attributes['retrieval.document_count']).toBe(8);
  });

  it('ids and scores alone, when the application does not capture content', () => {
    const attributes = record((span) => addRetrievalAttributes(span, [{ id: 'a', score: 3 }]));
    expect(attributes).toEqual({ 'retrieval.documents.0.document.id': 'a', 'retrieval.documents.0.document.score': 3, 'retrieval.document_count': 1 });
  });
});
