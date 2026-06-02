import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  CreateStreamParamsSchema,
  RenewParamsSchema,
  StreamFilterSchema,
  validate,
} from '../../src/utils/validation.js';
import { AssetType, VestingMode, StreamStatus, SettlementMode } from '../../src/types/stream.js';
import { ValidationError } from '../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const d = (v: Decimal.Value) => new Decimal(v);

const now = Date.now();

function validCreateParams() {
  return {
    streamId: 'stream-001',
    sender: 'alice',
    recipient: 'bob',
    totalDeposited: d('1000'),
    startTime: new Date(now + 10_000),
    endTime: new Date(now + 100_000),
    vestingMode: { mode: VestingMode.Linear },
    assetType: AssetType.GlobalCip56,
    instrumentRef: {
      depository: 'example-registrar',
      issuer: 'example-registrar',
      instrumentId: 'EX1',
      instrumentVersion: '0',
    },
    senderAccount: { owner: 'alice', accountNumber: 'sender-1' },
    recipientAccount: { owner: 'bob', accountNumber: 'recipient-1' },
    settlementMode: SettlementMode.TokenStandardCustody,
    fundingReference: 'source-allocation',
    escrowOperator: 'escrow-operator-party',
    cancellable: true,
  };
}

/** Base params for V2 custody-backed streams. */
function validCustodyCreateParams() {
  return validCreateParams();
}

function validRenewParams() {
  return {
    additionalAmount: d('500'),
    newEndTime: new Date(now + 200_000),
    holdingCid: '#holding-topup-001',
    senderAccount: { owner: 'alice', accountNumber: 'sender-1' },
  };
}

// ===========================================================================
// CreateStreamParamsSchema
// ===========================================================================

describe('CreateStreamParamsSchema', () => {
  it('accepts valid linear params', () => {
    const result = CreateStreamParamsSchema.safeParse(validCreateParams());
    expect(result.success).toBe(true);
  });

  it('accepts valid CliffLinear params', () => {
    const params = {
      ...validCreateParams(),
      vestingMode: {
        mode: VestingMode.CliffLinear,
        cliffTime: new Date(now + 50_000),
      },
    };
    const result = CreateStreamParamsSchema.safeParse(params);
    expect(result.success).toBe(true);
  });

  it('accepts valid Stepped params', () => {
    const params = {
      ...validCreateParams(),
      vestingMode: {
        mode: VestingMode.Stepped,
        stepInterval: 1_000_000, // 1s in microseconds
        amountPerStep: d('100'),
      },
    };
    const result = CreateStreamParamsSchema.safeParse(params);
    expect(result.success).toBe(true);
  });

  it('accepts valid RenewableTerm params', () => {
    const params = {
      ...validCreateParams(),
      vestingMode: {
        mode: VestingMode.RenewableTerm,
        termDuration: 90_000_000, // 90s in microseconds
      },
    };
    const result = CreateStreamParamsSchema.safeParse(params);
    expect(result.success).toBe(true);
  });

  it('rejects zero totalDeposited', () => {
    const params = { ...validCreateParams(), totalDeposited: d('0') };
    const result = CreateStreamParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
  });

  it('rejects negative totalDeposited', () => {
    const params = { ...validCreateParams(), totalDeposited: d('-100') };
    const result = CreateStreamParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
  });

  it('rejects non-Decimal totalDeposited', () => {
    const params = { ...validCreateParams(), totalDeposited: 1000 };
    const result = CreateStreamParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
  });

  it('rejects startTime >= endTime', () => {
    const params = {
      ...validCreateParams(),
      startTime: new Date(now + 100_000),
      endTime: new Date(now + 100_000),
    };
    const result = CreateStreamParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
  });

  it('rejects startTime after endTime', () => {
    const params = {
      ...validCreateParams(),
      startTime: new Date(now + 200_000),
      endTime: new Date(now + 100_000),
    };
    const result = CreateStreamParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
  });

  it('rejects sender == recipient', () => {
    const params = { ...validCreateParams(), sender: 'alice', recipient: 'alice' };
    const result = CreateStreamParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
  });

  it('rejects empty streamId', () => {
    const params = { ...validCreateParams(), streamId: '' };
    const result = CreateStreamParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
  });

  it('rejects streamId with whitespace', () => {
    const params = { ...validCreateParams(), streamId: 'stream 001' };
    const result = CreateStreamParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
  });

  it('rejects empty sender', () => {
    const params = { ...validCreateParams(), sender: '' };
    const result = CreateStreamParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
  });

  it('rejects empty recipient', () => {
    const params = { ...validCreateParams(), recipient: '' };
    const result = CreateStreamParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
  });

  it('rejects missing instrumentRef for Local CIP-56 in custody mode', () => {
    const params = {
      ...validCustodyCreateParams(),
      assetType: AssetType.LocalCip56,
      instrumentRef: undefined,
    };
    const result = CreateStreamParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
  });

  it('rejects missing instrumentRef for Global CIP-56 in custody mode', () => {
    const params = {
      ...validCustodyCreateParams(),
      assetType: AssetType.GlobalCip56,
      instrumentRef: undefined,
    };
    const result = CreateStreamParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
  });

  it('rejects non-V2 create modes', () => {
    for (const settlementMode of [
      SettlementMode.NumericLegacy,
      SettlementMode.UtilityHoldingCustody,
      SettlementMode.LocalAssetCustody,
      SettlementMode.Delegated,
    ]) {
      const params = { ...validCreateParams(), settlementMode };
      const result = CreateStreamParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    }
  });

  it('rejects instrumentRef for validator-local streams', () => {
    const params = {
      ...validCreateParams(),
      assetType: AssetType.ValidatorLocalAsset,
    };
    const result = CreateStreamParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
  });

  describe('CliffLinear cross-field validations', () => {
    it('rejects cliffTime before startTime', () => {
      const params = {
        ...validCreateParams(),
        vestingMode: {
          mode: VestingMode.CliffLinear as const,
          cliffTime: new Date(now + 5_000), // before start at now + 10_000
        },
      };
      const result = CreateStreamParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });

    it('rejects cliffTime after endTime', () => {
      const params = {
        ...validCreateParams(),
        vestingMode: {
          mode: VestingMode.CliffLinear as const,
          cliffTime: new Date(now + 200_000), // after end at now + 100_000
        },
      };
      const result = CreateStreamParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });

    it('rejects cliffTime equal to startTime', () => {
      const params = {
        ...validCreateParams(),
        vestingMode: {
          mode: VestingMode.CliffLinear as const,
          cliffTime: new Date(now + 10_000), // equal to startTime
        },
      };
      const result = CreateStreamParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });

    it('rejects cliffTime equal to endTime', () => {
      const params = {
        ...validCreateParams(),
        vestingMode: {
          mode: VestingMode.CliffLinear as const,
          cliffTime: new Date(now + 100_000), // equal to endTime
        },
      };
      const result = CreateStreamParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });
  });

  describe('Stepped field validations', () => {
    it('rejects zero stepInterval', () => {
      const params = {
        ...validCreateParams(),
        vestingMode: {
          mode: VestingMode.Stepped as const,
          stepInterval: 0,
          amountPerStep: d('100'),
        },
      };
      const result = CreateStreamParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });

    it('rejects negative stepInterval', () => {
      const params = {
        ...validCreateParams(),
        vestingMode: {
          mode: VestingMode.Stepped as const,
          stepInterval: -1000,
          amountPerStep: d('100'),
        },
      };
      const result = CreateStreamParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });

    it('rejects non-integer stepInterval', () => {
      const params = {
        ...validCreateParams(),
        vestingMode: {
          mode: VestingMode.Stepped as const,
          stepInterval: 1.5,
          amountPerStep: d('100'),
        },
      };
      const result = CreateStreamParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });

    it('rejects zero amountPerStep', () => {
      const params = {
        ...validCreateParams(),
        vestingMode: {
          mode: VestingMode.Stepped as const,
          stepInterval: 1_000_000,
          amountPerStep: d('0'),
        },
      };
      const result = CreateStreamParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });

    it('rejects negative amountPerStep', () => {
      const params = {
        ...validCreateParams(),
        vestingMode: {
          mode: VestingMode.Stepped as const,
          stepInterval: 1_000_000,
          amountPerStep: d('-50'),
        },
      };
      const result = CreateStreamParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });

    it('rejects non-Decimal amountPerStep', () => {
      const params = {
        ...validCreateParams(),
        vestingMode: {
          mode: VestingMode.Stepped as const,
          stepInterval: 1_000_000,
          amountPerStep: 100,
        },
      };
      const result = CreateStreamParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });
  });

  describe('RenewableTerm field validations', () => {
    it('rejects zero termDuration', () => {
      const params = {
        ...validCreateParams(),
        vestingMode: {
          mode: VestingMode.RenewableTerm as const,
          termDuration: 0,
        },
      };
      const result = CreateStreamParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });

    it('rejects negative termDuration', () => {
      const params = {
        ...validCreateParams(),
        vestingMode: {
          mode: VestingMode.RenewableTerm as const,
          termDuration: -1000,
        },
      };
      const result = CreateStreamParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });

    it('rejects non-integer termDuration', () => {
      const params = {
        ...validCreateParams(),
        vestingMode: {
          mode: VestingMode.RenewableTerm as const,
          termDuration: 1.5,
        },
      };
      const result = CreateStreamParamsSchema.safeParse(params);
      expect(result.success).toBe(false);
    });
  });
});

// ===========================================================================
// RenewParamsSchema
// ===========================================================================

describe('RenewParamsSchema', () => {
  it('accepts valid params', () => {
    const result = RenewParamsSchema.safeParse(validRenewParams());
    expect(result.success).toBe(true);
  });

  it('rejects empty holdingCid', () => {
    const params = { ...validRenewParams(), holdingCid: '' };
    const result = RenewParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
  });

  it('rejects zero additionalAmount', () => {
    const params = { ...validRenewParams(), additionalAmount: d('0') };
    const result = RenewParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
  });

  it('rejects past newEndTime', () => {
    const params = { ...validRenewParams(), newEndTime: new Date(now - 10_000) };
    const result = RenewParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
  });

  it('rejects empty senderAccount record', () => {
    const params = { ...validRenewParams(), senderAccount: {} };
    const result = RenewParamsSchema.safeParse(params);
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// StreamFilterSchema
// ===========================================================================

describe('StreamFilterSchema', () => {
  it('accepts empty filter', () => {
    const result = StreamFilterSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts filter with all fields', () => {
    const result = StreamFilterSchema.safeParse({
      sender: 'alice',
      recipient: 'bob',
      status: StreamStatus.Active,
      vestingMode: VestingMode.Linear,
    });
    expect(result.success).toBe(true);
  });
});

// ===========================================================================
// validate() helper
// ===========================================================================

describe('validate()', () => {
  it('returns parsed value on success', () => {
    const params = validCreateParams();
    const parsed = validate(CreateStreamParamsSchema, params);
    expect(parsed.streamId).toBe('stream-001');
  });

  it('throws ValidationError on failure', () => {
    const bad = { ...validCreateParams(), streamId: '' };
    expect(() => validate(CreateStreamParamsSchema, bad)).toThrow(ValidationError);
  });

  it('ValidationError includes field name', () => {
    const bad = { ...validCreateParams(), sender: '', recipient: '' };
    try {
      validate(CreateStreamParamsSchema, bad);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.code).toBe('VALIDATION_ERROR');
      expect(ve.field).toBeDefined();
      expect(ve.details).toBeDefined();
    }
  });

  it('throws ValidationError for cross-field violations', () => {
    const bad = {
      ...validCreateParams(),
      sender: 'alice',
      recipient: 'alice',
    };
    expect(() => validate(CreateStreamParamsSchema, bad)).toThrow(ValidationError);
  });
});
