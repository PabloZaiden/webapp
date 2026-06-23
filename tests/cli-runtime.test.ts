import { describe, expect, test } from "bun:test";
import { dispatchCliCommand, hasFlag, printCliResult, readOption } from "@pablozaiden/webapp/cli";

describe("CLI runtime helpers", () => {
  test("reads flags and options", () => {
    const args = ["serve", "--port=3001", "--verbose"];

    expect(readOption(args, ["--port"])).toBe("3001");
    expect(hasFlag(args, ["--verbose"])).toBe(true);
  });

  test("dispatches commands and prints results", async () => {
    const result = await dispatchCliCommand({
      args: ["version"],
      help: "usage",
      commands: {
        version: () => ({ exitCode: 0, output: "1.2.3" }),
      },
    });
    const messages: string[] = [];
    const errors: string[] = [];

    expect(printCliResult(result, { log: (message) => messages.push(String(message)), error: (message) => errors.push(String(message)) })).toBe(0);
    expect(messages).toEqual(["1.2.3"]);
    expect(errors).toEqual([]);
  });
});
