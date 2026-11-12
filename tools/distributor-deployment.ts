#!/usr/bin/env node
// Records and re-checks a deployment of the rewards distributor. Used by sh/migrate-distributor.sh
// and sh/verify-distributor.sh, which load the settings (migrations/envs/<env>/distributor.env)
// into the environment first.
//
//   node tools/distributor-deployment.ts record <env>     forge's broadcast record -> deployments/<env>/distributor.json
//   node tools/distributor-deployment.ts verify <env>     the creation transaction against the pinned URD's creation code
//   node tools/distributor-deployment.ts address <env>    prints the recorded address
//   node tools/distributor-deployment.ts deployer <env>   prints the recorded deployer

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAddress } from "../src/lib/accounts.ts";
import { messageOf, readJson, toJson, writeText } from "../src/lib/io.ts";
import { makeRpc } from "../src/lib/rpc.ts";
import { checkChainId } from "../src/snapshot.ts";
import type { Config, Rpc } from "../src/types.ts";

const STEP = "001-deploy-distributor";
const ZERO_WORD = "0".repeat(64);

// deployments/<env>/distributor.json. Written once for prod: it is the record of what was deployed.
export interface DistributorDeployment {
  migration: "distributor";
  environment: string;
  chainId: number;
  // the commit of Morpho's URD the bytecode was built from
  urdCommit: string;
  steps: [
    {
      name: typeof STEP;
      status: "completed";
      output: {
        address: string;
        deployTxHash: string;
        block: number;
        deployer: string;
        // the constructor's arguments (its root and IPFS hash are zero)
        initialOwner: string;
        timelock: number;
        // the settings it was deployed with
        owner: string;
        updater: string | null;
      };
    },
  ];
}

// What the node returns for the creation transaction and its receipt, as far as they are checked.
export interface CreationTx {
  from?: string;
  to?: string | null;
  input?: string;
}
export interface CreationReceipt {
  contractAddress?: string | null;
  status?: string;
  blockNumber?: string;
}

// abi.encode(address initialOwner, uint256 initialTimelock, bytes32 initialRoot, bytes32 initialIpfsHash)
// with an empty root and hash, without the 0x.
export function constructorArgs(initialOwner: string, timelock: number): string {
  if (!Number.isSafeInteger(timelock) || timelock < 0) throw new Error(`bad timelock ${timelock}`);
  const owner = normalizeAddress(initialOwner).slice(2).padStart(64, "0");
  return owner + timelock.toString(16).padStart(64, "0") + ZERO_WORD + ZERO_WORD;
}

export function expectedCreationInput(creationCode: string, initialOwner: string, timelock: number): string {
  if (!/^0x([0-9a-fA-F]{2})+$/.test(creationCode)) throw new Error("the creation code is not hex");
  return (creationCode + constructorArgs(initialOwner, timelock)).toLowerCase();
}

// Code with the right bytes can still come from init code that wrote other storage first. The
// creation transaction rules that out: it must create the contract directly, from the deployer,
// with exactly the pinned URD's creation code and the expected constructor arguments.
export function creationProblems({
  tx,
  receipt,
  address,
  deployer,
  expectedInput,
}: {
  tx: CreationTx | null;
  receipt: CreationReceipt | null;
  address: string;
  deployer: string;
  expectedInput: string;
}): string[] {
  const problems: string[] = [];
  if (!tx) return ["the creation transaction was not found"];
  if (tx.to !== null && tx.to !== undefined) problems.push(`it calls ${tx.to} instead of creating a contract`);
  if (tx.from?.toLowerCase() !== deployer.toLowerCase()) problems.push(`it was sent by ${tx.from}, not ${deployer}`);
  if (tx.input?.toLowerCase() !== expectedInput) {
    problems.push("its input is not the pinned URD's creation code with the expected constructor arguments");
  }
  if (!receipt) return [...problems, "its receipt was not found"];
  if (receipt.status !== "0x1") problems.push(`it failed (status ${receipt.status})`);
  if (receipt.contractAddress?.toLowerCase() !== address.toLowerCase()) {
    problems.push(`it created ${receipt.contractAddress}, not ${address}`);
  }
  return problems;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const statePath = (env: string): string => join(root, "deployments", env, "distributor.json");

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (migrations/envs/<env>/distributor.env)`);
  return value;
}

function loadState(env: string): DistributorDeployment {
  const path = statePath(env);
  if (!existsSync(path)) throw new Error(`no deployment recorded for '${env}': ${path} is missing`);
  return readJson<DistributorDeployment>(path);
}

// The pinned URD's creation code, from the artifact forge has just built.
function creationCode(): string {
  const artifact = join(
    root,
    "contracts",
    "out",
    "UniversalRewardsDistributor.sol",
    "UniversalRewardsDistributor.json",
  );
  if (!existsSync(artifact)) throw new Error(`${artifact} is missing; build the contracts with forge first`);
  return readJson<{ bytecode: { object: string } }>(artifact).bytecode.object;
}

async function connect(): Promise<{ rpc: Rpc; config: Config }> {
  const config = readJson<Config>(join(root, "config", "mainnet.json"));
  const rpc = makeRpc(need("RPC_HYDRATION"), { batchSize: config.rpcBatchSize });
  await checkChainId(rpc, config);
  return { rpc, config };
}

async function checkCreation(rpc: Rpc, state: DistributorDeployment): Promise<CreationReceipt> {
  const o = state.steps[0].output;
  const tx = (await rpc.call("eth_getTransactionByHash", [o.deployTxHash])) as CreationTx | null;
  const receipt = (await rpc.call("eth_getTransactionReceipt", [o.deployTxHash])) as CreationReceipt | null;
  const problems = creationProblems({
    tx,
    receipt,
    address: o.address,
    deployer: o.deployer,
    expectedInput: expectedCreationInput(creationCode(), o.initialOwner, o.timelock),
  });
  if (problems.length > 0 || !receipt) {
    throw new Error(`creation transaction ${o.deployTxHash}: ${problems.join("; ")}. Do not fund this distributor`);
  }
  return receipt;
}

async function record(env: string): Promise<void> {
  const { rpc, config } = await connect();
  const owner = normalizeAddress(need("URD_OWNER"));
  const updater = process.env.URD_UPDATER ? normalizeAddress(process.env.URD_UPDATER) : null;
  const timelock = Number(process.env.URD_TIMELOCK || 43_200);

  const broadcast = join(
    root,
    "contracts",
    "broadcast",
    "DeployRewardsDistributor.s.sol",
    String(config.chainId),
    "run-latest.json",
  );
  if (!existsSync(broadcast)) throw new Error(`${broadcast} is missing; the deployment was not broadcast`);
  const sent = readJson<{
    transactions: { hash: string; transactionType: string; contractAddress?: string | null }[];
  }>(broadcast).transactions;
  const creations = sent.filter((t) => t.transactionType === "CREATE");
  if (creations.length !== 1 || !creations[0].contractAddress) {
    throw new Error(`${broadcast} holds ${creations.length} contract creations, expected one`);
  }
  const deployTxHash = creations[0].hash;
  const tx = (await rpc.call("eth_getTransactionByHash", [deployTxHash])) as CreationTx | null;
  if (!tx?.from) throw new Error(`the node does not know the creation transaction ${deployTxHash}`);
  const deployer = normalizeAddress(tx.from);

  const state: DistributorDeployment = {
    migration: "distributor",
    environment: env,
    chainId: config.chainId,
    urdCommit: execFileSync(
      "git",
      ["-C", join(root, "contracts", "lib", "universal-rewards-distributor"), "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim(),
    steps: [
      {
        name: STEP,
        status: "completed",
        output: {
          address: normalizeAddress(creations[0].contractAddress),
          deployTxHash,
          block: 0,
          deployer,
          // With an updater the deployer owns the URD first and hands it over (three transactions).
          initialOwner: updater ? deployer : owner,
          timelock,
          owner,
          updater,
        },
      },
    ],
  };
  // Nothing is recorded for a deployment whose creation transaction does not check out.
  const receipt = await checkCreation(rpc, state);
  state.steps[0].output.block = Number(BigInt(receipt.blockNumber ?? "0x0"));
  writeText(statePath(env), toJson(state));
  console.log(`distributor ${state.steps[0].output.address} recorded in ${statePath(env)}`);
}

async function main(): Promise<void> {
  const [command, env] = process.argv.slice(2);
  if (!command || !env) throw new Error("usage: distributor-deployment.ts <record|verify|address|deployer> <env>");
  if (!/^[a-z0-9-]+$/.test(env)) throw new Error(`bad environment name ${env}`);
  if (command === "record") return record(env);
  const state = loadState(env);
  const output = state.steps[0].output;
  if (command === "address") return console.log(output.address);
  if (command === "deployer") return console.log(output.deployer);
  if (command === "verify") {
    const { rpc } = await connect();
    await checkCreation(rpc, state);
    console.log(
      `distributor ${output.address}: created in block ${output.block} by the pinned URD's constructor ` +
        `(owner ${output.initialOwner}, timelock ${output.timelock} s)`,
    );
    return;
  }
  throw new Error(`unknown command ${command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`distributor-deployment: ${messageOf(error)}`);
    process.exit(1);
  });
}
