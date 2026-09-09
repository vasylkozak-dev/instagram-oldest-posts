# Instagram Oldest Posts

Instagram Oldest Posts is a browser-based OSINT tool for collecting the full available post history of an Instagram profile and exporting it to CSV. Prototype was built by @vasilkozak-dev

It is especially useful for large profiles with thousands of posts, where manually scrolling back through years of content is slow and impractical. The tool retrieves posts through Instagram's timeline pagination, collects the available publication history, and sorts it by date. This makes it possible to quickly access very old posts as well as analyze the profile's complete available timeline.

## Usage

1. Log in to Instagram and open the profile you want to inspect.
2. Open Chrome DevTools -> Console.
3. Paste and run `capture.js`.
4. Scroll the profile until the console prints:

   `IG XHR CAPTURED`

5. Paste and run `collect.js`.
6. Wait until the console prints:

   `END`

   and then:

   `TOTAL ...`

7. The oldest posts will be shown first in the console table.
8. To export all collected posts, paste and run `export-csv.js`.

The downloaded file will be named:

`instagram_posts.csv`

## Output

The CSV contains:

- `date`
- `time`
- `code`
- `url`

## Notes

- Keep the Instagram tab open while the collector is running.
- The scripts use the authenticated request already made by your browser. Do not share copied request headers, cookies, CSRF tokens, or other session data.
- Instagram can change its internal API at any time, so the scripts may need updates in the future.
- If Instagram returns HTTP `403` or `429`, stop and retry later.
