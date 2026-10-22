# Fixture Sites

Small static Sites for Seam 2: `factory review` runs against each one with a real
headless browser. Every fixture carries exactly one known defect, named by its
folder, and must fail exactly the Review check that catches it. `clean` carries
none and must Pass every Review check.

Each fixture has at least two routes linked from its home page, so a test can
tell that every route is checked and not just the one it was given. A new
fixture starts as a copy of `clean` with one thing broken.

`small-layout-shift` is not a defect: its banner shifts the page by about 0.05,
inside the layout shift budget of 0.1, and it must Pass. It shows that CLS is
held to 0.1 rather than zero. `slow-lcp` pads its hero picture to about 700 KB,
so Lighthouse's slow phone sees it appear well after the LCP budget of 2.5 s.

Every fixture is visible the way the Visibility checks want: a `sitemap.xml`
named in `robots.txt`, and on every page a canonical URL to its own address plus
the Open Graph title, description and image. They name the live Site as
`https://www.example.com`, which is fine: the checks compare paths, because a
review runs on a Preview or localhost while the tags name the live Site. The
fixture server redirects a folder's `index.html` and a folder without its
trailing slash, as a well-set-up static host does, so `duplicate-url` is the only
fixture with a page at two URLs (its `about/index.html` copies `about.html`).

The fixture server also sends the security headers a well-set-up host sends
(a Content-Security-Policy and `X-Content-Type-Options: nosniff`) with every
answer. A fixture changes them with a `headers.json` of its own, where `null`
leaves a header out: `missing-csp` is served without its Content-Security-Policy, and with
`X-Frame-Options` in place of the policy's `frame-ancestors`, so the policy is all it lacks.

The Code & security checks that read the Site's repository (its own tests and
its dependency advisories) take a Site repository from `../repos`, not a fixture
Site: `clean` passes, `red-tests` has a test command that fails,
`vulnerable-dependency` locks a version the fake npm registry has an advisory
for, `no-lockfile` has no lockfile at all, and `pnpm-lockfile` and
`bun-lockfile` lock their dependencies in `pnpm-lock.yaml` and `bun.lock`
instead. The advisories check reports a Site locked by any package manager other
than npm (pnpm, Yarn, Bun, Deno) as not run, and fails only a Site with no
lockfile.
