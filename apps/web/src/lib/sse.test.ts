import { describe, expect, it } from "vitest";
import { parseSseFrames } from "./sse";

describe("parseSseFrames", () => {
  it("parses split frames and keeps an incomplete frame", () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const remainder = parseSseFrames('event: token\ndata: {"text":"you"}\n\nevent: token\ndata:', (event, payload) => {
      events.push([event, payload]);
    });

    expect(events).toEqual([["token", { text: "you" }]]);
    expect(remainder).toBe("event: token\ndata:");
  });

  it("ignores malformed JSON without stopping later events", () => {
    const events: string[] = [];
    parseSseFrames('event: broken\ndata: nope\n\nevent: done\ndata: {}\n\n', (event) => events.push(event), true);
    expect(events).toEqual(["done"]);
  });
});
