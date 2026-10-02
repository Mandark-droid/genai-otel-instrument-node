/**
 * Vector databases: Qdrant, Pinecone, Chroma and Milvus.
 *
 * A port of `genai_otel/mcp_instrumentors/vector_db_instrumentor.py`: the same
 * span names (`qdrant.query_points`, `pinecone.index.query`, `chroma.query`,
 * `milvus.search`), the collection and top-k attributes, and the retrieval
 * score summary (`rag.result.score_max` / `_min` / `_mean` / `_margin`) that
 * makes a bad retrieval visible without recording any document.
 *
 * Vectors and documents are never recorded.
 */
import type { AttributeValue, Span } from '@opentelemetry/api';
import { exportedClass, prototypeDefining } from '../instrumentors/wrap';
import type { PatchTarget } from '../instrumentors/patching';
import { DatastoreInstrumentor, onFirstInstance } from './base';

type Obj = Record<string, unknown>;
type AnyFunction = (...args: never[]) => unknown;
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null;

/**
 * The relevance scores in a result, whatever the client calls them. A port of
 * `VectorDBInstrumentor._extract_scores`.
 */
export function extractScores(result: unknown): number[] {
  if (result === null || result === undefined) return [];
  if (typeof result === 'number') return Number.isFinite(result) ? [result] : [];
  if (Array.isArray(result)) return result.flatMap((item) => extractScores(item));
  if (!isObject(result)) return [];
  for (const key of ['scores', 'distances', 'matches', 'points', 'results']) {
    if (key in result && result[key] !== undefined && result[key] !== null) return extractScores(result[key]);
  }
  for (const key of ['score', 'distance']) {
    if (key in result) {
      const value = Number(result[key]);
      return Number.isFinite(value) && result[key] !== null ? [value] : [];
    }
  }
  if (isObject(result._additional)) {
    for (const key of ['distance', 'certainty', 'score']) {
      if (key in result._additional) {
        const value = Number(result._additional[key]);
        return Number.isFinite(value) ? [value] : [];
      }
    }
    return [];
  }
  const data = result.data;
  if (isObject(data) && isObject(data.Get)) return Object.values(data.Get).flatMap((entries) => extractScores(entries));
  return [];
}

/** Highest, lowest and mean score, and the margin between the top two. Nothing when there are no scores. */
export function setScoreAttributes(span: Span, scores: number[]): void {
  if (scores.length === 0) return;
  span.setAttribute('rag.result.score_max', Math.max(...scores));
  span.setAttribute('rag.result.score_min', Math.min(...scores));
  span.setAttribute('rag.result.score_mean', scores.reduce((sum, score) => sum + score, 0) / scores.length);
  if (scores.length > 1) {
    const ordered = [...scores].sort((a, b) => b - a);
    span.setAttribute('rag.result.score_margin', (ordered[0] as number) - (ordered[1] as number));
  }
}

const scored = { onResult: (span: Span, result: unknown) => setScoreAttributes(span, extractScores(result)) };

export class QdrantInstrumentor extends DatastoreInstrumentor {
  protected readonly label = 'Qdrant';
  protected readonly packages = ['@qdrant/js-client-rest'];
  protected override get owner(): string {
    return 'qdrant';
  }

  protected targets(module: unknown): PatchTarget[] {
    const client: unknown = exportedClass(module, 'QdrantClient');
    if (typeof client !== 'function') return [];
    // `query` is the current API (the reference's `query_points`); `search` its predecessor.
    return (
      [
        ['query', 'query_points'],
        ['search', 'search'],
      ] as const
    ).map(([method, operation]) => ({
      holder: prototypeDefining(client, method),
      method,
      wrap: this.datastoreWrapper((_instance, args) => {
        const collection = typeof args[0] === 'string' ? args[0] : 'unknown';
        const limit = isObject(args[1]) && typeof args[1].limit === 'number' ? args[1].limit : 10;
        return {
          spanName: `qdrant.${operation}`,
          system: 'qdrant',
          operation,
          attributes: { 'vector.collection': collection, 'db.collection.name': collection, 'vector.limit': limit, 'db.vector.top_k': limit },
        };
      }, scored),
    }));
  }
}

export class PineconeInstrumentor extends DatastoreInstrumentor {
  protected readonly label = 'Pinecone';
  protected readonly packages = ['@pinecone-database/pinecone'];
  protected override get owner(): string {
    return 'pinecone';
  }

  protected targets(module: unknown): PatchTarget[] {
    const index: unknown = exportedClass(module, 'Index');
    if (typeof index !== 'function') return [];
    return (
      [
        ['query', 'query'],
        ['upsert', 'upsert'],
        ['deleteOne', 'delete'],
        ['deleteMany', 'delete'],
        ['deleteAll', 'delete'],
      ] as const
    ).map(([method, operation]) => ({
      holder: prototypeDefining(index, method),
      method,
      wrap: this.datastoreWrapper((instance, args) => {
        const target = isObject(instance) && isObject(instance.target) ? instance.target : {};
        const attributes: Record<string, AttributeValue | undefined> = {
          'vector.collection': typeof target.indexName === 'string' ? target.indexName : undefined,
          'db.collection.name': typeof target.indexName === 'string' ? target.indexName : undefined,
        };
        if (operation === 'query' && isObject(args[0]) && typeof args[0].topK === 'number') attributes['db.vector.top_k'] = args[0].topK;
        return { spanName: `pinecone.index.${operation}`, system: 'pinecone', operation, attributes };
      }, scored),
    }));
  }
}

export class ChromaInstrumentor extends DatastoreInstrumentor {
  protected readonly label = 'ChromaDB';
  protected readonly packages = ['chromadb'];
  protected override get owner(): string {
    return 'chromadb';
  }

  protected targets(module: unknown): PatchTarget[] {
    const client: unknown = exportedClass(module, 'ChromaClient');
    if (typeof client !== 'function') return [];
    // The collection class is not exported: it is patched when the client first hands one back.
    const patchCollection = onFirstInstance((prototype) => {
      this.patchLater(
        prototype,
        'query',
        this.datastoreWrapper((instance, args) => {
          const name = isObject(instance) && typeof instance.name === 'string' ? instance.name : undefined;
          const request = isObject(args[0]) ? args[0] : {};
          const results = typeof request.nResults === 'number' ? request.nResults : 10;
          return {
            spanName: 'chroma.query',
            system: 'chromadb',
            operation: 'query',
            attributes: { 'vector.collection': name, 'db.collection.name': name, 'vector.n_results': results, 'db.vector.top_k': results },
          };
        }, scored),
      );
    });
    return ['getCollection', 'getOrCreateCollection', 'createCollection', 'collection'].map((method) => ({
      holder: prototypeDefining(client, method),
      method,
      wrap: (original: AnyFunction): AnyFunction =>
        function (this: unknown, ...args: unknown[]): unknown {
          const result = (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
          const observe = (value: unknown): void => {
            try {
              patchCollection(value);
            } catch {
              // a collection we cannot patch is simply not traced
            }
          };
          if (isObject(result) && typeof result.then === 'function') void (result as unknown as PromiseLike<unknown>).then(observe, () => {});
          else observe(result);
          return result;
        } as unknown as AnyFunction,
    }));
  }
}

export class MilvusInstrumentor extends DatastoreInstrumentor {
  protected readonly label = 'Milvus';
  protected readonly packages = ['@zilliz/milvus2-sdk-node'];
  protected override get owner(): string {
    return 'milvus';
  }

  protected targets(module: unknown): PatchTarget[] {
    const client: unknown = exportedClass(module, 'MilvusClient');
    if (typeof client !== 'function') return [];
    return [
      {
        holder: prototypeDefining(client, 'search'),
        method: 'search',
        wrap: this.datastoreWrapper((_instance, args) => {
          const request = isObject(args[0]) ? args[0] : {};
          const collection = typeof request.collection_name === 'string' ? request.collection_name : undefined;
          const limit = typeof request.limit === 'number' ? request.limit : typeof request.topk === 'number' ? request.topk : 10;
          return {
            spanName: 'milvus.search',
            system: 'milvus',
            operation: 'search',
            attributes: { 'vector.collection': collection, 'db.collection.name': collection, 'vector.limit': limit, 'db.vector.top_k': limit },
          };
        }, scored),
      },
    ];
  }
}
