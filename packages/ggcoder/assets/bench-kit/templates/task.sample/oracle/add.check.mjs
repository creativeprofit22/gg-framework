// Hidden checks for the sample task. Never copied into the agent's workspace;
// the tests gate runs them on a copy after the agent finishes.
import assert from "node:assert/strict";
import { test } from "node:test";

import { add } from "../src/add.mjs";
import { sub } from "../src/sub.mjs";

test("add handles positive numbers", () => assert.equal(add(2, 3), 5));
test("add handles a negative second number", () => assert.equal(add(2, -3), -1));
test("sub subtracts", () => assert.equal(sub(5, 3), 2));
