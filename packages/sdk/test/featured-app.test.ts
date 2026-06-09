import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import {
  buildEmission,
  disabledFeaturedApp,
  enabledFeaturedApp,
  estimateRewardCapUsd,
  type FeaturedAppConfig,
} from '../src/featured-app.js';

describe('featured-app', () => {
  describe('config constructors', () => {
    it('disabledFeaturedApp returns an emission-off config', () => {
      const cfg: FeaturedAppConfig = disabledFeaturedApp();
      expect(cfg.enabled).toBe(false);
      expect(cfg.featuredAppKey).toBe('');
    });

    it('enabledFeaturedApp returns an emission-on config with the supplied key', () => {
      const cfg = enabledFeaturedApp('my-app-key');
      expect(cfg.enabled).toBe(true);
      expect(cfg.featuredAppKey).toBe('my-app-key');
    });

    it('enabledFeaturedApp rejects empty keys', () => {
      expect(() => enabledFeaturedApp('')).toThrow(/non-empty/);
      expect(() => enabledFeaturedApp('   ')).toThrow(/non-empty/);
    });
  });

  describe('buildEmission', () => {
    it('returns undefined when config is disabled', () => {
      const result = buildEmission(
        disabledFeaturedApp(),
        'withdraw',
        '1.0',
        'stream-1',
        'Alice::1220...',
      );
      expect(result).toBeUndefined();
    });

    it('returns a populated emission when config is enabled', () => {
      const cfg = enabledFeaturedApp('key-A');
      const result = buildEmission(cfg, 'create', '10.5', 'stream-1', 'Alice::1220...');
      expect(result).toBeDefined();
      expect(result?.featuredAppKey).toBe('key-A');
      expect(result?.activityType).toBe('create');
      expect(result?.amount.toString()).toBe('10.5');
      expect(result?.streamId).toBe('stream-1');
      expect(result?.participant).toBe('Alice::1220...');
      expect(result?.meta).toBeUndefined();
    });

    it('includes meta when supplied', () => {
      const cfg = enabledFeaturedApp('key-A');
      const result = buildEmission(
        cfg,
        'milestoneConfirm',
        new Decimal('25000'),
        'milestone-001',
        'ProgramAdmin::1220...',
        'milestone-mvp-shipped',
      );
      expect(result?.meta).toBe('milestone-mvp-shipped');
    });
  });

  describe('estimateRewardCapUsd', () => {
    // We must not bake a fixed reward number into the SDK — every
    // reward projection must require an explicit, caller-supplied cap
    // that the caller has verified against the currently active network
    // reward regime.

    it('returns undefined when no rewardCapUsd is supplied', () => {
      expect(estimateRewardCapUsd('withdraw')).toBeUndefined();
      expect(estimateRewardCapUsd('withdraw', {})).toBeUndefined();
      expect(estimateRewardCapUsd('create', { rewardCapUsd: undefined })).toBeUndefined();
    });

    it('returns the caller-supplied cap as a Decimal', () => {
      const result = estimateRewardCapUsd('withdraw', { rewardCapUsd: '1.25' });
      expect(result).toBeInstanceOf(Decimal);
      expect(result?.toString()).toBe('1.25');
    });

    it('accepts cap as a Decimal directly', () => {
      const cap = new Decimal('0.75');
      const result = estimateRewardCapUsd('topUp', { rewardCapUsd: cap });
      expect(result?.equals(cap)).toBe(true);
    });

    it('accepts cap as a number', () => {
      const result = estimateRewardCapUsd('create', { rewardCapUsd: 1.5 });
      expect(result?.toString()).toBe('1.5');
    });

    it('treats explicit zero as a valid cap, not as missing', () => {
      const result = estimateRewardCapUsd('cancel', { rewardCapUsd: 0 });
      expect(result).toBeInstanceOf(Decimal);
      expect(result?.isZero()).toBe(true);
    });
  });
});
