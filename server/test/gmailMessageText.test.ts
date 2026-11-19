import { describe, expect, it } from "vitest";
import {
  decodeEntities, gmailWebUrl, headerValue, htmlToMailText, internalDateIso, normalizeMessageBody, snippetText, truncateUtf8,
} from "../src/modules/sources/gmail/gmailMessageText.js";

const b64 = (text: string, encoding: BufferEncoding = "utf8") => Buffer.from(text, encoding).toString("base64url");
const part = (mimeType: string, data: string | null, extra: Record<string, unknown> = {}) => ({
  mimeType, filename: "", headers: [{ name: "Content-Type", value: `${mimeType}; charset=utf-8` }], body: data === null ? { size: 0 } : { data, size: data.length }, ...extra,
});

describe("Gmail message text normalization", () => {
  it("counts a multipart attachment once and never reads the text parts inside it", () => {
    const forwarded = (extra: Record<string, unknown>) => ({
      mimeType: "multipart/mixed", headers: [], body: { size: 0 }, ...extra,
      parts: [part("text/plain", b64("INSIDE-ATTACHMENT")), part("text/html", b64("<p>INSIDE-ATTACHMENT</p>"))],
    });
    for (const attachment of [
      forwarded({ filename: "forwarded.eml" }),
      forwarded({ filename: "", headers: [{ name: "Content-Disposition", value: "attachment; filename=x.eml" }] }),
      { ...part("text/plain", b64("INSIDE-ATTACHMENT")), filename: "notes.txt" },
    ]) {
      const body = normalizeMessageBody({ mimeType: "multipart/mixed", parts: [part("text/plain", b64("Outer text")), attachment] });
      expect(body).toEqual({ text: "Outer text", text_format: "plain", text_truncated: false, attachment_count: 1 });
    }
    // Inside an alternative, a multipart attachment is neither chosen as the rendering nor walked.
    const alt = normalizeMessageBody({ mimeType: "multipart/alternative", parts: [forwarded({ filename: "a.eml" }), part("text/html", b64("<p>Shown</p>"))] });
    expect(alt).toEqual({ text: "Shown", text_format: "html_converted", text_truncated: false, attachment_count: 1 });
  });

  it("prefers text/plain inside multipart/alternative and does not show the HTML rendering twice", () => {
    const body = normalizeMessageBody({
      mimeType: "multipart/alternative",
      parts: [part("text/plain", b64("Hello plain\r\nsecond line")), part("text/html", b64("<p>Hello <b>html</b></p>"))],
    });
    expect(body).toEqual({ text: "Hello plain\nsecond line", text_format: "plain", text_truncated: false, attachment_count: 0 });
  });

  it("reduces HTML-only mail to text: no script, style, markup, images or links; block breaks kept", () => {
    const html = `<html><head><title>T</title><style>p{color:red}</style></head><body><p>Dear&nbsp;applicant,</p>
      <div>Your <a href="https://track.example/x">interview</a> is &amp; confirmed &#x1F600;</div><img src="https://remote.example/pixel.gif">
      <script>alert(1)</script><br>Regards</body></html>`;
    const body = normalizeMessageBody({ mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }], body: { data: b64(html) } });
    expect(body.text_format).toBe("html_converted");
    expect(body.text).toBe("Dear applicant,\nYour interview is & confirmed 😀\n\nRegards");
    for (const banned of ["<", "http", "alert", "color:red", "pixel"]) expect(body.text).not.toContain(banned);
    expect(htmlToMailText("<p>a</p><p>b</p>")).toBe("a\nb");
  });

  it("counts attachments without decoding them, including ones only reachable by attachment id", () => {
    const body = normalizeMessageBody({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "multipart/alternative", parts: [part("text/plain", b64("Body")), part("text/html", b64("<p>Body</p>"))] },
        { mimeType: "application/pdf", filename: "offer.pdf", headers: [], body: { attachmentId: "ANGjdJ", size: 99999 } },
        { mimeType: "image/png", filename: "", headers: [{ name: "Content-Disposition", value: "attachment; filename=x.png" }], body: { data: b64("PNG") } },
        { mimeType: "image/jpeg", headers: [], body: { attachmentId: "ANGjdK", size: 10 } },
      ],
    });
    expect(body).toMatchObject({ text: "Body", text_format: "plain", attachment_count: 3, text_truncated: false });
  });

  it("decodes declared charsets and marks a text part held behind an attachment id as incomplete", () => {
    const latin = normalizeMessageBody({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=\"ISO-8859-1\"" }], body: { data: b64("Gr\xfc\xdfe", "latin1") } });
    expect(latin.text).toBe("Grüße");
    const gbk = normalizeMessageBody({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=gbk" }], body: { data: Buffer.from([0xc4, 0xe3, 0xba, 0xc3]).toString("base64url") } });
    expect(gbk.text).toBe("你好");
    const unknown = normalizeMessageBody({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=x-nonsense" }], body: { data: b64("fallback") } });
    expect(unknown.text).toBe("fallback");
    const held = normalizeMessageBody({ mimeType: "multipart/mixed", parts: [part("text/plain", b64("Visible")), { mimeType: "text/plain", headers: [], body: { attachmentId: "big", size: 5_000_000 } }] });
    expect(held).toMatchObject({ text: "Visible", text_truncated: true });
    expect(normalizeMessageBody(null)).toEqual({ text: "", text_format: "none", text_truncated: false, attachment_count: 0 });
  });

  it("bounds text to the per-message byte limit on a code point boundary and strips control characters", () => {
    const body = normalizeMessageBody({ mimeType: "text/plain", body: { data: b64(`\u0007a${"é".repeat(10)}`) } }, 9);
    expect(body.text).toBe("aéééé");
    expect(body.text_truncated).toBe(true);
    expect(truncateUtf8("😀😀", 5)).toEqual({ text: "😀", truncated: true });
  });

  it("normalizes headers, dates, snippets and Gmail links", () => {
    const headers = [{ name: "subject", value: "Offer\r\n  letter\u0000" }, { name: "From", value: "HR <hr@uni.example>" }];
    expect(headerValue(headers, "Subject")).toBe("Offer letter");
    expect(headerValue(headers, "To")).toBeNull();
    expect(headerValue("x", "Subject")).toBeNull();
    expect(headerValue([{ name: "Subject", value: "x".repeat(5000) }], "Subject")).toHaveLength(1000);
    expect(internalDateIso("1763290000000")).toBe(new Date(1763290000000).toISOString());
    expect(internalDateIso("not a date")).toBeNull();
    expect(snippetText("We&#39;re &lt;happy&gt; &amp; ready")).toBe("We're <happy> & ready");
    expect(decodeEntities("&bogus; &#0; &#xD800;")).toBe("&bogus; &#0; &#xD800;");
    expect(gmailWebUrl("a+b@gmail.example", "18c0ffee")).toBe("https://mail.google.com/mail/u/?authuser=a%2Bb%40gmail.example#all/18c0ffee");
  });
});
