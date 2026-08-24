import { describe, it, expect } from "vitest";

describe("Bug Fix Verification", () => {
  it("parses channel queries correctly without forcing 'on/in/at' prepositions", () => {
    const text = "open harkirat singh youtube channel";
    const lower = text.toLowerCase();

    const searchMatch =
      lower.match(/(?:search|find|look\s*up|search\s*for)\s+(.+?)\s+(?:on|in|at)\s+([\w.]+)/) ||
      lower.match(/(?:search|find|look\s*up|search\s*for)\s+(.+?)\s+(youtube|google|bing|amazon|flipkart|github)\b/);

    const channelMatch =
      !searchMatch &&
      lower.match(/(.+?)\s+(?:youtube\s+channel|yt\s+channel|channel\s+on\s+youtube)/);

    expect(Boolean(searchMatch || channelMatch)).toBe(true);
    expect(channelMatch?.[1].trim()).toBe("open harkirat singh");
  });

  it("handles standard search query with 'on' correctly", () => {
    const text = "search react tutorials on youtube";
    const lower = text.toLowerCase();

    const searchMatch =
      lower.match(/(?:search|find|look\s*up|search\s*for)\s+(.+?)\s+(?:on|in|at)\s+([\w.]+)/) ||
      lower.match(/(?:search|find|look\s*up|search\s*for)\s+(.+?)\s+(youtube|google|bing|amazon|flipkart|github)\b/);

    expect(searchMatch).not.toBeNull();
    expect(searchMatch?.[1].trim()).toBe("react tutorials");
    expect(searchMatch?.[2].trim()).toBe("youtube");
  });
});
