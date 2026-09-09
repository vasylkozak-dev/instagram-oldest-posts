# Instagram Oldest Posts

Small browser-console scripts for loading a public Instagram profile timeline, finding the oldest available posts, and exporting the results to CSV.

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
