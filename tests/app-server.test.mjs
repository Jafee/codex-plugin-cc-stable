import test from "node:test";
import assert from "node:assert/strict";

import { resolveTimeoutMs } from "../plugins/codex/scripts/lib/app-server.mjs";

const ENV = "CODEX_TEST_RESOLVE_TIMEOUT_MS";
const TIMER_CEILING_MS = 2_147_483_647;

function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, ENV);
  const previous = process.env[ENV];
  if (value === undefined) {
    delete process.env[ENV];
  } else {
    process.env[ENV] = value;
  }
  try {
    return fn();
  } finally {
    if (had) {
      process.env[ENV] = previous;
    } else {
      delete process.env[ENV];
    }
  }
}

test("resolveTimeoutMs falls back to the default for unset, empty, garbage, negative, and non-finite values", () => {
  for (const value of [undefined, "", "abc", "-1", "-1000", "NaN", "Infinity", "-Infinity"]) {
    withEnv(value, () => {
      assert.equal(resolveTimeoutMs(ENV, 1234), 1234, `expected default for ${JSON.stringify(value)}`);
    });
  }
});

test("resolveTimeoutMs clamps absurdly large values to the Node timer ceiling (no immediate-fire overflow)", () => {
  withEnv("99999999999999", () => assert.equal(resolveTimeoutMs(ENV, 1234), TIMER_CEILING_MS));
  withEnv("1e30", () => assert.equal(resolveTimeoutMs(ENV, 1234), TIMER_CEILING_MS));
  // Exactly at the ceiling is preserved.
  withEnv(String(TIMER_CEILING_MS), () => assert.equal(resolveTimeoutMs(ENV, 1234), TIMER_CEILING_MS));
});

test("resolveTimeoutMs passes through valid in-range values", () => {
  withEnv("500", () => assert.equal(resolveTimeoutMs(ENV, 1234), 500));
  withEnv("30000", () => assert.equal(resolveTimeoutMs(ENV, 1234), 30000));
  withEnv("250.5", () => assert.equal(resolveTimeoutMs(ENV, 1234), 250.5));
});

test("resolveTimeoutMs maps 0 to the default, but allowDisable preserves an explicit 0", () => {
  withEnv("0", () => assert.equal(resolveTimeoutMs(ENV, 1234), 1234));
  withEnv("0", () => assert.equal(resolveTimeoutMs(ENV, 1234, { allowDisable: true }), 0));
  // A non-zero value is unaffected by allowDisable.
  withEnv("500", () => assert.equal(resolveTimeoutMs(ENV, 1234, { allowDisable: true }), 500));
});
