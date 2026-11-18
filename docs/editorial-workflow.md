# Editorial workflow: shopping guides

**Status: RECOMMENDED, not built.** Guides need real prices to cite. "Best smartphones under ₹20,000" with mock data would be fabricated content.

**Evergreen guides that need no live prices** could be written first, by a person:

- how genuine discounts work;
- how bank offers affect checkout price;
- how to read price history.

## Design

| Concern          | Rule                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage          | `Article` (slug, title, summary, body Markdown, author, status, `publishedAt`, `reviewedAt`, `updatedAt`) + `ArticleRevision` (append-only)                             |
| Workflow         | `DRAFT` → `IN_REVIEW` → `PUBLISHED` (→ `ARCHIVED`). Only an ADMIN can publish; the publisher is recorded; every transition is audit-logged                              |
| AI               | An editor may use AI for drafting, but **nothing is auto-published.** A human reviewer is recorded on every published article                                           |
| Prices in guides | **Never typed into the article.** Embedded as a live block referencing a product; it renders the current offer **with source and observed time**, or "no current offer" |
| Recommendations  | Labelled "Editor's picks" and visually distinct from objective rankings; affiliate status doesn't influence picks, and the page says so                                 |
| SEO              | `Article` structured data with author and dates; canonical `/guides/[slug]`; internal links to category and product pages; indexable only when published and reviewed   |
| Rendering        | Markdown rendered server-side with a strict allow-list (no raw HTML), consistent with the CSP                                                                           |

## Before building

Decide who writes and reviews (a named person, or no guides), and have the first three evergreen guides drafted. The tooling is the smaller part.
