/**
 * Retrieval (RAG) attributes on a span: the query and the documents that came
 * back, in rank order. A port of the Python library's
 * `BaseInstrumentor.add_retrieval_attributes`, with the same attribute names,
 * limits and truncation, so a retrieval reads the same from either library.
 * The names are the ones OpenInference backends (Arize AX, Phoenix) show as a
 * retriever's documents.
 *
 *   addRetrievalAttributes(span, hits.map((h) => ({ id: h.id, score: h.score, content: h.text })), {
 *     query: question,
 *   });
 *
 * Document text and the query are application content: pass them only when the
 * application captures content. Ids and scores alone still show the ranking.
 */
import type { Span } from '@opentelemetry/api';

export interface RetrievedDocument {
  id?: string | number;
  /** Relevance score; higher is better. */
  score?: number;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface RetrievalAttributeOptions {
  query?: string;
  /** Documents recorded, from the top. Default 5, as in the Python library. */
  maxDocs?: number;
}

const QUERY_MAX = 500;
const CONTENT_MAX = 500;
const METADATA_KEY_MAX = 50;
const METADATA_VALUE_MAX = 200;

/** `retrieval.query`, `retrieval.documents.{i}.document.{id,score,content,metadata.*}` and `retrieval.document_count`. */
export function addRetrievalAttributes(
  span: Span,
  documents: readonly RetrievedDocument[],
  options: RetrievalAttributeOptions = {},
): void {
  if (options.query) span.setAttribute('retrieval.query', options.query.slice(0, QUERY_MAX));
  const maxDocs = options.maxDocs ?? 5;
  documents.slice(0, maxDocs).forEach((doc, i) => {
    const prefix = `retrieval.documents.${i}.document`;
    if (doc.id !== undefined) span.setAttribute(`${prefix}.id`, String(doc.id));
    if (typeof doc.score === 'number' && Number.isFinite(doc.score)) span.setAttribute(`${prefix}.score`, doc.score);
    if (doc.content !== undefined) span.setAttribute(`${prefix}.content`, String(doc.content).slice(0, CONTENT_MAX));
    if (doc.metadata && typeof doc.metadata === 'object') {
      for (const [key, value] of Object.entries(doc.metadata)) {
        span.setAttribute(`${prefix}.metadata.${key.slice(0, METADATA_KEY_MAX)}`, String(value).slice(0, METADATA_VALUE_MAX));
      }
    }
  });
  span.setAttribute('retrieval.document_count', documents.length);
}
