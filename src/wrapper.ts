import { BackwardsCompatibilityProviderAdapter } from "hardhat/internal/core/providers/backwards-compatibility";
import { ProviderWrapper } from "hardhat/internal/core/providers/wrapper";
import {
  EIP1193Provider,
  EthereumProvider,
  HardhatRuntimeEnvironment,
  RequestArguments,
} from "hardhat/types";
import createDebug from "debug";

import { print } from "./print";
import { ProviderLike, TracerDependencies } from "./types";
import { getTxHash } from "./utils/tx-hash";

const debug = createDebug("hardhat-tracer:wrapper");

/**
 * Wrapped provider which extends requests
 */
class TracerWrapper extends ProviderWrapper {
  public dependencies: TracerDependencies;
  public txPrinted: { [key: string]: boolean } = {};

  constructor(dependencies: TracerDependencies) {
    super((dependencies.provider as unknown) as EIP1193Provider);
    this.dependencies = dependencies;
  }

  public async request(args: RequestArguments): Promise<unknown> {
    debug(`wrapped request ${args.method}`);
    let result;
    let error: any;
    // console.log("wrapper->args.method", args.method);

    // take decision whether to print last trace or not
    const isSendTransaction = args.method === "eth_sendTransaction";
    const isSendRawTransaction = args.method === "eth_sendRawTransaction";
    const isEthCall = args.method === "eth_call";
    const isEstimateGas = args.method === "eth_estimateGas";
    const isDebugTraceTransaction = args.method === "debug_traceTransaction";

    const shouldTrace =
      this.dependencies.tracerEnv.enabled &&
      (isSendTransaction ||
        isSendRawTransaction ||
        isEthCall ||
        isEstimateGas ||
        isDebugTraceTransaction) &&
      (!!this.dependencies.tracerEnv.printNext ||
        this.dependencies.tracerEnv.verbosity > 0);

    if (shouldTrace) {
      await this.dependencies.tracerEnv.switch!.enable();
      debug("Tracing switch enabled");
    }
    try {
      result = await this.dependencies.provider.send(
        args.method,
        args.params as any[]
      );
    } catch (_error) {
      error = _error;
    }
    if (shouldTrace) {
      await this.dependencies.tracerEnv.switch!.disable();
      debug("Tracing switch disabled");
    }

    const isSendTransactionFailed = isSendTransaction && !!error;
    const isSendRawTransactionFailed = isSendRawTransaction && !!error;
    const isEthCallFailed = isEthCall && !!error;
    const isEstimateGasFailed = isEstimateGas && !!error;

    let shouldPrint: boolean;

    switch (this.dependencies.tracerEnv.verbosity) {
      case 0:
        shouldPrint = !!this.dependencies.tracerEnv.printNext;
        break;
      case 1:
      case 2:
        shouldPrint =
          isSendTransactionFailed ||
          isSendRawTransactionFailed ||
          isEthCallFailed ||
          isEstimateGasFailed ||
          (!!this.dependencies.tracerEnv.printNext &&
            (isSendTransaction ||
              isSendRawTransaction ||
              isEthCall ||
              isEstimateGasFailed ||
              isDebugTraceTransaction));
        break;
      case 3:
      case 4:
        shouldPrint =
          isSendTransaction ||
          isSendRawTransaction ||
          isEthCall ||
          isEstimateGasFailed ||
          isDebugTraceTransaction;
        break;
      default:
        throw new Error(
          "[hardhat-tracer]: Invalid verbosity value: " +
            this.dependencies.tracerEnv.verbosity
        );
    }
    debug(
      `shouldPrint=${shouldPrint}, tracer.enabled: ${this.dependencies.tracerEnv.enabled}, tracer.ignoreNext=${this.dependencies.tracerEnv.ignoreNext}, tracer.printNext=${this.dependencies.tracerEnv.printNext}`
    );
    if (this.dependencies.tracerEnv.enabled && shouldPrint) {
      if (this.dependencies.tracerEnv.ignoreNext) {
        this.dependencies.tracerEnv.ignoreNext = false;
      } else {
        const lastTrace = this.dependencies.tracerEnv.lastTrace();
        if (lastTrace) {
          const hash = getTxHash(args, result);
          if (hash) {
            this.dependencies.tracerEnv.recorder?.storeLastTrace(hash);
            lastTrace.hash = hash;
          }

          // TODO first check if this trace is what we want to print, i.e. tally the transaction hash.
          this.dependencies.tracerEnv.printNext = false;
          await print(lastTrace, this.dependencies);
        } else {
          console.warn(
            `Hardhat Tracer wanted to print trace, but lastTrace is undefined. 
This only works on hardhat network, if you are running your script over RPC provider then VM data is not available.
If you think this is a bug please create issue at https://github.com/zemse/hardhat-tracer`
          );
        }
      }
    }

    if (error) {
      throw error;
    }
    return result;
  }
}

/**
 * Add hardhat-tracer to your environment
 * @param hre: HardhatRuntimeEnvironment - required to get access to contract artifacts and tracer env
 */
export function wrapTracer(
  hre: HardhatRuntimeEnvironment,
  provider: ProviderLike
): EthereumProvider {
  // do not wrap if already wrapped
  if (isTracerAlreadyWrappedInHreProvider(hre)) {
    debug("hre provider is already wrapped with TracerWrapper");
    return hre.network.provider;
  }
  debug("Wrapping hre provider with TracerWrapper");
  return wrapProvider(
    hre,
    new TracerWrapper({
      artifacts: hre.artifacts,
      tracerEnv: hre.tracer,
      provider: provider ?? hre.network.provider,
    })
  );
}

export function wrapProvider(
  hre: HardhatRuntimeEnvironment,
  wrapper: ProviderWrapper
): EthereumProvider {
  const compatibleProvider = new BackwardsCompatibilityProviderAdapter(wrapper);
  hre.network.provider = compatibleProvider;
  return hre.network.provider;
}

export function isTracerAlreadyWrappedInHreProvider(
  hre: HardhatRuntimeEnvironment
) {
  const maxLoopIterations = 1024;
  let currentLoopIterations = 0;

  let provider: any = hre.network.provider;
  while (provider !== undefined) {
    if (provider instanceof TracerWrapper) {
      return true;
    }

    // move down the chain
    try {
      provider = provider._wrapped;
    } catch {
      // throws error when we reach the og provider
      // HardhatError: HH21: You tried to access an uninitialized provider. To
      // initialize the provider, make sure you first call `.init()` or any
      // method that hits a node like request, send or sendAsync.
      return false;
    }

    // Just throw if we ever end up in (what seems to be) an infinite loop.
    currentLoopIterations += 1;
    if (currentLoopIterations > maxLoopIterations) {
      return false;
    }
  }

  return false;
}
