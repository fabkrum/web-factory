import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, posix } from "node:path";
import { fileURLToPath } from "node:url";

/** The Builder's opt-in to send web-vitals field data to Google Analytics 4, chosen at Kickoff. */
export interface Ga4Choice {
  /** The GA4 web stream's measurement ID, such as G-AB12CD34EF. */
  measurementId: string;
  /** The folder of the repository the Site serves as it is, at its root: `public` for most stacks, `.` for plain HTML. */
  publicDir: string;
}

/** Where the files go inside the public folder, and the address every page loads the reporter from. */
const FOLDER = "web-vitals";
export const GA4_SCRIPT_ADDRESS = `/${FOLDER}/ga4.js`;

/** Where in localStorage the reporter keeps the Visitor's consent, so it lasts beyond one page. */
const CONSENT_KEY = "web-factory:analytics-consent";

/** Whether the text is a GA4 measurement ID: a web stream's ID starts with G-. */
export function isMeasurementId(value: string): boolean {
  return /^G-[A-Z0-9]{4,}$/.test(value);
}

/** Whether the path names a folder inside the repository, written plainly. */
export function isPublicDir(value: string): boolean {
  if (!/^[\w.\-/]+$/.test(value) || isAbsolute(value)) return false;
  const normal = normalize(value);
  return normal !== ".." && !normal.startsWith("../");
}

/** The repository paths the opt-in writes, for the commit. */
export function ga4Paths({ publicDir }: Ga4Choice): string[] {
  return ["web-vitals.js", "ga4.js", "LICENSE"].map((file) => posix.join(publicDir, FOLDER, file));
}

/** The Stack section's line about field data: every later session keeps the reporter on every page. */
export function ga4StackLine({ measurementId, publicDir }: Ga4Choice, consentRequired: boolean): string {
  const load = `- Field data: web-vitals from Visitors' browsers go to Google Analytics 4 (\`${measurementId}\`) through \`${GA4_SCRIPT_ADDRESS}\`, written to \`${publicDir}\` at Kickoff. Every page loads it with \`<script type="module" src="${GA4_SCRIPT_ADDRESS}"></script>\`, and a Content-Security-Policy lets it reach https://www.googletagmanager.com and https://*.google-analytics.com.`;
  if (!consentRequired) return load;
  return `${load} With the German Locale pack on it sends nothing before consent: the Site's consent banner calls \`grantAnalyticsConsent()\` when the Visitor agrees, a link in the privacy policy calls \`withdrawAnalyticsConsent()\`, and the privacy policy names Google Analytics.`;
}

/** What Kickoff tells the Builder about the opt-in. */
export function ga4Summary({ measurementId }: Ga4Choice, consentRequired: boolean): string {
  const sent = `Web-vitals from your Visitors' browsers go to Google Analytics 4 (${measurementId}).`;
  return consentRequired
    ? `${sent} Because the German Locale pack is on, nothing is sent until a Visitor agrees in your Site's consent banner.`
    : `${sent} They are sent from the first page a Visitor opens.`;
}

/**
 * Writes the reporter into the Site's public folder: the web-vitals library as
 * it is published, with its licence, and a small script that sends each
 * metric to GA4. With consent required, Google's script is loaded only once
 * the Visitor has agreed, so no request leaves their browser before that.
 */
export async function writeGa4Reporter(siteDir: string, choice: Ga4Choice, consentRequired: boolean): Promise<void> {
  const folder = join(siteDir, choice.publicDir, FOLDER);
  await mkdir(folder, { recursive: true });
  const library = fileURLToPath(import.meta.resolve("web-vitals"));
  const version = (JSON.parse(await readFile(join(dirname(library), "..", "package.json"), "utf8")) as { version: string }).version;
  const header = `/* web-vitals ${version} by Google LLC, https://github.com/GoogleChrome/web-vitals, under the Apache License 2.0 in LICENSE next to this file. Copied unchanged by web-factory. */\n`;
  await writeFile(join(folder, "web-vitals.js"), header + (await readFile(library, "utf8")).replace(/\n\/\/# sourceMappingURL=.*\n?$/, "\n"));
  await copyFile(join(dirname(library), "..", "LICENSE"), join(folder, "LICENSE"));
  await writeFile(join(folder, "ga4.js"), reporter(choice.measurementId, consentRequired));
}

function reporter(measurementId: string, consentRequired: boolean): string {
  return `// Sends this Site's web-vitals to Google Analytics 4. Written by \`factory kickoff\`;
// every page loads it with <script type="module" src="${GA4_SCRIPT_ADDRESS}"></script>.
${
  consentRequired
    ? `// The German Locale pack is on, so nothing is sent before the Visitor's consent:
// the metrics wait in the page, and Google's script is loaded only once the
// consent banner calls grantAnalyticsConsent(), on this page or an earlier one.`
    : "// No consent is asked for: Google's script loads with the page."
}
import { onCLS, onFCP, onINP, onLCP, onTTFB } from "./web-vitals.js";

const MEASUREMENT_ID = ${JSON.stringify(measurementId)};
const CONSENT_REQUIRED = ${consentRequired};
const CONSENT_KEY = ${JSON.stringify(CONSENT_KEY)};

window.dataLayer = window.dataLayer || [];
function gtag() {
  window.dataLayer.push(arguments);
}
gtag("js", new Date());
gtag("config", MEASUREMENT_ID);

let loaded = false;
function loadGoogle() {
  if (loaded) return;
  loaded = true;
  const script = document.createElement("script");
  script.async = true;
  script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(MEASUREMENT_ID);
  document.head.append(script);
}

function consented() {
  try {
    return localStorage.getItem(CONSENT_KEY) === "granted";
  } catch {
    return false;
  }
}

/** The consent banner calls this when the Visitor agrees. */
window.grantAnalyticsConsent = () => {
  try {
    localStorage.setItem(CONSENT_KEY, "granted");
  } catch {
    // Without storage the consent holds for this page only.
  }
  loadGoogle();
};

/** Takes consent back: nothing is sent from the next page on, and Google's cookies are removed. */
window.withdrawAnalyticsConsent = () => {
  try {
    localStorage.removeItem(CONSENT_KEY);
  } catch {
    // Nothing was stored.
  }
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0].trim();
    if (!name.startsWith("_ga")) continue;
    const domains = ["", location.hostname, "." + location.hostname.replace(/^www\\./, "")];
    for (const domain of domains) {
      document.cookie = name + "=; Max-Age=0; path=/" + (domain ? "; domain=" + domain : "");
    }
  }
};

function send({ name, value, delta, id, rating }) {
  gtag("event", name, {
    value: Math.round(name === "CLS" ? delta * 1000 : delta),
    metric_id: id,
    metric_value: value,
    metric_delta: delta,
    metric_rating: rating,
    non_interaction: true,
  });
}

for (const measure of [onCLS, onFCP, onINP, onLCP, onTTFB]) measure(send);

if (!CONSENT_REQUIRED || consented()) loadGoogle();
`;
}
