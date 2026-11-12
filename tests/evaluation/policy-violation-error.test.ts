import { describe, expect, it } from 'vitest';
import { PolicyViolationError } from '../../src/evaluation/engine';

describe('PolicyViolationError', () => {
  it('has no policy and empty details when none are given', () => {
    const error = new PolicyViolationError('blocked');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PolicyViolationError');
    expect(error.message).toBe('blocked');
    expect(error.policy).toBeUndefined();
    expect(error.details).toEqual({});
  });

  it('keeps the policy and details it was given', () => {
    const error = new PolicyViolationError('blocked', { policy: 'pii', details: { entities: 2 } });
    expect(error.policy).toBe('pii');
    expect(error.details).toEqual({ entities: 2 });
  });

  it('defaults the details when only a policy is given', () => {
    expect(new PolicyViolationError('blocked', { policy: 'toxicity' }).details).toEqual({});
  });
});
