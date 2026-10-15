# Pisos and ImmoScout mail regression tests

Run with Node.js: `node --test tests/pisos-mail.test.cjs tests/diagnostics.test.cjs`.

Fixtures come from the HTML bodies of Gmail messages
`1a133c1c7fd31731` (daily, 10 individual listings plus a promoted development)
and `1a13437fd8c3f700` (instant, one price reduction).
Personalized href query strings and the notification tracking pixel were removed.
The table/anchor/image structure and actual thumbnail URLs are preserved.

Tests verify every listing/photo pair, general-link and layout-image exclusion,
blacklist download prevention, stored-file reuse, download failures and queue
statuses. Google services and downloads are mocked; tests never deploy, modify
the live spreadsheet or write to Gmail/Drive.

Multi-listing emails remain in retry even when individual photo links are known:
the existing AI queue processes one listing per email. Files include listing_id
and listing_url only when their source URL belongs to exactly one listing.

ImmoScout fixtures come from Gmail messages `1a1344e0f79ea479` (one listing,
one photo) and `1a12727237a1b36c` (welcome email with ten listings, eight photos
and two placeholders). Personalized href queries and tracking pixels were
removed; the original table/anchor/photo structure is retained.

ImmoScout tracked links and direct Exposé links map to
`immoscout:<Exposé-ID>`. Canonical URLs use
`https://www.immobilienscout24.de/expose/<Exposé-ID>`.
Only linked `pictures.immobilienscout24.de/listings/` photos are imported.
`usercontent/` agency logos and static placeholder images are excluded.
This imports photos present in the email, without fetching Exposé galleries.

Milanuncios fixture `1a13b58f7993b3f6` retains the original card, image and
tracking-link structure. Opaque tracking tokens are replaced with stable test
tokens; the opening pixel and recipient name are removed. The actual photo
redirect was verified as HTTP 302 to listing 619803957. Tests resolve the photo
anchor with a mock and verify that all unrelated tracking links remain unvisited.

See `docs/diagnostics.md` for console output, the Diagnose tab, the read-only
audit function and the GitHub JUnit test artifact.
