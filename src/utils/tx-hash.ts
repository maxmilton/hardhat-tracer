import { RequestArguments } from "hardhat/types";

export function getTxHash(
  request: RequestArguments,
  response: any
): string | null {
  // console.log("getTxHash", request.method, response);
  if (
    request.method === "eth_sendTransaction" ||
    request.method === "eth_sendRawTransaction"
  ) {
    if (typeof response === "string") {
      return response;
    } else if (response && typeof response === "object") {
      return response.hash;
    }
  }

  return null;
}
