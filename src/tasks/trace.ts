import createDebug from "debug";
import { ethers } from "ethers";
import { task } from "hardhat/config";

import { print } from "../print";
import { addCliParams, applyCliArgsToTracer } from "../utils";
import { HttpNetworkConfig, HttpNetworkUserConfig } from "hardhat/types";
import { addRecorder } from "../extend/hre";
import { TransactionTrace } from "../transaction-trace";
import { createHardhatNetworkProvider } from "hardhat/internal/hardhat-network/provider/provider";
const debug = createDebug("hardhat-tracer:tasks:trace");

// Use-cases:
// 1. Can be used as a subtask
// 2. Trace a tx on a local hardhat node that supports `tracer_getTrace` rpc.
// 3. Trace a tx that is present on an external archive node using --rpc flag to specify the URL.
addCliParams(task("trace", "Traces a transaction hash"))
  .addParam("hash", "transaction hash to view trace of")
  .addOptionalParam("rpc", "external archive node")
  .setAction(async (args, hre, runSuper) => {
    applyCliArgsToTracer(args, hre);

    if (!args.nocompile) {
      await hre.run("compile");
    }

    debug("fetch tx from current provider");
    const tx = await hre.network.provider.send("eth_getTransactionByHash", [
      args.hash,
    ]);

    // we cannot use `_setVerboseTracing` outside of hardhat
    if (tx && hre.network.name === "hardhat") {
      await hre.tracer.switch!.enable();
      await hre.network.provider.send("debug_traceTransaction", [args.hash]);
      await hre.tracer.switch!.disable();

      let lastTrace = hre.tracer.lastTrace();
      if (lastTrace === undefined) {
        throw new Error(
          "[hardhat-tracer]: No trace available on current provider"
        );
      }
      await print(lastTrace, {
        artifacts: hre.artifacts,
        tracerEnv: hre.tracer,
        provider: hre.ethers.provider,
      });
    }

    debug("tx not on current hardhat provider");

    // get rpc based on --rpc or --network flags or use mainnet fork url
    let rpc: string | null = null;
    if (args.rpc !== undefined) {
      rpc = args.rpc;
    } else if (hre.network.name !== "hardhat") {
      rpc = (hre.network.config as HttpNetworkConfig).url;
    } else {
      const mainnetForkUrl = (hre.network.config as any).forking?.url;
      if (mainnetForkUrl) {
        rpc = mainnetForkUrl;
      }
    }

    debug(`rpc=${rpc}`);

    if (rpc === null) {
      throw new Error(
        "[hardhat-tracer]: rpc url not provided, please either use --network <network-name> or --rpc <rpc-url>"
      );
    }

    debug("fetch tx from rpc %s", args.rpc);
    const provider = new ethers.providers.StaticJsonRpcProvider(args.rpc);

    const txFromRpc = await provider.getTransaction(args.hash);
    if (txFromRpc == null) {
      throw new Error(
        "[hardhat-tracer]: Transaction not found on rpc. Are you sure the transaction is confirmed on this network?"
      );
    }

    if (!txFromRpc.blockNumber) {
      throw new Error(
        "[hardhat-tracer]: Transaction is not mined yet, please wait for it to be mined"
      );
    }

    // if rpc is a hardhat node that supports tracer_getTrace method
    let txTrace: TransactionTrace | null = null;
    try {
      const result = await provider.send("tracer_getTrace", [args.hash]);
      if (result) {
        txTrace = result;
      }
    } catch {}
    if (txTrace) {
      await print(txTrace, {
        artifacts: hre.artifacts,
        tracerEnv: hre.tracer,
        provider: hre.ethers.provider,
      });
      return;
    }

    // TODO find out if there is a way to switch network to hardhat
    // We also need the hooks to be added to the EdrWrapper and it doesn't seem easy
    if (hre.network.name !== "hardhat") {
      throw new Error(
        "[hardhat-tracer]: Please use --rpc flag and do not pass a --network flag for this one"
      );
    }

    // this is an archive node, we need to fork mainnet and use debug tt
    console.warn("Activating mainnet fork at block", txFromRpc.blockNumber);
    debug("Activating mainnet fork hardhat reset");

    await hre.network.provider.send("hardhat_reset", [
      {
        forking: {
          jsonRpcUrl: rpc,
          blockNumber: txFromRpc.blockNumber,
        },
      },
    ]);
    addRecorder(hre);

    debug("enabling switch");
    await hre.tracer.switch!.enable();
    await hre.network.provider.send("debug_traceTransaction", [args.hash]);
    await hre.tracer.switch!.disable();

    let trace = hre.tracer.lastTrace();
    if (trace === undefined) {
      throw new Error(
        "[hardhat-tracer]: No trace available on the mainnet forked provider"
      );
    }
    debug("printing trace");
    await print(trace, {
      artifacts: hre.artifacts,
      tracerEnv: hre.tracer,
      provider: hre.ethers.provider,
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));
    return;
  });
