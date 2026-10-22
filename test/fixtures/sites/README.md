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
