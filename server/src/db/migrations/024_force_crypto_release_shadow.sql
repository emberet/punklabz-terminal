-- Correct the crypto custody release posture. Migration 023 disabled signing
-- authority but left the previous mode and capital stage visible. That made a
-- halted deployment still present itself as a canary. A safety release must
-- erase both authority and the appearance of authority.

UPDATE live_config
SET mode = 'shadow',
    halted = 1,
    halt_reason = 'crypto-only custody release installed; fresh policies, funding proof, route proof and reconciliation required',
    capital_stage = 0,
    execution_phase = 'shadow',
    autonomy_enabled = 0,
    full_market_autonomy = 0,
    authorized_capital_usdg = NULL,
    authorized_capital_set_at = NULL,
    expected_signer_policy_hash = NULL,
    observed_signer_policy_hash = NULL,
    executable_scope = 'CRYPTO_CORE',
    updated_at = strftime('%s','now') * 1000
WHERE id = 1;
