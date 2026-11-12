/**
 * The A2UI reader: what is recorded, what is left out, and that the names are the Python reference's.
 * Runs in the Node project and in the browser-like one (the core must not need either).
 */
import { describe, expect, it } from 'vitest';
import scoped from '../../contract/a2a-a2ui.json';
import { A2UIAttributes, A2UI_CONTENT_KEYS, CAPABILITIES_KEYS, ERROR_EVENT, MIME_TYPES } from '../../src/a2ui/attributes';
import { A2AAttributes, A2A_CONTENT_KEYS } from '../../src/a2a/attributes';
import { A2uiObservation, applyToSpan, hasExtension, normaliseVersion, scrubMessage, scrubPayload, snake, unwrapMessageList } from '../../src/a2ui/extract';
import { jsonCompactSorted, jsonSorted } from '../../src/a2ui/json';

const CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';
const create = (surfaceId: string, catalogId = CATALOG) => ({ version: '1.0', createSurface: { surfaceId, catalogId } });
const update = (surfaceId: string, components: unknown[]) => ({ version: '1.0', updateComponents: { surfaceId, components } });

function observe(capture: boolean, ...feed: [unknown, string][]): { always: Record<string, unknown>; content: Record<string, unknown>; obs: A2uiObservation } {
  const obs = new A2uiObservation(capture);
  for (const [payload, side] of feed) obs.addPayload(payload, side);
  const [always, content] = obs.attributes();
  return { always, content, obs };
}

describe('names are the reference implementation, not typed here', () => {
  it('every attribute constant is exactly what the Python commit holds', () => {
    expect({ ...A2UIAttributes }).toEqual(scoped.a2ui.attributes);
    expect({ ...A2AAttributes }).toEqual(scoped.a2a.attributes);
  });

  it('content keys, media types, capability keys and the error event come from the same file', () => {
    const a2ui = scoped.a2ui.attributes as Record<string, string>;
    const a2a = scoped.a2a.attributes as Record<string, string>;
    expect([...A2UI_CONTENT_KEYS].sort()).toEqual(scoped.a2ui.content_keys.map((key) => a2ui[key]).sort());
    expect([...A2A_CONTENT_KEYS].sort()).toEqual(scoped.a2a.content_keys.map((key) => a2a[key]).sort());
    expect([...MIME_TYPES]).toEqual(['application/a2ui+json', 'application/json+a2ui']);
    expect(CAPABILITIES_KEYS).toEqual(['a2uiRendererCapabilities', 'a2uiClientCapabilities']);
    expect(ERROR_EVENT).toBe('a2ui.error');
  });

  it('records the Python commit it was taken from, in full', () => {
    expect(scoped.python_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(scoped.python_commit.startsWith('7762b71')).toBe(true);
  });
});

describe('what is always recorded', () => {
  it('a createSurface and an updateComponents: version, surface, catalog, counts, types', () => {
    const { always } = observe(false, [[create('s1'), update('s1', [{ id: 'root', component: 'Text' }, { id: 'b', component: 'Button' }])], 'agent']);
    expect(always).toEqual({
      'a2ui.protocol.version': '1.0',
      'a2ui.agent_message.count': 2,
      'a2ui.message.types': ['create_surface', 'update_components'],
      'a2ui.surface.id': 's1',
      'a2ui.surface.count': 1,
      'a2ui.catalog.id': CATALOG,
      'a2ui.catalog.ids': [CATALOG],
      'a2ui.component.count': 2,
    });
  });

  it('a user action: the name, the surface and the count, and nothing of the context without capture', () => {
    const { always, content } = observe(false, [
      { version: '1.0', action: { name: 'submit_form', surfaceId: 's1', sourceComponentId: 'btn', context: { email: 'a@b.example' } } },
      'renderer',
    ]);
    expect(always).toMatchObject({
      'a2ui.renderer_message.count': 1,
      'a2ui.message.types': ['action'],
      'a2ui.action.name': 'submit_form',
      'a2ui.surface.id': 's1',
    });
    expect(content).toEqual({});
    expect(JSON.stringify(always)).not.toContain('a@b.example');
  });

  it('function calls and function errors', () => {
    const { always } = observe(
      false,
      [{ version: '1.0', callAgentFunction: { surfaceId: 's1', callFunction: { '@call': 'lookup', catalogId: 'cat-x' } } }, 'renderer'],
      [{ version: '1.0', agentFunctionResponse: { surfaceId: 's1', error: { code: 'EXECUTION_ERROR', message: 'boom' } } }, 'agent'],
    );
    expect(always).toMatchObject({
      'a2ui.function.name': 'lookup',
      'a2ui.catalog.id': 'cat-x',
      'a2ui.error.codes': ['EXECUTION_ERROR'],
      'a2ui.error.count': 1,
    });
  });

  it('a renderer error is a code, a count and an event, not a failure', () => {
    const { always, obs } = observe(false, [
      { version: '1.0', error: { code: 'VALIDATION_FAILED', surfaceId: 's9', path: '/components/0', message: 'bad prop for jane@example.com' } },
      'renderer',
    ]);
    expect(always).toMatchObject({ 'a2ui.error.codes': ['VALIDATION_FAILED'], 'a2ui.error.count': 1, 'a2ui.surface.id': 's9' });
    expect(obs.events()).toEqual([[ERROR_EVENT, { 'a2ui.error.code': 'VALIDATION_FAILED', 'a2ui.surface.id': 's9' }]]);
    expect(JSON.stringify(always)).not.toContain('jane@example.com');
  });

  it('a renderer error known only as an error: counted, typed, and no version guessed', () => {
    const obs = new A2uiObservation(true);
    obs.addRendererError({ code: 'UNALLOWED_CHILD', surfaceId: 's', message: 'm' });
    const [always, content] = obs.attributes();
    expect(always).toEqual({
      'a2ui.renderer_message.count': 1,
      'a2ui.message.types': ['error'],
      'a2ui.surface.id': 's',
      'a2ui.surface.count': 1,
      'a2ui.error.count': 1,
      'a2ui.error.codes': ['UNALLOWED_CHILD'],
    });
    expect(content['a2ui.error.messages']).toEqual(['m']);
  });

  it('renderer capabilities from either metadata key, any version, deduplicated and sorted', () => {
    const obs = new A2uiObservation(false);
    obs.addCapabilities({ a2uiRendererCapabilities: { '1.0': { supportedCatalogIds: ['b', 'a'] } } });
    obs.addCapabilities({ a2uiClientCapabilities: { supportedCatalogIds: ['a', 'c'] } });
    expect(obs.attributes()[0]['a2ui.renderer.supported_catalog_ids']).toEqual(['a', 'b', 'c']);
    expect(obs.hasData).toBe(true);
  });

  it('the extension URI at any version, alone or inside a header list', () => {
    expect(hasExtension(['https://a2ui.org/a2a-extension/a2ui/v1.0'])).toBe(true);
    expect(hasExtension(['https://example.com/x, https://a2ui.org/a2a-extension/a2ui/v0.9'])).toBe(true);
    expect(hasExtension(['https://example.com/x'])).toBe(false);
    const obs = new A2uiObservation();
    obs.markExtension(['https://a2ui.org/a2a-extension/a2ui/v1.0']);
    expect(obs.attributes()[0]['a2ui.extension.active']).toBe(true);
  });

  it('createSurface carrying components counts them, and a component\'s own catalog is a catalog', () => {
    const { always } = observe(false, [
      { version: '1.0', createSurface: { surfaceId: 's', catalogId: 'c1', components: [{ id: 'r', component: 'Text', '@catalogId': 'c2' }] } },
      'agent',
    ]);
    expect(always['a2ui.component.count']).toBe(1);
    expect(always['a2ui.catalog.ids']).toEqual(['c1', 'c2']);
    expect(always['a2ui.catalog.id']).toBeUndefined();
  });
});

describe('several values in one operation', () => {
  it('a single-valued identifier seen as two values is omitted; lists are sorted and de-duplicated', () => {
    const { always } = observe(false, [
      [create('b', 'cat-2'), create('a', 'cat-1'), update('a', []), { version: '0.9', createSurface: { surfaceId: 'c', catalogId: 'cat-1' } }],
      'agent',
    ]);
    expect(always['a2ui.surface.id']).toBeUndefined();
    expect(always['a2ui.surface.count']).toBe(3);
    expect(always['a2ui.catalog.id']).toBeUndefined();
    expect(always['a2ui.catalog.ids']).toEqual(['cat-1', 'cat-2']);
    expect(always['a2ui.protocol.version']).toBeUndefined(); // 1.0 and 0.9 in one operation
    expect(always['a2ui.message.types']).toEqual(['create_surface', 'update_components']);
  });

  it('two action names: no single name', () => {
    const { always } = observe(false, [{ version: '1.0', action: { name: 'a' } }, 'renderer'], [{ version: '1.0', action: { name: 'b' } }, 'renderer']);
    expect(always['a2ui.action.name']).toBeUndefined();
    expect(always['a2ui.renderer_message.count']).toBe(2);
  });
});

describe('content capture', () => {
  const message = update('s1', [
    { id: 'root', component: 'Image', url: 'https://cdn.example/photo.png', fit: 'cover' },
    { id: 'v', component: 'Video', src: { '@path': '/video' } },
  ]);

  it('off: no message, data model, context, error path or message, or component type is held at all', () => {
    const { content, obs } = observe(
      false,
      [[message, { version: '1.0', updateDataModel: { surfaceId: 's1', value: { name: 'x' } } }], 'agent'],
      [{ version: '1.0', action: { name: 'go', context: { k: 'v' } } }, 'renderer'],
      [{ version: '1.0', error: { code: 'C', path: '/p', message: 'm' } }, 'renderer'],
    );
    expect(content).toEqual({});
    expect(obs.messages).toEqual([]);
    expect(obs.dataModel).toEqual([]);
    expect(obs.actionContexts).toEqual([]);
    expect(obs.componentTypes.size).toBe(0);
  });

  it('on: the messages, with media URLs and data: URIs redacted and a data binding kept', () => {
    const { content } = observe(true, [
      [message, { version: '1.0', updateDataModel: { surfaceId: 's1', value: { avatar: 'data:image/png;base64,AAAA', name: 'Ada' } } }],
      'agent',
    ]);
    const text = String(content['a2ui.messages']);
    expect(text).not.toContain('cdn.example');
    expect(text).not.toContain('base64');
    expect(text).toContain('"url":"[redacted]"');
    expect(text).toContain('"src":{"@path":"/video"}');
    expect(text).toContain('"fit":"cover"');
    expect(String(content['a2ui.data_model'])).toBe('[{"avatar":"[redacted]","name":"Ada"}]');
    expect(content['a2ui.component.types']).toEqual(['Image', 'Video']);
  });

  it('on: action context and the error path and message', () => {
    const { content } = observe(
      true,
      [{ version: '1.0', action: { name: 'go', context: { b: 2, a: 1 } } }, 'renderer'],
      [{ version: '1.0', error: { code: 'C', surfaceId: 's', path: '/x', message: 'quoted jane@example.com' } }, 'renderer'],
    );
    expect(content['a2ui.action.context']).toBe('[{"a":1,"b":2}]');
    expect(content['a2ui.error.paths']).toEqual(['/x']);
    expect(content['a2ui.error.messages']).toEqual(['quoted jane@example.com']);
  });

  it('keys ending in Url / Uri are redacted inside components only', () => {
    const scrubbed = scrubMessage(update('s', [{ id: 'a', component: 'X', posterUrl: 'https://x', logoURI: 'https://y', label: 'https://not-a-key' }]));
    expect(JSON.stringify(scrubbed)).toBe(
      '{"version":"1.0","updateComponents":{"surfaceId":"s","components":[{"id":"a","component":"X","posterUrl":"[redacted]","logoURI":"[redacted]","label":"https://not-a-key"}]}}',
    );
    const outside = scrubMessage({ version: '1.0', updateDataModel: { surfaceId: 's', value: { homepageUrl: 'https://kept' } } });
    expect(JSON.stringify(outside)).toContain('https://kept');
    expect(scrubPayload([{ version: '1.0', x: 'DATA:text/plain,hi' }])).toEqual([{ version: '1.0', x: '[redacted]' }]);
  });
});

describe('v0.8, unknown shapes and bad input', () => {
  it('a message with no version is v0.8: counted and recognised, nothing else read', () => {
    const { always, content } = observe(true, [{ surfaceUpdate: { surfaceId: 's', components: [{ id: 'x' }] } }, 'agent']);
    expect(always).toEqual({ 'a2ui.protocol.version': '0.8', 'a2ui.agent_message.count': 1 });
    expect(content).toEqual({});
  });

  it('never throws on anything', () => {
    const obs = new A2uiObservation(true);
    for (const bad of [null, undefined, 5, 'x', [null, 5, []], { version: 1 }, { version: '1.0', action: 'no' }, { version: '1.0', createSurface: null }]) {
      expect(() => obs.addPayload(bad, 'agent')).not.toThrow();
      expect(() => obs.addPayload(bad, 'renderer')).not.toThrow();
    }
    const circular: Record<string, unknown> = { version: '1.0', updateDataModel: { surfaceId: 's' } };
    (circular.updateDataModel as Record<string, unknown>).value = circular;
    expect(() => obs.addPayload(circular, 'agent')).not.toThrow();
    expect(() => obs.attributes()).not.toThrow();
  });

  it('a message-list wrapper is unwrapped only where the caller asks', () => {
    const wrapper = { messages: [create('s1'), create('s2')] };
    expect(unwrapMessageList(wrapper)).toEqual(wrapper.messages);
    expect(unwrapMessageList(create('s1'))).toEqual(create('s1'));
    expect(observe(false, [wrapper, 'agent']).always['a2ui.agent_message.count']).toBe(1);
  });

  it('versions normalise to major.minor, and snake_case names match Python', () => {
    expect(['1.0', 'v0.9', 'v0.9.1', 'V1.2.3'].map(normaliseVersion)).toEqual(['1.0', '0.9', '0.9', '1.2']);
    expect(normaliseVersion('banana')).toBeUndefined();
    expect(normaliseVersion(1)).toBeUndefined();
    expect(['createSurface', 'callAgentFunction', 'action'].map(snake)).toEqual(['create_surface', 'call_agent_function', 'action']);
  });

  it('invalid is never overwritten by a later valid', () => {
    const obs = new A2uiObservation();
    obs.setOutcome('invalid');
    obs.setOutcome('valid');
    expect(obs.outcome).toBe('invalid');
  });
});

describe('Python-style JSON for content attributes', () => {
  it('sorted keys, ensure_ascii and the two separator styles', () => {
    const value = { b: [1, { z: 'é', a: null }], a: 'q"\\\n', ключ: true };
    expect(jsonCompactSorted(value)).toBe('{"a":"q\\"\\\\\\n","b":[1,{"a":null,"z":"\\u00e9"}],"\\u043a\\u043b\\u044e\\u0447":true}');
    expect(jsonSorted({ b: 1, a: [1, 2] })).toBe('{"a": [1, 2], "b": 1}');
    expect(jsonSorted({ x: undefined, y: 1 })).toBe('{"y": 1}');
    expect(jsonCompactSorted('\u{1F600}')).toBe('"\\ud83d\\ude00"');
    expect(jsonCompactSorted(Number.NaN)).toBe('NaN');
  });
});

describe('applyToSpan', () => {
  it('writes attributes, content through the writer and only the events it was not told to skip; never throws', () => {
    const { obs } = observe(true, [[{ version: '1.0', error: { code: 'A' } }, { version: '1.0', error: { code: 'B' } }], 'renderer']);
    const attributes: Record<string, unknown> = {};
    const events: string[] = [];
    const span = {
      setAttribute: (key: string, value: unknown) => {
        attributes[key] = value;
        return span;
      },
      addEvent: (name: string, attrs: Record<string, unknown>) => {
        events.push(`${name}:${String(attrs['a2ui.error.code'])}`);
        return span;
      },
    };
    const written: string[] = [];
    applyToSpan(span as never, obs, (_span, key) => written.push(key), 1);
    expect(attributes['a2ui.error.codes']).toEqual(['A', 'B']);
    expect(written).toContain('a2ui.messages');
    expect(events).toEqual(['a2ui.error:B']);
    expect(() =>
      applyToSpan(
        {
          setAttribute: () => {
            throw new Error('closed');
          },
        } as never,
        obs,
        () => {},
      ),
    ).not.toThrow();
  });
});
