import assert from "node:assert/strict";
import { test } from "node:test";
import { constructorArgs, creationProblems, expectedCreationInput } from "../tools/distributor-deployment.ts";

const OWNER = "0x70997970C51812dc3A010C7d01b50d7D74dc79C8";
const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const URD = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const CODE = "0x6080604052";

test("the constructor arguments are the owner, the timelock and an empty root and hash", () => {
  const args = constructorArgs(OWNER, 43_200);
  assert.equal(args.length, 4 * 64);
  assert.equal(args.slice(0, 64), "00000000000000000000000070997970c51812dc3a010c7d01b50d7d74dc79c8");
  assert.equal(BigInt(`0x${args.slice(64, 128)}`), 43_200n);
  assert.equal(args.slice(128), "0".repeat(128));
  assert.throws(() => constructorArgs("0x1234", 43_200), /20-byte/);
  assert.throws(() => constructorArgs(OWNER, -1), /bad timelock/);
});

test("the creation transaction must be the pinned code and arguments, sent by the deployer, creating that address", () => {
  const expectedInput = expectedCreationInput(CODE, OWNER, 43_200);
  assert.equal(expectedInput, CODE + constructorArgs(OWNER, 43_200));
  const tx = { from: DEPLOYER, to: null, input: expectedInput.toUpperCase().replace("0X", "0x") };
  const receipt = { contractAddress: URD, status: "0x1", blockNumber: "0x10" };
  const check = (over: object) =>
    creationProblems({ tx, receipt, address: URD, deployer: DEPLOYER, expectedInput, ...over });

  assert.deepEqual(check({}), []);
  // Other init code could have written storage before returning the URD's runtime code.
  assert.match(check({ tx: { ...tx, input: `${expectedInput}00` } })[0], /not the pinned URD's creation code/);
  // Another owner or timelock in the constructor arguments is caught the same way.
  assert.match(
    check({ expectedInput: expectedCreationInput(CODE, DEPLOYER, 43_200) })[0],
    /not the pinned URD's creation code/,
  );
  // A factory or a proxy deployment is a call, not a creation.
  assert.match(check({ tx: { ...tx, to: OWNER } })[0], /instead of creating a contract/);
  assert.match(check({ tx: { ...tx, from: OWNER } })[0], /was sent by/);
  assert.match(check({ receipt: { ...receipt, contractAddress: OWNER } })[0], /it created/);
  assert.match(check({ receipt: { ...receipt, status: "0x0" } })[0], /it failed/);
  assert.deepEqual(check({ tx: null }), ["the creation transaction was not found"]);
  assert.deepEqual(check({ receipt: null }), ["its receipt was not found"]);
});
