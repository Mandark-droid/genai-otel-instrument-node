/**
 * Semantic-convention contract: attribute names and the
 * OTEL_SEMCONV_STABILITY_OPT_IN behaviour (contract/semconv.json).
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import contract from '../../contract/semconv.json';
import { loadConfig } from '../../src/config';
import {
  AGENT_OPERATION_MARKERS,
  ATTR,
  ATTR_TEMPLATES,
  genaiSemconvModes,
  genaiTierOptedIn,
  SemanticConvention,
  STABILITY_OPT_IN_DEFAULT,
  SUPERSEDED_ATTRIBUTES,
  TOKEN_MODALITIES,
} from '../../src/semconv';

describe('OTEL_SEMCONV_STABILITY_OPT_IN', () => {
  it.each(contract.stability_opt_in.map((entry) => [JSON.stringify(entry.value), entry] as const))(
    'value %s',
    (_value, entry) => {
      const modes = genaiSemconvModes(entry.value ?? undefined);
      expect(modes.emitCurrent, 'emit_current').toBe(entry.emit_current);
      expect(modes.emitSuperseded, 'emit_superseded').toBe(entry.emit_superseded);
      expect(genaiTierOptedIn(entry.value ?? undefined), 'canonical_messages_payload').toBe(entry.canonical_messages_payload);
    },
  );

  it('null and undefined both mean unset', () => {
    expect(genaiSemconvModes(null)).toEqual(genaiSemconvModes(undefined));
    expect(genaiTierOptedIn(null)).toBe(false);
  });

  it('the default opt-in is the configuration default', () => {
    expect(STABILITY_OPT_IN_DEFAULT).toBe(contract.stability_opt_in_default);
    expect(loadConfig({}, {}).semconvStabilityOptIn).toBe(contract.stability_opt_in_default);
  });
});

describe('generated constants', () => {
  it('are up to date with the vendored contract', () => {
    const result = spawnSync(process.execPath, [resolve(__dirname, '../../scripts/generate-contract-code.mjs'), '--check'], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('SemanticConvention has every constant of the reference class, with the same value', () => {
    expect({ ...SemanticConvention }).toEqual(contract.semconv_constants);
  });

  it('ATTR holds every non-template attribute name the reference implementation writes', () => {
    const expected = contract.attributes.filter((attribute) => !attribute.template).map((attribute) => attribute.name);
    expect(Object.values(ATTR).sort()).toEqual([...expected].sort());
    expect(ATTR.GEN_AI_REQUEST_MODEL).toBe('gen_ai.request.model');
    expect(ATTR.GEN_AI_USAGE_COST_TOTAL).toBe('gen_ai.usage.cost.total');
  });

  it('ATTR_TEMPLATES holds every templated name', () => {
    const expected = contract.attributes.filter((attribute) => attribute.template).map((attribute) => attribute.name);
    expect([...ATTR_TEMPLATES]).toEqual([...expected].sort());
  });

  it('superseded pairs, token modalities and agent markers', () => {
    expect({ ...SUPERSEDED_ATTRIBUTES }).toEqual(contract.superseded);
    expect([...TOKEN_MODALITIES]).toEqual(contract.token_modalities);
    expect([...AGENT_OPERATION_MARKERS]).toEqual(contract.agent_operation_markers);
  });

  it('every superseded name and its replacement is a known attribute', () => {
    const names = new Set<string>(Object.values(ATTR));
    for (const [old, current] of Object.entries(SUPERSEDED_ATTRIBUTES)) {
      expect(names.has(old), old).toBe(true);
      expect(names.has(current), current).toBe(true);
    }
  });
});
