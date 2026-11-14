import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown";

const html = (src: string) => renderToStaticMarkup(<Markdown source={src} />);

describe("Markdown", () => {
  it("renders common constructs", () => {
    const out = html("## Title\n\n- [x] done\n- item with `code`\n\n```\nlet a = 1;\n```\n\n**bold** [link](https://example.com)");
    expect(out).toContain('class="md-h md-h2"');
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("<code>code</code>");
    expect(out).toContain('<pre class="md-code">let a = 1;</pre>');
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain('href="https://example.com"');
  });

  it("never emits raw HTML or script-capable links", () => {
    const out = html('<img src=x onerror="alert(1)"><script>alert(2)</script> [x](javascript:alert(3)) <!-- hidden -->');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("hidden");
    expect(out).toContain("&lt;script&gt;");
  });
});
