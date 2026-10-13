import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "a", "b", "i", "strong", "em", "strike", "u",
  "code", "pre", "hr", "br",
  "ul", "ol", "li", "blockquote",
  "img",
  "table", "thead", "tbody", "tr", "th", "td",
  "div", "span", "section", "article",
];

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions["allowedAttributes"] = {
  a: ["href", "name", "target", "rel", "title"],
  img: ["src", "alt", "title", "width", "height"],
  table: ["width", "cellpadding", "cellspacing", "border"],
  th: ["align", "valign", "colspan", "rowspan", "width"],
  td: ["align", "valign", "colspan", "rowspan", "width"],
  "*": ["class", "style", "id"],
};

/**
 * Sanitizes rich newsletter HTML content using a strict security allowlist.
 * Removes malicious script tags, iframes, eval handlers (onclick, onload), and unsafe URL schemes.
 */
export function sanitizeNewsletterHtml(dirtyHtml: string): string {
  if (!dirtyHtml) return "";

  return sanitizeHtml(dirtyHtml, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      a: (tagName, attribs) => {
        // Enforce safe external link behavior
        if (attribs.href && (attribs.href.startsWith("http://") || attribs.href.startsWith("https://"))) {
          return {
            tagName: "a",
            attribs: {
              ...attribs,
              target: "_blank",
              rel: "noopener noreferrer",
            },
          };
        }
        return { tagName, attribs };
      },
    },
  });
}

/**
 * Escapes dynamic text before interpolating into HTML
 */
export function escapeHtml(unsafeText: string): string {
  if (!unsafeText) return "";
  return unsafeText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
