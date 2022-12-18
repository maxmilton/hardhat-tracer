import { BackwardsCompatibilityProviderAdapter } from "hardhat/internal/core/providers/backwards-compatibility";
import { ProviderWrapper } from "hardhat/internal/core/providers/wrapper";
import { TracerDependencies } from "./types";

import {
  EIP1193Provider,
  HardhatRuntimeEnvironment,
  RequestArguments,
} from "hardhat/types";

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
    let result;
    let error: any;
    // console.log("wrapper->args.method", args.method);

    try {
      result = await this.dependencies.provider.send(
        args.method,
        args.params as any[]
      );
    } catch (_error) {
      error = _error;
    }

    // TODO take decision whether to print or not
    // if estimateGas fails then print it
    // sendTx should be printing it regardless of success or failure
    const isSendTransaction = args.method === "eth_sendTransaction";
    const isEthCall = args.method === "eth_call";
    const isEstimateGas = args.method === "eth_estimateGas";

    const isSendTransactionFailed = isSendTransaction && !!error;
    const isEthCallFailed = isEthCall && !!error;
    const isEstimateGasFailed = isEstimateGas && !!error;

    let shouldPrint: boolean;

    switch (this.dependencies.tracerEnv.verbosity) {
      case 0:
        shouldPrint = false;
        break;
      case 1:
      case 2:
        shouldPrint =
          isSendTransactionFailed ||
          isEthCallFailed ||
          isEstimateGasFailed ||
          (!!this.dependencies.tracerEnv.printNext &&
            (isSendTransaction || isEthCall || isEstimateGas));
        break;
      case 3:
      case 4:
        shouldPrint = isSendTransaction || isEthCall || isEstimateGas;
        break;
      default:
        throw new Error(
          "[hardhat-tracer]: Invalid verbosity value: " +
            this.dependencies.tracerEnv.verbosity
        );
    }

    if (this.dependencies.tracerEnv.enabled && shouldPrint) {
      if (this.dependencies.tracerEnv.ignoreNext) {
        this.dependencies.tracerEnv.ignoreNext = false;
      } else {
        this.dependencies.tracerEnv.printNext = false;
        await this.dependencies.tracerEnv.recorder?.previousTraces?.[
          this.dependencies.tracerEnv.recorder?.previousTraces.length - 1
        ]?.print?.(this.dependencies);
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
export function wrapHardhatProvider(hre: HardhatRuntimeEnvironment) {
  const tracerProvider = new TracerWrapper({
    artifacts: hre.artifacts,
    tracerEnv: hre.tracer,
    provider: hre.network.provider,
  });
  const compatibleProvider = new BackwardsCompatibilityProviderAdapter(
    tracerProvider
  );
  hre.network.provider = compatibleProvider;

  // ensure env is present
  // hre.tracer = hre.tracer ?? getTracerEnvFromUserInput(hre.tracer);
}
