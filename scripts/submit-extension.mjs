#!/usr/bin/env node
// Store submission scaffold (#136).
//
// Builds a `dist/store-submission/` directory that contains the
// extension zip + the privacy-policy stub + the manifest-for-review
// summary required by Chrome Web Store / Edge Add-ons review processes.
//
// Live upload is gated on `STORE_DEVELOPER_TOKEN`. Without the token,
// the script prints the bundle plan and exits successfully so the
// gate can include it.

import { mkdir, writeFile, copyFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function summarise(manifest) {
  return {
    name: manifest.name,
    version: manifest.version,
    manifest_version: manifest.manifest_version,
    permissions: manifest.permissions ?? [],
    host_permissions: manifest.host_permissions ?? [],
    externally_connectable: manifest.externally_connectable ?? null,
    content_security_policy: manifest.content_security_policy ?? null,
    background: manifest.background ?? null,
    action: manifest.action ?? null,
  };
}

async function main() {
  const versionArg = process.argv.find((arg) => arg.startsWith("--version="));
  const version = versionArg ? versionArg.slice("--version=".length) : process.env.npm_package_version;
  if (!version) throw new Error("missing version (pass --version=... or run via npm)");
  const bundlePath = path.join(repoRoot, "dist", "extension", `orchords-web-pilot-${version}.zip`);
  if (!(await exists(bundlePath))) {
    throw new Error(`bundle missing: ${bundlePath}; run scripts/package-extension.mjs --write first`);
  }
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "extension", "manifest.json"), "utf8"));

  const outDir = path.join(repoRoot, "dist", "store-submission", version);
  await mkdir(outDir, { recursive: true });
  await copyFile(bundlePath, path.join(outDir, `orchords-web-pilot-${version}.zip`));
  await writeFile(path.join(outDir, "manifest-for-review.json"), JSON.stringify(summarise(manifest), null, 2));

  const privacyPolicy = `# Orchords Web Pilot — Privacy Policy\n\nThis extension communicates only with the local native companion you install (com.orchords.web_pilot). The extension never sends browsing data to a remote server, never reads cookies, and never records your browsing history.\n\n## Data we process locally\n\n- Pairing credential used to authenticate the local native companion.\n- Per-site authorization grants you explicitly approve.\n- A bounded audit log of in-product state transitions.\n\n## Data we never access\n\n- Cookies, history, bookmarks, downloads, form autofill.\n- Page content beyond the user-granted origin.\n- Any third-party remote endpoint.\n\nFor the source code, see https://github.com/ORCHORDS/OrchordsBrowserPilot.\n`;
  await writeFile(path.join(outDir, "privacy-policy.md"), privacyPolicy);

  const review = {
    product: "Orchords Web Pilot",
    version,
    storeListing: {
      shortDescription: "Connect Chrome or Edge to the local Orchords Web Pilot companion.",
      longDescription: "Orchords Web Pilot is a permission-minimal MV3 extension that bridges your browser to a local companion core. It never reads cookies, never logs browsing history, and only talks to a single native host you install locally.",
      category: "Developer Tools",
      website: "https://github.com/ORCHORDS/OrchordsBrowserPilot",
      supportEmail: "support@orchords.com",
    },
    permissionsJustification: (manifest.permissions ?? []).map((p) => ({
      permission: p,
      reason: reasonFor(p),
    })),
    uploadReady: Boolean(process.env.STORE_DEVELOPER_TOKEN),
  };
  await writeFile(path.join(outDir, "store-listing.json"), JSON.stringify(review, null, 2));

  process.stdout.write(`store submission prepared at ${path.relative(repoRoot, outDir)}\n`);
  if (!process.env.STORE_DEVELOPER_TOKEN) {
    process.stdout.write("note: STORE_DEVELOPER_TOKEN not present; live upload skipped (dry-run only)\n");
  }
}

function reasonFor(permission) {
  switch (permission) {
    case "activeTab":
      return "User-gesture one-time tab access for the active tab only.";
    case "nativeMessaging":
      return "Required to talk to the local companion (com.orchords.web_pilot).";
    case "storage":
      return "Persistent, restart-safe storage for the pairing credential, the audit log, and the per-site authorization registry.";
    case "alarms":
      return "Used by the MV3 service worker to schedule heartbeat and reconnect timers.";
    default:
      return "Required by the MV3 service worker. Justification recorded in the privileged-API inventory at docs/security/extension-privileged-apis.md.";
  }
}

main().catch((error) => {
  process.stderr.write(`submit-extension failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
