import { describe, expect, it } from "vitest";
import { parseFeed } from "../src/modules/sources/feedParser.js";
import { computeNextCheckAt } from "../src/modules/sources/sourceScanCadence.js";

describe("source feed parser", () => {
  it("parses RSS items into normalized feed entries", () => {
    const items = parseFeed(
      `<?xml version="1.0"?>
       <rss version="2.0">
         <channel>
           <item>
             <title>Release notes</title>
             <link>https://example.test/releases/1</link>
             <guid>guid-1</guid>
             <pubDate>Tue, 30 Jun 2026 09:00:00 GMT</pubDate>
             <description><![CDATA[<p>Important changes shipped today.</p>]]></description>
             <dc:creator>Ada</dc:creator>
           </item>
         </channel>
       </rss>`,
      "rss",
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Release notes",
      url: "https://example.test/releases/1",
      externalId: "guid-1",
      author: "Ada",
      occurredAt: "2026-06-30T09:00:00.000Z",
      excerpt: "Important changes shipped today.",
      metadata: { feed_type: "rss" },
    });
  });

  it("parses Atom entries with alternate links and author names", () => {
    const items = parseFeed(
      `<?xml version="1.0"?>
       <feed>
         <entry>
           <id>tag:example.test,2026:item-1</id>
           <title>Atom update</title>
           <link rel="alternate" href="https://example.test/atom/1" />
           <published>2026-06-30T10:15:00Z</published>
           <updated>2026-06-30T10:20:00Z</updated>
           <author><name>Grace</name></author>
           <summary>Short atom summary.</summary>
         </entry>
       </feed>`,
      "atom",
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Atom update",
      url: "https://example.test/atom/1",
      externalId: "tag:example.test,2026:item-1",
      author: "Grace",
      occurredAt: "2026-06-30T10:15:00.000Z",
      excerpt: "Short atom summary.",
      metadata: {
        feed_type: "atom",
        updated_at: "2026-06-30T10:20:00.000Z",
      },
    });
  });

  it("prefers RSS PDF enclosures over alternate article links", () => {
    const items = parseFeed(
      `<?xml version="1.0"?>
       <rss version="2.0">
         <channel>
           <item>
             <title>Paper</title>
             <link>https://example.test/abs/1</link>
             <enclosure url="https://example.test/pdf/1.pdf" type="application/pdf" />
             <guid>paper-1</guid>
           </item>
         </channel>
       </rss>`,
      "rss",
    );

    expect(items[0]?.url).toBe("https://example.test/pdf/1.pdf");
  });

  it("prefers Atom PDF enclosures over alternate article links", () => {
    const items = parseFeed(
      `<?xml version="1.0"?>
       <feed>
         <entry>
           <id>paper-1</id>
           <title>Paper</title>
           <link rel="alternate" href="https://example.test/abs/1" />
           <link rel="enclosure" type="application/pdf" href="https://example.test/pdf/1.pdf" />
         </entry>
       </feed>`,
      "atom",
    );

    expect(items[0]?.url).toBe("https://example.test/pdf/1.pdf");
  });
});

describe("source scan schedule", () => {
  it("computes next checks for manual, hourly, daily, and weekly frequencies", () => {
    const completedAt = "2026-06-30T12:00:00.000Z";

    expect(computeNextCheckAt("manual", completedAt)).toBeNull();
    expect(computeNextCheckAt("hourly", completedAt)).toBe("2026-06-30T13:00:00.000Z");
    expect(computeNextCheckAt("daily", completedAt)).toBe("2026-07-01T12:00:00.000Z");
    expect(computeNextCheckAt("weekly", completedAt)).toBe("2026-07-07T12:00:00.000Z");
  });

  it("preserves a future scheduled check when a manual scan runs", () => {
    expect(computeNextCheckAt("daily", "2026-06-30T12:00:00.000Z", {
      manualRun: true,
      existingNextCheckAt: "2026-07-03T12:00:00.000Z",
    })).toBe("2026-07-03T12:00:00.000Z");
  });

  it("uses schedule rules instead of completion-time intervals when present", () => {
    expect(computeNextCheckAt("daily", "2026-06-30T12:34:00.000Z", {
      scheduleRule: { frequency: "daily", hour: 9, minute: 15 },
    })).toBe("2026-07-01T09:15:00.000Z");
    expect(computeNextCheckAt("weekly", "2026-06-30T12:34:00.000Z", {
      scheduleRule: { frequency: "weekly", weekday: 5, hour: 18, minute: 45 },
    })).toBe("2026-07-03T18:45:00.000Z");
  });
});
