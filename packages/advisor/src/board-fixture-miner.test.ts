import { describe, expect, it } from "vitest";
import { compactText } from "../../../scripts/select-board-fixtures.js";

describe("board fixture miner", () => {
  it("includes tool-call arguments when compacting raw session rows", () => {
    const text = compactText({
      raw: {
        message: {
          content: [
            {
              type: "toolCall",
              name: "bash",
              arguments: { command: "npm test packages/advisor/src/board.test.ts" },
            },
          ],
        },
      },
    });

    expect(text).toContain("npm test packages/advisor/src/board.test.ts");
  });
});
