# Fixture Sites

Small static Sites for Seam 2: `factory review` runs against each one with a real
headless browser. Every fixture carries exactly one known defect, named by its
folder, and must fail exactly the Review check that catches it. `clean` carries
none and must Pass every Review check.

Each fixture has at least two routes linked from its home page, so a test can
tell that every route is checked and not just the one it was given. A new
fixture starts as a copy of `clean` with one thing broken.
